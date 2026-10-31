import tls, { type TLSSocket } from 'node:tls'
import { randomBytes } from 'node:crypto'
import { SecureConnection, HANDSHAKE_TIMEOUT_MS } from './secure-connection'
import {
  computeServerProof,
  generateNonce,
  generateSessionToken,
  verifyClientAuth,
  type EphemeralCert
} from './crypto-cert'
import { NetMsgType, type FocusState, type HostStudentStatus } from '@shared/protocol-schema'

interface StudentRecord {
  studentId: string
  studentName: string
  sessionToken: string
  sessionKey: Buffer
  online: boolean
  focusState: FocusState | null
  currentQuestionIndex: number | null
  lastSeenAtMs: number | null
  exporter: Buffer | null
  reconnectToken: string
}

interface PendingHandshake {
  clientNonce: Buffer | null
  serverNonce: Buffer | null
}

export interface ExamTlsServerOptions {
  cert: EphemeralCert
  /** PBKDF2 คีย์จาก Room PIN + roomId */
  pinKey: Buffer
  roomId: string
  /** จุดหมดเวลาของข้อสอบเชิง ms (0 = ยังไม่กำหนด) */
  examEndsAtMs?: number
  maxStudents?: number
  maxConnectionsPerIp?: number
  onStudentsChanged: (students: HostStudentStatus[]) => void
  onStudentJoined?: (studentId: string, studentName: string) => void
  /** เรียกเมื่อ handshake/RESUME สำเร็จ — CoreSessionManager ใช้ส่ง STATE_RECOVERY */
  onStudentEstablished?: (studentId: string) => void
  /** Phase 3c: binary frame จากนักเรียน (thumbnail / ring segment data) */
  onStudentBinary?: (studentId: string, subType: number, payload: Buffer) => void
  onAnomaly?: (source: string | null, reason: string) => void
}

export const TLS_EXPORTER_LABEL = 'EXPORTER-ZT-EXAM-V1'

export type ExamMessageHandler = (
  studentId: string,
  connection: SecureConnection,
  type: string,
  payload: unknown
) => void

/**
 * TLS 1.3 Server ของเครื่องแม่:
 * - Ephemeral self-signed cert ต่อห้อง (บังคับ TLS 1.3 เท่านั้น)
 * - Handshake ยืนยัน PIN คู่กับ cert fingerprint ก่อนปล่อย session
 * - จัดการ session token ต่อนักเรียน (รองรับ reconnect ด้วย RESUME_REQUEST)
 * - เก็บ TLS exporter material ต่อนักเรียน (ใช้ผูก attestation ใน Phase 4)
 */
export class ExamTlsServer {
  private server: tls.Server | null = null
  private port = 0
  private students = new Map<string, StudentRecord>()
  private pending = new Map<SecureConnection, PendingHandshake>()
  private liveConnections = new Map<string, SecureConnection[]>()
  private connectionTimestamps = new Map<string, number[]>()
  private offlineCheckTimer: NodeJS.Timeout | null = null
  private examMessageHandler: ExamMessageHandler | null = null
  private currentExamEndsAtMs: number | null = null

  constructor(private readonly opts: ExamTlsServerOptions) {}

  get listeningPort(): number {
    return this.port
  }

  get studentCount(): number {
    return this.students.size
  }

  async listen(preferredPort = 0): Promise<number> {
    const server = tls.createServer(
      {
        key: this.opts.cert.keyPem,
        cert: this.opts.cert.certPem,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        handshakeTimeout: 5000
      },
      (socket) => this.handleSocket(socket)
    )
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(preferredPort, '0.0.0.0', () => resolve())
    })
    this.port = (server.address() as { port: number }).port
    this.offlineCheckTimer = setInterval(() => this.checkOfflineStudents(), 1000)
    return this.port
  }

  getStudentExporter(studentId: string): Buffer | null {
    return this.students.get(studentId)?.exporter ?? null
  }

  /** session key ต่อนักเรียน (GuardEngine ฝั่ง host ใช้เซ็นนโยบายตรวจจับ) */
  getStudentSessionKey(studentId: string): Buffer | null {
    return this.students.get(studentId)?.sessionKey ?? null
  }

  /** IP ต้นทางจริงของหน้าเชื่อมต่อ TLS ล่าสุดที่ยังอยู่ (ใช้ยืนยันจุดปลายทางของ UDP screen transport) */
  getStudentAddress(studentId: string): string | null {
    const connections = this.liveConnections.get(studentId)
    const target = connections?.find((c) => !c.isDestroyed)
    return target?.remoteAddress ?? null
  }

  /** CoreSessionManager สั่งตั้งเวลาหมดสอบ (Host-authoritative) */
  setExamEndsAtMs(endsAtMs: number): void {
    this.currentExamEndsAtMs = endsAtMs
    this.opts.examEndsAtMs = endsAtMs
  }

  getExamEndsAtMs(): number | null {
    return this.currentExamEndsAtMs ?? this.opts.examEndsAtMs ?? null
  }

  /** ลงทะบียน handler ของ CoreSessionManager — ข้อความ exam จะถูกส่งเข้า Core '@main/host' อัตโนมัติ */
  attachExamMessageHandler(handler: ExamMessageHandler): void {
    this.examMessageHandler = handler
  }

  /** ส่งข้อความแบบ typed ให้นักเรียน 1 คน (ผ่าน connection ที่ถืออยู่) */
  sendToStudent(studentId: string, type: string, payload: unknown): void {
    const connections = this.liveConnections.get(studentId)
    const target = connections?.find((c) => !c.isDestroyed)
    if (target) target.send(type, payload)
  }

  getStudents(): HostStudentStatus[] {
    return [...this.students.values()].map((s) => ({
      studentId: s.studentId,
      studentName: s.studentName,
      online: s.online,
      focusState: s.focusState,
      currentQuestionIndex: s.currentQuestionIndex,
      lastSeenAtMs: s.lastSeenAtMs
    }))
  }

  /** ปิดห้อง: แจ้งนักเรียนทุกคน (roomClosed) แล้วหยุดรับการเชื่อมต่อ */
  async stop(): Promise<void> {
    if (this.offlineCheckTimer) clearInterval(this.offlineCheckTimer)
    this.offlineCheckTimer = null
    for (const connections of this.pending.keys()) {
      connections.send(NetMsgType.roomClosed, {})
      connections.destroy()
    }
    this.pending.clear()
    for (const connections of this.liveConnections.values()) {
      for (const connection of connections) {
        connection.send(NetMsgType.roomClosed, {})
        connection.destroy()
      }
    }
    this.liveConnections.clear()
    await new Promise<void>((resolve) => {
      const server = this.server
      if (!server) return resolve()
      server.close(() => resolve())
    })
    this.server = null
  }

  private handleSocket(socket: TLSSocket): void {
    const ip = socket.remoteAddress ?? 'unknown'
    if (!this.allowConnectionFrom(ip)) {
      this.opts.onAnomaly?.(ip, 'RATE_LIMITED')
      socket.destroy()
      return
    }
    const connection = new SecureConnection(socket)
    const pending: PendingHandshake = { clientNonce: null, serverNonce: null }
    this.pending.set(connection, pending)

    let handshakeTimer = this.armHandshakeTimeout(connection)
    connection.on('message', ({ type, payload }) => {
      clearTimeout(handshakeTimer)
      this.handleHandshakeMessage(connection, pending, type, payload)
      if (this.pending.has(connection)) {
        handshakeTimer = this.armHandshakeTimeout(connection)
      }
    })
    connection.on('anomaly', (reason: string) => {
      this.opts.onAnomaly?.(ip, reason)
    })
    connection.on('closed', () => {
      clearTimeout(handshakeTimer)
      this.pending.delete(connection)
    })
  }

  private armHandshakeTimeout(connection: SecureConnection): NodeJS.Timeout {
    return setTimeout(() => {
      if (this.pending.has(connection)) {
        this.opts.onAnomaly?.(connection.remoteAddress ?? null, 'HANDSHAKE_TIMEOUT')
        connection.destroy()
      }
    }, HANDSHAKE_TIMEOUT_MS)
  }

  private handleHandshakeMessage(
    connection: SecureConnection,
    pending: PendingHandshake,
    type: string,
    payload: unknown
  ): void {
    switch (type) {
      case NetMsgType.clientHello: {
        const { clientNonce } = payload as { clientNonce: string }
        const clientNonceBuf = Buffer.from(clientNonce, 'base64')
        const serverNonce = generateNonce()
        pending.clientNonce = clientNonceBuf
        pending.serverNonce = serverNonce
        const proof = computeServerProof(
          this.opts.pinKey,
          this.opts.cert.certFingerprint,
          clientNonceBuf,
          serverNonce
        )
        connection.send(NetMsgType.serverProof, {
          serverNonce: serverNonce.toString('base64'),
          hmacProof: proof.toString('base64')
        })
        return
      }

      case NetMsgType.joinRequest: {
        const req = payload as {
          studentId: string
          studentName: string
          clientAuthHmac: string
          reconnectToken?: string
        }
        const { clientNonce, serverNonce } = pending
        if (!clientNonce || !serverNonce) {
          connection.destroy()
          return
        }
        const authOk = verifyClientAuth(
          this.opts.pinKey,
          this.opts.cert.certFingerprint,
          serverNonce,
          clientNonce,
          req.studentId,
          Buffer.from(req.clientAuthHmac, 'base64')
        )
        if (!authOk) {
          this.rejectJoin(connection, 'bad-auth')
          return
        }
        const existing = this.students.get(req.studentId)
        if (existing) {
          // ตรวจโทเคนของช่องเดิมก่อนรับ join
          if (!req.reconnectToken || req.reconnectToken !== existing.reconnectToken) {
            this.rejectJoin(connection, 'duplicate-id')
            return
          }
          // ปิดท่อเก่าก่อนรับท่อใหม่
          for (const old of this.liveConnections.get(existing.studentId) ?? []) {
            try {
              old.destroy()
            } catch {
              // ปิดไปแล้ว
            }
          }
          this.liveConnections.delete(existing.studentId)
          existing.online = false
        }
        if (!existing && this.students.size >= (this.opts.maxStudents ?? 60)) {
          this.rejectJoin(connection, 'room-full')
          return
        }
        this.finishJoin(connection, req)
        return
      }

      case NetMsgType.resumeRequest: {
        const req = payload as { sessionToken: string }
        const record = [...this.students.values()].find(
          (s) => s.sessionToken === req.sessionToken
        )
        if (!record) {
          this.rejectJoin(connection, 'unknown-message')
          return
        }
        record.online = true
        record.lastSeenAtMs = Date.now()
        connection.send(NetMsgType.joinAccepted, {
          sessionToken: record.sessionToken,
          dynamicSessionKey: record.sessionKey.toString('base64'),
          serverTimeMs: Date.now(),
          remainingExamSeconds: this.remainingSeconds(),
          studentCount: this.students.size,
          reconnectToken: record.reconnectToken
        })
        connection.setSessionKey(record.sessionKey)
        this.pending.delete(connection)
        this.attachEstablished(connection, record)
        this.notifyStudentsChanged()
        return
      }

      default:
        this.rejectJoin(connection, 'unknown-message')
    }
  }

  private finishJoin(
    connection: SecureConnection,
    req: { studentId: string; studentName: string; reconnectToken?: string }
  ): void {
    const sessionToken = generateSessionToken()
    const sessionKey = randomBytes(32)
    const exporter = connection.exportKeyingMaterial(32, TLS_EXPORTER_LABEL)
    const reconnectToken = req.reconnectToken ?? generateSessionToken()
    const record: StudentRecord = {
      studentId: req.studentId,
      studentName: req.studentName,
      sessionToken,
      sessionKey,
      online: true,
      focusState: null,
      currentQuestionIndex: null,
      lastSeenAtMs: Date.now(),
      exporter,
      reconnectToken
    }
    this.students.set(req.studentId, record)
    // ส่ง JOIN_ACCEPTED ก่อนตั้ง session key ฝั่ง server:
    // client ยังไม่รู้คีย์ตอนรับข้อความนี้ (ได้รับคีย์จาก payload ตัวมันเอง)
    // จึงต้องไม่มี HMAC — ข้อความทุกตัวหลังจากนี้ค่อยเซ็น HMAC
    connection.send(NetMsgType.joinAccepted, {
      sessionToken,
      dynamicSessionKey: sessionKey.toString('base64'),
      serverTimeMs: Date.now(),
      remainingExamSeconds: this.remainingSeconds(),
      studentCount: this.students.size,
      reconnectToken
    })
    connection.setSessionKey(sessionKey)
    this.pending.delete(connection)
    this.attachEstablished(connection, record)
    this.opts.onStudentJoined?.(req.studentId, req.studentName)
    this.notifyStudentsChanged()
  }

  /** หลัง established — ปลด handshake handler แล้วฟังข้อความที่มี HMAC ประจำ session */
  private attachEstablished(connection: SecureConnection, record: StudentRecord): void {
    // ลบ handler ของช่วง handshake ออก (ไม่งั้น heartbeat จะถูกตีความเป็น unknown-message)
    connection.removeAllListeners('message')
    const liveList = this.liveConnections.get(record.studentId) ?? []
    liveList.push(connection)
    this.liveConnections.set(record.studentId, liveList)

    connection.on('message', ({ type, payload }) => {
      record.lastSeenAtMs = Date.now()
      // Phase 1: heartbeat / roomClosed ถูกจัดการตรงนี้
      // Phase 2: ข้อความ exam (SUBMIT_ANSWER / AUTOSAVE_DRAFT / ฯลฯ) ส่งเข้า CoreSessionManager
      if (this.examMessageHandler && type !== NetMsgType.heartbeatPing) {
        this.examMessageHandler(record.studentId, connection, type, payload)
        return
      }
      if (type !== NetMsgType.heartbeatPing) {
        // Phase 1 ยังไม่มีข้อความอื่นหลัง established — บันทึกเป็น anomaly
        this.opts.onAnomaly?.(record.studentId, `POST_ESTABLISH_${type}`)
        return
      }
      const ping = payload as { focusState: FocusState; currentQuestionIndex: number | null }
      record.focusState = ping.focusState
      record.currentQuestionIndex = ping.currentQuestionIndex
      connection.send(NetMsgType.heartbeatPong, {
        serverTimeMs: Date.now(),
        remainingExamSeconds: this.remainingSeconds()
      })
      this.notifyStudentsChanged()
    })
    connection.on('binary', ({ subType, payload }: { subType: number; payload: Buffer }) => {
      record.lastSeenAtMs = Date.now()
      this.opts.onStudentBinary?.(record.studentId, subType, payload)
    })
    connection.on('closed', () => {
      const list = this.liveConnections.get(record.studentId) ?? []
      const remaining = list.filter((c) => c !== connection)
      if (remaining.length === 0) {
        this.liveConnections.delete(record.studentId)
        record.online = false
        this.notifyStudentsChanged()
      } else {
        this.liveConnections.set(record.studentId, remaining)
      }
    })
    // แจ้ง CoreSessionManager ทุกครั้งที่ session นักเรียนพร้อม (finish join / reconnect)
    this.opts.onStudentEstablished?.(record.studentId)
  }

  private checkOfflineStudents(): void {
    const now = Date.now()
    let changed = false
    for (const record of this.students.values()) {
      if (record.online && record.lastSeenAtMs !== null && now - record.lastSeenAtMs > 8000) {
        record.online = false
        changed = true
      }
    }
    if (changed) this.notifyStudentsChanged()
  }

  private rejectJoin(connection: SecureConnection, reason: string): void {
    connection.send(NetMsgType.joinRejected, { reason })
    connection.destroy()
  }

  private notifyStudentsChanged(): void {
    this.opts.onStudentsChanged(this.getStudents())
  }

  private remainingSeconds(): number {
    const endsAt = this.currentExamEndsAtMs ?? this.opts.examEndsAtMs ?? 0
    if (endsAt <= 0) return 0
    return Math.max(0, Math.floor((endsAt - Date.now()) / 1000))
  }

  private allowConnectionFrom(ip: string): boolean {
    const windowMs = 10_000
    const limit = this.opts.maxConnectionsPerIp ?? 5
    const now = Date.now()
    const timestamps = (this.connectionTimestamps.get(ip) ?? []).filter(
      (t) => now - t < windowMs
    )
    timestamps.push(now)
    this.connectionTimestamps.set(ip, timestamps)
    return timestamps.length <= limit
  }
}

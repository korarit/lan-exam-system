import tls, { type TLSSocket } from 'node:tls'
import { SecureConnection, HANDSHAKE_TIMEOUT_MS } from './secure-connection'
import {
  computeClientAuth,
  derivePinKey,
  generateNonce
} from './crypto-cert'
import { verifyHmacTimingSafe } from '../crypto/primitives'
import { TLS_EXPORTER_LABEL } from './tls-server'
import {
  HeartbeatMonitor,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  nextReconnectDelayMs
} from './heartbeat'
import {
  NetMsgType,
  type FocusState,
  type StudentConnectionState,
  type StudentConnectionStatus
} from '@shared/protocol-schema'

export interface ConnectOptions {
  host: string
  port: number
  roomId: string
  roomPin: string
  studentId: string
  studentName: string
  focusState?: FocusState
  currentQuestionIndex?: number | null
  reconnectToken?: string
}

export interface JoinResult {
  sessionToken: string
  dynamicSessionKey: Buffer
  tlsExporter: Buffer | null
  serverTimeMs: number
  remainingExamSeconds: number
  studentCount: number
  reconnectToken: string
}

export class JoinRejectedError extends Error {
  constructor(public readonly reason: string) {
    super(`JOIN_REJECTED:${reason}`)
  }
}

export class HandshakeProofError extends Error {
  constructor() {
    super('SERVER_PROOF_MISMATCH (Room PIN ผิด หรือเครื่องแม่ถูกปลอมแทน — MITM)')
  }
}

export interface ExamTlsClientOptions {
  onConnectionState: (status: StudentConnectionStatus) => void
  onMessage?: (type: string, payload: unknown) => void
  /** Phase 3c: binary frame จากเครื่องแม่ (segment ที่ขอ) */
  onBinary?: (subType: number, payload: Buffer) => void
  /** โหลดโทเคนเชื่อมต่อกลับที่เก็บไว้ (ไม่บังคับ) */
  getReconnectToken?: (roomId: string, studentId: string) => string | null
  /** เก็บโทเคนเชื่อมต่อกลับหลัง join สำเร็จ (ไม่บังคับ) */
  onReconnectToken?: (roomId: string, studentId: string, token: string) => void
}

/**
 * TLS 1.3 Client ของเครื่องนักเรียน:
 * - ตรวจ SERVER_PROOF ด้วย Room PIN + peer cert fingerprint ก่อนส่งข้อมูลใด ๆ
 * - หลัง JOIN_ACCEPTED: ทุกข้อความเซ็น HMAC ด้วย dynamicSessionKey
 * - Fail-closed: ไม่ได้ยินเครื่องแม่ > 8s → FROZEN แล้ว reconnect แบบ backoff อัตโนมัติ
 */
export class ExamTlsClient {
  private stopped = false
  private connection: SecureConnection | null = null
  private monitor: HeartbeatMonitor | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private tlsExporter: Buffer | null = null
  private focusState: FocusState = 'focused'
  private currentQuestionIndex: number | null = null
  private reconnectAttempt = 0
  private connectOptions: ConnectOptions | null = null
  private sessionToken: string | null = null
  private dynamicSessionKey: Buffer | null = null
  private reconnectToken: string | null = null

  constructor(private readonly opts: ExamTlsClientOptions) {}

  get exporter(): Buffer | null {
    return this.tlsExporter
  }

  get currentSessionToken(): string | null {
    return this.sessionToken
  }

  /** คีย์ HMAC ต่อ session (GuardEngine ใช้ตรวจลายเซ็นนโยบายจากเครื่องแม่) */
  getSessionKey(): Buffer | null {
    return this.dynamicSessionKey
  }

  /** เวลาปัจจุบันของเครื่องแม่จาก HEARTBEAT_PONG ล่าสุด (Host-authoritative time) */
  get serverTimeMs(): number {
    return this.lastServerTimeMs
  }

  /** เวลาที่เหลือของข้อสอบจากเครื่องแม่ (0 = ยังไม่เริ่ม) */
  get remainingExamSeconds(): number {
    return this.lastRemainingSeconds
  }

  /** อัปเดตสถานะย่อที่แนบไปกับ heartbeat ถัดไป */
  setExamUiState(focusState: FocusState, currentQuestionIndex: number | null): void {
    this.focusState = focusState
    this.currentQuestionIndex = currentQuestionIndex
  }

  /** ส่งข้อความ exam ของ renderer (SUBMIT_ANSWER / AUTOSAVE_DRAFT / ฯลฯ) ผ่าน HMAC envelope — false = ส่งไม่ได้ */
  sendExamMessage(type: string, payload: unknown): boolean {
    if (this.stopped) return false
    const connection = this.connection
    if (!connection || connection.isDestroyed) return false
    return connection.send(type, payload)
  }

  /** Phase 3c: ส่ง binary frame ไปเครื่องแม่ (thumbnail / ฯลฯ) */
  sendBinary(subType: number, payload: Buffer): void {
    const connection = this.connection
    if (connection && !connection.isDestroyed) connection.sendBinary(subType, payload)
  }

  async connect(options: ConnectOptions): Promise<JoinResult> {
    this.teardown()
    this.stopped = false
    const stored =
      options.reconnectToken ??
      this.opts.getReconnectToken?.(options.roomId, options.studentId) ??
      undefined
    const nextOptions: ConnectOptions = stored ? { ...options, reconnectToken: stored } : options
    this.connectOptions = nextOptions
    this.reconnectToken = stored ?? null
    this.reconnectAttempt = 0
    this.setState('connecting')
    const result = await this.connectOnce(nextOptions)
    this.sessionToken = result.sessionToken
    return result
  }

  /** ล้างสถานะการเชื่อมต่อเดิม (ก่อน join ใหม่หรือ stop) */
  private teardown(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.monitor?.stop()
    this.monitor = null
    if (this.connection) {
      const conn = this.connection
      this.connection = null
      conn.destroy()
    }
  }

  /** หยุดทุกอย่างและปิดการเชื่อมต่อ (เรียกเมื่อออกจากห้อง/ปิดแอป) */
  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.monitor?.stop()
    this.monitor = null
    this.connection?.destroy()
    this.connection = null
    this.setState('closed')
  }

  /** บังคับตัดสายทันที (เช่น roomClosed จากเครื่องแม่) */
  abort(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.monitor?.stop()
    this.monitor = null
    this.connection?.destroy()
    this.connection = null
  }

  private setState(state: StudentConnectionState, reason?: string, sessionToken?: string): void {
    const status: StudentConnectionStatus = { state }
    if (reason !== undefined) status.reason = reason
    if (sessionToken !== undefined) status.sessionToken = sessionToken
    this.opts.onConnectionState(status)
  }

  private async connectOnce(options: ConnectOptions): Promise<JoinResult> {
    const pinKey = derivePinKey(options.roomPin, options.roomId)
    const clientNonce = generateNonce()

    const connection = await this.openTlsSocket(options)
    this.connection = connection

    // ดึง fingerprint จาก TLS socket จริง + exporter material
    const peerCertFingerprint = connection.getPeerCertificateFingerprint()
    const tlsExporter = connection.exportKeyingMaterial(32, TLS_EXPORTER_LABEL)

    // 3. CLIENT_HELLO
    connection.send(NetMsgType.clientHello, {
      protocolVersion: 1,
      clientNonce: clientNonce.toString('base64')
    })

    // 4. SERVER_PROOF → ตรวจด้วย PIN ที่นักเรียนกรอก
    const proof = await this.waitForMessage(connection, NetMsgType.serverProof)
    const proofPayload = proof.payload as { serverNonce: string; hmacProof: string }
    const serverNonce = Buffer.from(proofPayload.serverNonce, 'base64')
    const proofOk = verifyHmacTimingSafe(
      pinKey,
      Buffer.concat([
        Buffer.from(peerCertFingerprint, 'utf8'),
        clientNonce,
        serverNonce
      ]),
      Buffer.from(proofPayload.hmacProof, 'base64')
    )
    if (!proofOk) {
      connection.destroy()
      this.setState('rejected', 'bad-proof (Room PIN ผิด หรือเครื่องแม่ถูกปลอมแทน)', undefined)
      throw new HandshakeProofError()
    }

    // 5. JOIN_REQUEST (+ client auth HMAC)
    const clientAuth = computeClientAuth(
      pinKey,
      peerCertFingerprint,
      serverNonce,
      clientNonce,
      options.studentId
    )
    connection.send(NetMsgType.joinRequest, {
      studentId: options.studentId,
      studentName: options.studentName,
      clientAuthHmac: clientAuth.toString('base64'),
      ...(options.reconnectToken ? { reconnectToken: options.reconnectToken } : {})
    })

    // 6. JOIN_ACCEPTED / JOIN_REJECTED
    const response = await this.waitForAnyMessage(connection, [
      NetMsgType.joinAccepted,
      NetMsgType.joinRejected
    ])
    if (response.type === NetMsgType.joinRejected) {
      const reason = (response.payload as { reason: string }).reason
      connection.destroy()
      this.setState('rejected', reason, undefined)
      throw new JoinRejectedError(reason)
    }
    const accepted = response.payload as {
      sessionToken: string
      dynamicSessionKey: string
      serverTimeMs: number
      remainingExamSeconds: number
      studentCount: number
      reconnectToken?: string
    }
    const dynamicSessionKey = Buffer.from(accepted.dynamicSessionKey, 'base64')
    connection.setSessionKey(dynamicSessionKey)
    this.dynamicSessionKey = dynamicSessionKey
    if (accepted.reconnectToken) {
      this.reconnectToken = accepted.reconnectToken
      if (this.connectOptions) {
        this.connectOptions = { ...this.connectOptions, reconnectToken: accepted.reconnectToken }
      }
      this.opts.onReconnectToken?.(options.roomId, options.studentId, accepted.reconnectToken)
    }

    const result: JoinResult = {
      sessionToken: accepted.sessionToken,
      dynamicSessionKey,
      tlsExporter,
      serverTimeMs: accepted.serverTimeMs,
      remainingExamSeconds: accepted.remainingExamSeconds,
      studentCount: accepted.studentCount,
      reconnectToken: accepted.reconnectToken ?? this.reconnectToken ?? ''
    }
    this.tlsExporter = tlsExporter
    this.sessionToken = accepted.sessionToken
    this.startHeartbeat(connection)
    this.setState('ready', undefined, accepted.sessionToken)
    return result
  }

  private openTlsSocket(options: ConnectOptions): Promise<SecureConnection> {
    return new Promise((resolve, reject) => {
      const socket: TLSSocket = tls.connect(
        {
          host: options.host,
          port: options.port,
          minVersion: 'TLSv1.3',
          maxVersion: 'TLSv1.3',
          rejectUnauthorized: false // Ephemeral self-signed — ยืนยันจริงผ่าน PIN + fingerprint
        },
        () => {
          const connection = new SecureConnection(socket)
          this.wireEstablishedHandlers(connection)
          resolve(connection)
        }
      )
      socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
        socket.destroy()
        reject(new Error('TLS_HANDSHAKE_TIMEOUT'))
      })
      socket.on('error', (err) => {
        reject(err)
      })
    })
  }

  /** รอข้อความ type เดียว (handshake serial flow) */
  private waitForMessage(connection: SecureConnection, type: string): Promise<{ type: string; payload: unknown }> {
    return this.waitForAnyMessage(connection, [type])
  }

  private waitForAnyMessage(
    connection: SecureConnection,
    types: string[]
  ): Promise<{ type: string; payload: unknown }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`HANDSHAKE_TIMEOUT_WAITING_${types.join('_')}`))
      }, HANDSHAKE_TIMEOUT_MS)
      const onMessage = (message: { type: string; payload: unknown }): void => {
        if (!types.includes(message.type)) return // เพิกเฉยข้อความอื่นชั่วคราว
        cleanup()
        resolve(message)
      }
      const onClosed = (): void => {
        cleanup()
        reject(new Error('CONNECTION_CLOSED_DURING_HANDSHAKE'))
      }
      function cleanup(): void {
        clearTimeout(timer)
        connection.off('message', onMessage)
        connection.off('closed', onClosed)
      }
      connection.on('message', onMessage)
      connection.on('closed', onClosed)
    })
  }

  private wireEstablishedHandlers(connection: SecureConnection): void {
    connection.on('binary', ({ subType, payload }: { subType: number; payload: Buffer }) => {
      this.monitor?.recordActivity()
      this.opts.onBinary?.(subType, payload)
    })
    connection.on('message', ({ type, payload }) => {
      this.monitor?.recordActivity()
      if (type === NetMsgType.heartbeatPong) {
        const pong = payload as { serverTimeMs: number; remainingExamSeconds: number }
        this.lastServerTimeMs = pong.serverTimeMs
        this.lastRemainingSeconds = pong.remainingExamSeconds
        this.opts.onMessage?.(type, payload)
        return
      }
      if (type === NetMsgType.roomClosed) {
        this.abort()
        this.setState('closed', 'room-closed')
        return
      }
      this.opts.onMessage?.(type, payload)
    })
    connection.on('anomaly', (reason: string) => {
      this.opts.onMessage?.('anomaly', reason)
    })
    connection.on('closed', () => {
      if (this.stopped || this.sessionToken === null) {
        // ยังไม่เคย join สำเร็จ (handshake ล้มเหลว) — ไม่เข้าโหมด fail-closed
        return
      }
      this.monitor?.stop()
      this.monitor = null
      this.enterFailClosed('CONNECTION_LOST')
    })
  }

  private lastServerTimeMs = 0
  private lastRemainingSeconds = 0

  private startHeartbeat(connection: SecureConnection): void {
    this.monitor?.stop()
    const monitor = new HeartbeatMonitor({
      intervalMs: HEARTBEAT_INTERVAL_MS,
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
      sendPing: () => {
        connection.send(NetMsgType.heartbeatPing, {
          focusState: this.focusState,
          currentQuestionIndex: this.currentQuestionIndex
        })
      },
      onTimeout: () => {
        connection.destroy()
        this.enterFailClosed('HEARTBEAT_TIMEOUT')
      }
    })
    monitor.start()
    this.monitor = monitor
  }

  /** fail-closed: freeze แล้วลอง reconnect ด้วย backoff */
  private enterFailClosed(reason: string): void {
    this.setState('frozen', reason, this.sessionToken ?? undefined)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.connectOptions) return
    const attempt = ++this.reconnectAttempt
    const delay = nextReconnectDelayMs(attempt)
    this.setState('reconnecting', `attempt=${attempt}`, this.sessionToken ?? undefined)
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped || !this.connectOptions) return
      this.connectOnce(this.connectOptions)
        .then((result) => {
          this.reconnectAttempt = 0
          this.sessionToken = result.sessionToken
        })
        .catch((err: unknown) => {
          // ตอน reconnect ถ้า PIN/proof ไม่ผ่าน = หยุดพยายาม (อย่ายิงซ้ำ)
          if (
            err instanceof HandshakeProofError ||
            err instanceof JoinRejectedError
          ) {
            return
          }
          this.scheduleReconnect()
        })
    }, delay)
  }
}

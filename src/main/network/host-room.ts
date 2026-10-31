import { EventEmitter } from 'node:events'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  generateEphemeralCert,
  derivePinKey,
  generateRoomPin,
  type EphemeralCert
} from './crypto-cert'
import { RoomBroadcaster, type RoomBroadcasterOptions } from './discovery'
import { ExamTlsServer } from './tls-server'
import type { HostDatabase } from '../storage/db'
import type {
  DiscoveredRoom,
  HostStudentStatus,
  UdpBeacon
} from '@shared/protocol-schema'

export interface HostRoomConfig {
  roomName: string
  mode: 'closed' | 'in-app-docs' | 'external-tools'
  enforcement: 'report-only' | 'block-and-report'
  /** จำนวนนักเรียนสูงสุดของห้องนี้ (ไม่ระบุ = ใช้ค่าของ manager หรือ 60) */
  maxStudents?: number
  hostName?: string
}

export interface HostRoomInfo {
  roomId: string
  roomName: string
  roomPin: string
  tcpPort: number
  certFingerprint: string
  certFpShort: string
  mode: 'closed' | 'in-app-docs' | 'external-tools'
}

export interface HostRoomManagerOptions {
  db: HostDatabase
  hostName?: string
  maxStudents?: number
  /** roster ของห้อง (undefined = ไม่บังคับ, [] = deny-all) */
  roster?: readonly string[]
  /** จำนวน reconnect สูงสุดต่อคน (0 = ไม่จำกัด) */
  maxReconnectsPerStudent?: number
  /** ตรวจจับนักเรียนต่างคนที่ต่อจาก IP เดียวกัน (default true) */
  detectDuplicateClientIp?: boolean
  /** แจ้งเมื่อพบนักเรียน 2 คน online จาก IP เดียวกัน (เครื่องเดียวกัน) */
  onDuplicateClientIp?: (studentId: string, existingStudentId: string, ip: string) => void
  onStudentsChanged: (students: HostStudentStatus[]) => void
  onRoomClosed?: () => void
  onAnomaly?: (source: string | null, reason: string) => void
  /** เรียกเมื่อ handshake/RESUME ของนักเรียนสำเร็จ (CoreSessionManager ใช้กู้คืนสถานะ) */
  onStudentEstablished?: (studentId: string) => void
  /** Phase 3c: binary frame จากนักเรียน (thumbnail / segment data) */
  onStudentBinary?: (studentId: string, subType: number, payload: Buffer) => void
}

/**
 * ตัวจัดการห้องสอบฝั่งเครื่องแม่:
 * สร้าง Ephemeral cert + PIN → เปิด TLS 1.3 server → กระจาย UDP beacon
 * และบันทึก exam_sessions ลง SQLite
 */
export class HostRoomManager extends EventEmitter {
  private roomInfo: HostRoomInfo | null = null
  private tlsServer: ExamTlsServer | null = null
  private broadcaster: RoomBroadcaster | null = null
  private beacon: UdpBeacon | null = null

  constructor(private readonly opts: HostRoomManagerOptions) {
    super()
  }

  get room(): HostRoomInfo | null {
    return this.roomInfo
  }

  /** โหมดการสอบของห้องปัจจุบัน (null = ยังไม่เปิดห้อง) */
  get examMode(): 'closed' | 'in-app-docs' | 'external-tools' | null {
    return this.beacon?.examMode ?? null
  }

  /** สถานะการสอบของห้อง (lobby / in-progress / ended) — Doc Preview ใช้กันเปิดตอนสอบรัน */
  get examStatus(): UdpBeacon['examStatus'] | null {
    return this.beacon?.examStatus ?? null
  }

  get students(): HostStudentStatus[] {
    return this.tlsServer?.getStudents() ?? []
  }

  /** CoreSessionManager ต้องการคุมคำสั่งส่ง/ตั้งเวลาผ่าน TLS server โดยตรง */
  get tlsServerInstance(): ExamTlsServer | null {
    return this.tlsServer
  }

  /** อัปเดตสถานะใน beacon (lobby / in-progress / ended) */
  setExamStatus(status: UdpBeacon['examStatus']): void {
    if (this.beacon) this.beacon.examStatus = status
  }

  async createRoom(config: HostRoomConfig): Promise<HostRoomInfo> {
    if (this.roomInfo) {
      throw new Error('ROOM_ALREADY_OPEN')
    }
    const roomId = randomUUID()
    const cert: EphemeralCert = await generateEphemeralCert()
    const roomPin = generateRoomPin()
    const pinKey = derivePinKey(roomPin, roomId)

    const maxStudents = config.maxStudents ?? this.opts.maxStudents ?? 60
    const tlsServer = new ExamTlsServer({
      cert,
      pinKey,
      roomId,
      maxStudents,
      ...(this.opts.roster !== undefined ? { roster: this.opts.roster } : {}),
      ...(this.opts.maxReconnectsPerStudent !== undefined
        ? { maxReconnectsPerStudent: this.opts.maxReconnectsPerStudent }
        : {}),
      ...(this.opts.detectDuplicateClientIp !== undefined
        ? { detectDuplicateClientIp: this.opts.detectDuplicateClientIp }
        : {}),
      ...(this.opts.onDuplicateClientIp !== undefined
        ? { onDuplicateClientIp: this.opts.onDuplicateClientIp }
        : {}),
      onStudentsChanged: (students) => {
        if (this.beacon) {
          this.beacon.studentCount = students.filter((s) => s.online).length
        }
        this.opts.onStudentsChanged(students)
      },
      onStudentJoined: (studentId, studentName) => {
        this.opts.db.db
          .prepare(
            `INSERT OR REPLACE INTO students
             (student_id, session_id, display_name, seed, status, suspicion_score, joined_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(studentId, roomId, studentName, randomUUID(), 'joined', 0, Date.now())
      },
      onAnomaly: (source, reason) => this.opts.onAnomaly?.(source, reason),
      onStudentEstablished: (studentId) => this.opts.onStudentEstablished?.(studentId),
      onStudentBinary: (studentId, subType, payload) => this.opts.onStudentBinary?.(studentId, subType, payload)
    })
    const tcpPort = await tlsServer.listen()

    const info: HostRoomInfo = {
      roomId,
      roomName: config.roomName,
      roomPin,
      tcpPort,
      certFingerprint: cert.certFingerprint,
      certFpShort: cert.certFpShort,
      mode: config.mode
    }

    const beacon: UdpBeacon = {
      magic: 'ZTEXAM_V1',
      roomId,
      roomName: config.roomName,
      hostName: config.hostName ?? osHostName(),
      examMode: config.mode,
      tcpPort,
      certFpShort: cert.certFpShort,
      studentCount: 0,
      examStatus: 'lobby',
      timestamp: Date.now()
    }
    const broadcasterOptions: RoomBroadcasterOptions = { beacon }
    const broadcaster = new RoomBroadcaster(broadcasterOptions)

    // บันทึกห้องลงฐานข้อมูลเครื่องแม่
    this.opts.db.db
      .prepare(
        `INSERT INTO exam_sessions (id, room_name, mode, enforcement, status, crypto_salt, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(roomId, config.roomName, config.mode, config.enforcement, 'lobby', cert.certFpShort, Date.now())

    this.roomInfo = info
    this.tlsServer = tlsServer
    this.beacon = beacon
    this.broadcaster = broadcaster
    broadcaster.start()
    return info
  }

  async closeRoom(): Promise<void> {
    if (!this.roomInfo) return
    this.broadcaster?.stop()
    await this.tlsServer?.stop()
    this.broadcaster = null
    this.tlsServer = null
    this.beacon = null
    const roomId = this.roomInfo.roomId
    this.roomInfo = null
    this.opts.db.db
      .prepare(`UPDATE exam_sessions SET status = 'ended', ended_at_ms = ? WHERE id = ?`)
      .run(Date.now(), roomId)
    this.opts.onRoomClosed?.()
  }
}

function osHostName(): string {
  return os.hostname().slice(0, 60)
}

/** เผื่อใช้ฝั่ง student: ตรวจว่า beacon ที่เห็นยังไม่หมดอายุ */
export function isRoomFresh(room: DiscoveredRoom, now = Date.now(), maxAgeMs = 7000): boolean {
  return now - room.lastSeenAtMs <= maxAgeMs
}

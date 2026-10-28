import {
  decodeScreenFrame,
  decodeSegmentFrame,
  ScreenUdpRegisterPayloadSchema,
  type RingSegmentMeta
} from '@shared/screen-protocol'
import { NetMsgType } from '@shared/protocol-schema'
import { deriveScreenUdpKeys, type ScreenUdpKeys } from './udp-crypto'
import type { UdpSegmentAtomHeader } from '@shared/udp-screen-protocol'
import type { HostRoomManager } from '../network/host-room'
import { UdpStreamReceiver } from './udp-stream-receiver'

/* ============================================================
 * Phase 3c: ProctorViewService (เครื่องแม่ — Pull on Demand)
 * - เก็บภาพย่อล่าสุดของนักเรียนแต่ละคนต่อจอในหน่วยความจำ
 * - คลิกดู → บันทึก Audit (PROCTOR_VIEWED_SCREEN) → ส่ง SCREEN_INSPECT_REQUEST
 * - รับ RING_SEGMENT_LIST / segment data แล้ว push ให้หน้าจอครู
 * - UDP upgrade: สตรีมวิดีโอเซกมเนต์ 720p/30fps เข้ารหัส AES-256-GCM ผ่าน Raw UDP
 *   (UdpStreamReceiver) — ลงทะเบียน channel ด้วย SCREEN_UDP_REGISTER ผ่านท่อ TLS
 * ============================================================ */

export interface ProctorViewServiceOptions {
  getRoom: () => HostRoomManager | null
  sendHostEvent: (channel: string, payload: unknown) => void
  /** บันทึกการเปิดดูหน้าจอลง Audit Log Hash Chain */
  recordScreenAudit: (
    studentId: string,
    eventCode: string,
    summaryText: string,
    evidence: Record<string, unknown>
  ) => void
}

interface StoredThumbnail {
  studentId: string
  displayIndex: number
  displayCount: number
  mode: 'thumbnail' | 'live'
  mimeType: string
  imageBase64: string
  timestampMs: number
  displayId: string
}

export interface ScreenInspectTarget {
  studentId: string
  mode: 'live' | 'playback'
  startedAtMs: number
}

export class ProctorViewService {
  /** ภาพย่อล่าสุด: `${studentId}:${displayIndex}` → frame (ไม่ลง SQLite) */
  private readonly thumbnails = new Map<string, StoredThumbnail>()
  private readonly inspecting = new Map<string, ScreenInspectTarget>() // studentId → target

  /** ช่องทาง UDP ต่อห้อง: channelIdHex → { studentId, กุญแจ HKDF } */
  private readonly udpChannels = new Map<string, { studentId: string; keys: ScreenUdpKeys }>()
  /** กุญแจ ring buffer ล่าสุดต่อ student (มาจากช่วงบันทึกเซสชัน — ใช้ derive คีย์ UDP) */
  private readonly studentUdpKeyMaterial = new Map<string, { screenBufferKey: string; udpPort: number }>()
  private udpReceiver = new UdpStreamReceiver({
    onSegment: (channelIdHex, header, webm) => this.handleUdpSegment(channelIdHex, header, webm),
    onSegmentFailed: (channelIdHex, header) => this.handleUdpSegmentFailed(channelIdHex, header),
    onAnomaly: (ip, reason) => console.warn(`[screen-udp] ${ip}: ${reason}`)
  })

  constructor(private readonly opts: ProctorViewServiceOptions) {}

  /* ---------- UDP transport ---------- */

  /** พอร์ต UDP สำหรับ SCREEN_SESSION (bind ครั้งเดียว ใช้ตลอดแอปเครื่องแม่) */
  async getUdpPortAsync(): Promise<number | null> {
    return (await this.udpReceiver.start()) ?? null
  }

  getUdpPort(): number | null {
    return this.udpReceiver.getPort()
  }

  /** ฟอร์มรับ SCREEN_UDP_REGISTER จากนักเรียน (ผ่านท่อ TLS — ยืนยัน IP ให้ตรงกัน) */
  handleUdpRegister(studentId: string, payload: unknown): void {
    const parsed = ScreenUdpRegisterPayloadSchema.safeParse(payload)
    const room = this.opts.getRoom()
    if (!parsed.success || !room?.room) {
      this.sendUdpReadyPayload(studentId, false, 'BAD_REGISTER')
      return
    }
    const remoteAddress = room.tlsServerInstance?.getStudentAddress(studentId)
    const keyMaterial = this.studentUdpKeyMaterial.get(studentId)
    if (!remoteAddress || !keyMaterial) {
      this.sendUdpReadyPayload(studentId, false, 'NO_SCREEN_SESSION')
      return
    }
    // กุญแจ UDP อนุพันธ์จาก screenBufferKey ล่าสุดที่เพิ่งส่งให้นักเรียน (SCREEN_SESSION)
    const keys = deriveScreenUdpKeys(Buffer.from(keyMaterial.screenBufferKey, 'base64'))
    const accepted = this.udpReceiver.registerChannel(parsed.data.channelId, remoteAddress, keys)
    if (!accepted) {
      this.sendUdpReadyPayload(studentId, false, 'CHANNEL_ID_IN_USE')
      return
    }
    this.udpChannels.set(parsed.data.channelId, { studentId, keys })
    this.sendUdpReadyPayload(studentId, true)
  }

  private sendUdpReadyPayload(studentId: string, ok: boolean, reason?: string): void {
    const room = this.opts.getRoom()
    room?.tlsServerInstance?.sendToStudent(studentId, NetMsgType.screenUdpReady, {
      ok,
      ...(reason !== undefined ? { reason } : {})
    })
  }

  /** บอกด้านที่ เครื่องแม่ส่ง SCREEN_SESSION พร้อมตำแหน่ง UDP (เรียกจาก CoreSessionManager) */
  noteScreenSession(studentId: string, screenBufferKey: string): void {
    const udpPort = this.udpReceiver.getPort()
    if (udpPort !== null) this.studentUdpKeyMaterial.set(studentId, { screenBufferKey, udpPort })
  }

  /** atom จากนักเรียน (ผ่าน UDP receiver) ครบแล้ว → กระจายไป UI ตาม origin */
  private handleUdpSegment(channelIdHex: string, header: UdpSegmentAtomHeader, webm: Uint8Array): void {
    const channel = this.udpChannels.get(channelIdHex)
    if (!channel) return
    const { studentId } = channel
    if (header.origin === 'fetch') {
      this.opts.sendHostEvent('host:screen-segment-data', {
        studentId,
        segmentId: header.segmentId,
        displayId: header.displayId,
        mimeType: header.mimeType,
        dataBase64: Buffer.from(webm).toString('base64')
      })
      console.warn(`[screen-udp] UDP fetch segment ready: ${header.segmentId}`)
      return
    }
    // origin 'live' — เซกเมนต์สด (DVR timeline บน Dashboard เล่นได้ทันที)
    this.opts.sendHostEvent('host:screen-live-segment', {
      studentId,
      segmentId: header.segmentId,
      displayId: header.displayId,
      mimeType: header.mimeType,
      dataBase64: Buffer.from(webm).toString('base64'),
      seqNo: header.seqNo,
      startTimeMs: header.startTimeMs,
      endTimeMs: header.endTimeMs
    })
  }

  /** atom หายถาวร → ถ้าเป็น fetch ขอย้อนไปทาง TCP อีกครั้ง (การันตีว่าได้ข้อมูลจริงเสมอ) */
  private handleUdpSegmentFailed(channelIdHex: string, header: UdpSegmentAtomHeader | null): void {
    const channel = this.udpChannels.get(channelIdHex)
    if (!channel) return
    this.requestTcpFetch(channel.studentId, header?.segmentId ?? null)
  }

  private requestTcpFetch(studentId: string, segmentId: string | null): void {
    if (!segmentId) return
    const room = this.opts.getRoom()
    if (!room?.room) return
    room.tlsServerInstance?.sendToStudent(studentId, NetMsgType.fetchRingSegment, {
      requestId: `${Date.now()}-${studentId}-tcp`,
      segmentId,
      transport: 'tcp'
    })
  }

  /* ---------- รับจากนักเรียน (binary frames) ---------- */

  /** เฟรมหน้าจอ (thumbnail/live) — เก็บล่าสุดไว้ใน RAM แล้ว push ให้ Dashboard */
  ingestScreenFrame(studentId: string, payload: Buffer): void {
    const decoded = decodeScreenFrame(new Uint8Array(payload))
    if (!decoded) return
    const stored: StoredThumbnail = {
      studentId,
      displayIndex: decoded.header.displayIndex,
      displayCount: decoded.header.displayCount,
      mode: decoded.header.mode,
      mimeType: decoded.header.mimeType,
      imageBase64: Buffer.from(decoded.image).toString('base64'),
      timestampMs: decoded.header.timestampMs,
      displayId: decoded.header.displayId
    }
    this.thumbnails.set(`${studentId}:${decoded.header.displayIndex}`, stored)
    this.opts.sendHostEvent('host:screen-thumbnail', { ...stored })
  }

  /** เนื้อหาเซกเมนต์ .webm ที่เครื่องนักเรียนถอดรหัสแล้วส่งกลับ */
  ingestSegmentData(studentId: string, payload: Buffer): void {
    const decoded = decodeSegmentFrame(new Uint8Array(payload))
    if (!decoded) return
    this.opts.sendHostEvent('host:screen-segment-data', {
      studentId,
      segmentId: decoded.meta.segmentId,
      displayId: decoded.meta.displayId,
      mimeType: decoded.meta.mimeType,
      dataBase64: Buffer.from(decoded.webm).toString('base64')
    })
  }

  /** รายการเซกเมนต์ 5 นาทีล่าสุด (จาก SCREEN_INSPECT_REQUEST โหมด playback) */
  ingestSegmentList(studentId: string, payload: unknown): void {
    const parsed = payload as { displayId: string; segments: RingSegmentMeta[] }
    this.opts.sendHostEvent('host:screen-segments', {
      studentId,
      displayId: parsed.displayId,
      segments: parsed.segments
    })
  }

  /* ---------- คำสั่งของผู้คุม (IPC จาก Dashboard) ---------- */

  getLatestThumbnail(studentId: string, displayIndex: number): StoredThumbnail | null {
    return this.thumbnails.get(`${studentId}:${displayIndex}`) ?? null
  }

  /** เริ่มดูหน้าจอสด/ย้อนหลัง — บันทึก PROCTOR_VIEWED_SCREEN ลง hash chain ทันที */
  startInspect(studentId: string, mode: 'live' | 'playback', displayId?: string): { ok: boolean; reason?: string } {
    const room = this.opts.getRoom()
    if (!room?.room) return { ok: false, reason: 'ROOM_NOT_OPEN' }
    const requestId = `${Date.now()}-${studentId}`
    const previous = this.inspecting.get(studentId)
    this.inspecting.set(studentId, { studentId, mode, startedAtMs: Date.now() })

    // Audit: ทุกการเปิดดูลง chain (ผู้ดู = HOST, เครื่องเป้าหมาย = studentId)
    if (!previous || previous.mode !== mode) {
      this.opts.recordScreenAudit(studentId, 'PROCTOR_VIEWED_SCREEN', `ผู้คุมสอบเปิดดูหน้าจอแบบ ${mode === 'live' ? 'สด' : 'ย้อนหลัง 5 นาที'}`, {
        targetStudentId: studentId,
        mode,
        ...(displayId !== undefined ? { displayId } : {})
      })
    }

    room.tlsServerInstance?.sendToStudent(studentId, NetMsgType.screenInspectRequest, {
      requestId,
      mode,
      ...(displayId !== undefined ? { displayId } : {})
    })
    return { ok: true }
  }

  stopInspect(studentId: string): void {
    const room = this.opts.getRoom()
    this.inspecting.delete(studentId)
    room?.tlsServerInstance?.sendToStudent(studentId, NetMsgType.screenInspectRequest, {
      requestId: `${Date.now()}-${studentId}`,
      mode: 'stop'
    })
  }

  isInspecting(studentId: string): ScreenInspectTarget | null {
    return this.inspecting.get(studentId) ?? null
  }

  /** ขอไฟล์เซกเมนต์หนึ่งชิ้น (คลิกบน Timeline 5 นาที) */
  fetchSegment(studentId: string, segmentId: string): { ok: boolean; reason?: string } {
    const room = this.opts.getRoom()
    if (!room?.room) return { ok: false, reason: 'ROOM_NOT_OPEN' }
    room.tlsServerInstance?.sendToStudent(studentId, NetMsgType.fetchRingSegment, {
      requestId: `${Date.now()}-${studentId}`,
      segmentId
    })
    return { ok: true }
  }

  /** Pin เองจาก Dashboard (กันหลักฐานช่วงสั้นถูกเขียนทับ) — ลง audit ด้วย */
  pinBuffer(studentId: string, reason?: string): { ok: boolean; reason?: string } {
    const room = this.opts.getRoom()
    if (!room?.room) return { ok: false, reason: 'ROOM_NOT_OPEN' }
    const eventId = reason ?? `PROCTOR_PIN-${Date.now()}`
    room.tlsServerInstance?.sendToStudent(studentId, NetMsgType.pinRingSegments, {
      eventId,
      timestampMs: Date.now(),
      ...(reason !== undefined ? { reason } : {})
    })
    this.opts.recordScreenAudit(studentId, 'PROCTOR_PINNED_RING_BUFFER', 'ผู้คุมสอบล็อกวิดีโอย้อนหลังไม่ให้ถูกเขียนทับ', {
      targetStudentId: studentId,
      eventId
    })
    return { ok: true }
  }

  /** ล้างหน่วยความจำภาพย่อ + ช่องทาง UDP (ปิดห้อง) — พอร์ตยังเปิดรับห้องถัดไป */
  clearAll(): void {
    this.thumbnails.clear()
    this.inspecting.clear()
    this.udpChannels.clear()
    this.studentUdpKeyMaterial.clear()
    this.udpReceiver.unregisterAll()
  }
}

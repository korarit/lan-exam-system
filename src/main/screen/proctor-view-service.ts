import {
  decodeScreenFrame,
  decodeSegmentFrame,
  type RingSegmentMeta
} from '@shared/screen-protocol'
import { NetMsgType } from '@shared/protocol-schema'
import type { HostRoomManager } from '../network/host-room'

/* ============================================================
 * Phase 3c: ProctorViewService (เครื่องแม่ — Pull on Demand)
 * - เก็บภาพย่อล่าสุดของนักเรียนแต่ละคนต่อจอในหน่วยความจำ
 * - คลิกดู → บันทึก Audit (PROCTOR_VIEWED_SCREEN) → ส่ง SCREEN_INSPECT_REQUEST
 * - รับ RING_SEGMENT_LIST / segment data แล้ว push ให้หน้าจอครู
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

  constructor(private readonly opts: ProctorViewServiceOptions) {}

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

  /** ล้างหน่วยความจำภาพย่อ (ปิดห้อง) */
  clearAll(): void {
    this.thumbnails.clear()
    this.inspecting.clear()
  }
}

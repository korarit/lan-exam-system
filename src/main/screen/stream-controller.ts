import { randomUUID } from 'node:crypto'
import {
  decodeSegmentFrame,
  encodeScreenFrame,
  encodeSegmentFrame,
  type RingSegmentMeta
} from '@shared/screen-protocol'
import { NetMsgType } from '@shared/protocol-schema'
import {
  ScreenInspectRequestPayloadSchema,
  FetchRingSegmentPayloadSchema,
  PinRingSegmentsPayloadSchema,
  type ScreenSessionPayload
} from '@shared/screen-protocol'
import type { ExamTlsClient } from '../network/tls-client'
import { CaptureManager, type DisplaySourceInfo } from './capture-manager'
import { EncryptedRingBuffer } from './ring-buffer'

/* ============================================================
 * Phase 3c: ScreenStreamController (เครื่องนักเรียน — Main process)
 * - รับ SCREEN_SESSION (คีย์เข้ารหัสจากเครื่องแม่ในหน่วยความจำ)
 * - รับเซกเมนต์ .webm + ภาพย่อจาก renderer ผ่าน IPC
 * - ตอบ SCREEN_INSPECT_REQUEST / FETCH_RING_SEGMENT (Pull-on-Demand)
 * - Pin-on-Critical + Zero-Trace cleanup เมื่อจบสอบ
 * ============================================================ */

export interface ScreenStreamControllerOptions {
  getClient: () => ExamTlsClient | null
  getSessionId: () => string | null
  /** ส่ง event ไป renderer นักเรียน (screen:session / screen:inspect) */
  sendRendererEvent: (channel: string, payload: unknown) => void
  onStatus?: (message: string) => void
}

/** payload ของ IPC 'student:screen-segment' (ตรวจด้วย Zod ที่ screen-handlers แล้ว) */
export interface RendererSegmentInput {
  displayId: string
  seqNo: number
  startTimeMs: number
  endTimeMs: number
  data: Uint8Array
}

/** payload ของ IPC 'student:screen-thumbnail' */
export interface RendererThumbnailInput {
  displayIndex: number
  displayCount: number
  mode: 'thumbnail' | 'live'
  mimeType: string
  timestampMs: number
  displayId: string
  data: Uint8Array
}

export class ScreenStreamController {
  private readonly captureManager = new CaptureManager()
  private ringBuffer: EncryptedRingBuffer | null = null
  private sessionKey: Buffer | null = null
  private thumbnailIntervalMs = 1000
  private readonly activeInspectRequests = new Set<string>()

  constructor(private readonly opts: ScreenStreamControllerOptions) {}

  /* ---------- เซสชัน (SCREEN_SESSION จากเครื่องแม่) ---------- */

  startSession(sessionId: string, payload: ScreenSessionPayload): void {
    // เริ่มรอบใหม่ → เก็บกวาดของเก่าก่อนเสมอ (เริ่มเซสชันใหม่)
    this.stopSession('new-session')
    const key = Buffer.from(payload.screenBufferKey, 'base64')
    if (key.length !== 32) {
      this.opts.onStatus?.('SCREEN_SESSION_BAD_KEY')
      return
    }
    this.sessionKey = key
    this.thumbnailIntervalMs = payload.thumbnailIntervalMs
    this.ringBuffer = new EncryptedRingBuffer({ sessionId, key })
    this.opts.sendRendererEvent('screen:session', {
      active: true,
      thumbnailIntervalMs: this.thumbnailIntervalMs
    })
    this.opts.onStatus?.(`ring buffer started at ${this.ringBuffer.directory}`)
  }

  /** Zero-Trace Cleanup: ลบคีย์ + ลบโฟลเดอร์ ring buffer ทั้งหมด (จบสอบ/ปิดห้อง) */
  stopSession(reason: string): void {
    this.activeInspectRequests.clear()
    this.opts.sendRendererEvent('screen:session', { active: false, reason })
    if (this.ringBuffer) {
      this.ringBuffer.destroy()
      this.ringBuffer = null
    }
    if (this.sessionKey) {
      this.sessionKey.fill(0)
      this.sessionKey = null
    }
    this.opts.onStatus?.(`screen session stopped (${reason})`)
  }

  /* ---------- ข้อความเครือข่ายจากเครื่องแม่ ---------- */

  /** คืน true เมื่อข้อความนี้ถูกจัดการโดยตัวควบคุมหน้าจอ */
  handleNetMessage(type: string, payload: unknown): boolean {
    switch (type) {
      case NetMsgType.screenInspectRequest: {
        const request = ScreenInspectRequestPayloadSchema.parse(payload)
        this.handleInspectRequest(request.requestId, request.mode, request.displayId)
        return true
      }
      case NetMsgType.fetchRingSegment: {
        const request = FetchRingSegmentPayloadSchema.parse(payload)
        this.handleFetchSegment(request.requestId, request.segmentId)
        return true
      }
      case NetMsgType.pinRingSegments: {
        const request = PinRingSegmentsPayloadSchema.parse(payload)
        this.pinAroundTimestamp(request.timestampMs, request.eventId)
        return true
      }
      default:
        return false
    }
  }

  /** รับ binary frame จากเครื่องแม่ (ไม่ใช้ ณ เวลานี้ — เผื่อ WebRTC upgrade) */
  handleBinaryFrame(subType: number, payload: Buffer): void {
    if (subType === 0x02 && decodeSegmentFrame(payload)) {
      // เครื่องนักเรียนไม่ควรได้รับ segment จากเครื่องแม่ — บันทึกสถานะไว้
      this.opts.onStatus?.('UNEXPECTED_SEGMENT_FRAME_FROM_HOST')
    }
  }

  private handleInspectRequest(requestId: string, mode: 'live' | 'playback' | 'stop', displayId?: string): void {
    if (mode === 'stop') {
      this.activeInspectRequests.clear()
      this.opts.sendRendererEvent('screen:inspect', { requestId, mode: 'stop' })
      return
    }
    if (mode === 'live') {
      // ภาพสดความละเอียดสูง: renderer เปิดโหมด live (จอที่ระบุหรือทุกจอ)
      this.opts.sendRendererEvent('screen:inspect', {
        requestId,
        mode: 'live',
        ...(displayId !== undefined ? { displayId } : {})
      })
      return
    }
    // PLAYBACK_HISTORY: ส่งรายการเซกเมนต์ 5 นาทีล่าสุดกลับไปทั้งหมดทุกจอ (หรือเฉพาะจอที่ระบุ)
    if (!this.ringBuffer) return
    this.activeInspectRequests.add(requestId)
    for (const display of this.ringBuffer.listDisplays()) {
      if (displayId !== undefined && display !== displayId) continue
      this.sendSegmentList(requestId, display)
    }
  }

  private sendSegmentList(requestId: string, displayId: string): void {
    const client = this.opts.getClient()
    const buffer = this.ringBuffer
    if (!client || !buffer) return
    const segments: RingSegmentMeta[] = buffer.listSegments(displayId).map((record) => {
      const meta: RingSegmentMeta = {
        segmentId: record.segmentId,
        displayId: record.displayId,
        seqNo: record.seqNo,
        startTimeMs: record.startTimeMs,
        endTimeMs: record.endTimeMs,
        byteLength: record.byteLength
      }
      if (record.pinnedReason !== undefined) meta.pinnedReason = record.pinnedReason
      return meta
    })
    client.sendExamMessage(NetMsgType.ringSegmentList, { requestId, displayId, segments })
  }

  private handleFetchSegment(requestId: string, segmentId: string): void {
    const client = this.opts.getClient()
    const buffer = this.ringBuffer
    if (!client || !buffer) return
    const webm = buffer.readSegment(segmentId)
    if (!webm) return
    // หา meta ของเซกเมนต์เพื่อแนบ displayId กลับไป
    let displayId = 'unknown'
    for (const display of buffer.listDisplays()) {
      if (buffer.listSegments(display).some((s) => s.segmentId === segmentId)) {
        displayId = display
        break
      }
    }
    const frame = encodeSegmentFrame(
      { requestId, segmentId, displayId, mimeType: 'video/webm' },
      new Uint8Array(webm)
    )
    client.sendBinary(0x02, Buffer.from(frame))
  }

  /* ---------- ข้อมูลจาก renderer (IPC) ---------- */

  async getSources(): Promise<{ environment: ReturnType<CaptureManager['checkEnvironment']>; sources: DisplaySourceInfo[] }> {
    const environment = this.captureManager.checkEnvironment()
    const sources = environment.ok ? await this.captureManager.enumerateDisplaySources() : []
    return { environment, sources }
  }

  /** เซกเมนต์ .webm จาก renderer → เข้ารหัส AES-256-GCM + ลง ring buffer */
  ingestSegment(input: RendererSegmentInput): boolean {
    if (!this.ringBuffer) return false
    try {
      this.ringBuffer.addSegment({
        displayId: input.displayId,
        seqNo: input.seqNo,
        startTimeMs: input.startTimeMs,
        endTimeMs: input.endTimeMs,
        plaintext: Buffer.from(input.data)
      })
      return true
    } catch (err) {
      this.opts.onStatus?.(`SEGMENT_INGEST_FAILED: ${err instanceof Error ? err.message : 'unknown'}`)
      return false
    }
  }

  /** ภาพย่อ/ภาพสด 1 เฟรมจาก renderer → binary frame ผ่าน TLS */
  ingestThumbnail(input: RendererThumbnailInput): boolean {
    const client = this.opts.getClient()
    if (!client) return false
    const frame = encodeScreenFrame(
      {
        mode: input.mode,
        displayIndex: input.displayIndex,
        displayCount: input.displayCount,
        timestampMs: input.timestampMs,
        mimeType: input.mimeType,
        displayId: input.displayId
      },
      input.data
    )
    client.sendBinary(0x01, Buffer.from(frame))
    return true
  }

  /* ---------- Pin-on-Critical ---------- */

  /** ล็อกเซกเมนต์รอบเหตุการณ์วิกฤตทุกจอ */
  pinAroundTimestamp(timestampMs: number, eventId: string, reason?: string): number {
    const buffer = this.ringBuffer
    if (!buffer) return 0
    let pinned = 0
    for (const display of buffer.listDisplays()) {
      const result = buffer.pinAroundTimestamp(display, timestampMs, reason ?? eventId)
      pinned += result.pinnedCount
    }
    return pinned
  }

  /** รหัสเหตุสุ่มสำหรับ manual pin จากผู้คุม */
  static manualPinEventId(): string {
    return `PROCTOR_PIN-${randomUUID()}`
  }
}

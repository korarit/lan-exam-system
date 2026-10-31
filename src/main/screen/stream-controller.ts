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
import { UdpAtomType, type UdpSegmentAtomHeader } from '@shared/udp-screen-protocol'
import { deriveScreenUdpKeys } from './udp-crypto'
import type { ExamTlsClient } from '../network/tls-client'
import { CaptureManager, type DisplaySourceInfo } from './capture-manager'
import { EncryptedRingBuffer } from './ring-buffer'
import { UdpStreamSender } from './udp-stream-sender'

/* ============================================================
 * Phase 3c: ScreenStreamController (เครื่องนักเรียน — Main process)
 * - รับ SCREEN_SESSION (คีย์เข้ารหัสจากเครื่องแม่ในหน่วยความจำ)
 * - รับเซกเมนต์ .webm + ภาพย่อจาก renderer ผ่าน IPC
 * - ตอบ SCREEN_INSPECT_REQUEST / FETCH_RING_SEGMENT (Pull-on-Demand)
 * - Live stream / Ring fetch วิ่งผ่าน Raw UDP + AES-256-GCM (UdpStreamSender)
 *   , Thumbnail ยังใช้ TLS (TCP) ตามปกติ — UDP ไม่พร้อม → fallback กลับ TCP
 * - Pin-on-Critical + Zero-Trace cleanup เมื่อจบสอบ
 * ============================================================ */

export interface ScreenStreamControllerOptions {
  getClient: () => ExamTlsClient | null
  getSessionId: () => string | null
  /** IP เครื่องแม่ที่ join ล่าสุด (ตำหนิปลายทางของ UDP sender) */
  getHostIp: () => string | null
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
  private thumbnailMinIntervalMs = 5_000
  private thumbnailMaxIntervalMs = 15_000
  private readonly activeInspectRequests = new Set<string>()

  /* ---------- UDP transport (live segment stream + playback fetch) ---------- */
  private sender: UdpStreamSender | null = null
  private udpActive = false
  private udpRegisterTimer: NodeJS.Timeout | null = null
  /** คำสั่งดูสดล่าสุดที่กำลังเปิดสตรีม (null = ปิด) */
  private liveStream: { requestId: string; displayId: string | null } | null = null
  /** SCREEN_UDP_READY มาถึงแล้วหรือยัง (กันส่ง datagram เขาะทาง) */
  private udpReadyReceived = false
  /** โหมด live ที่ประกาศไป renderer ครั้งล่าสุด (ส่งซ้ำเมื่อเปลี่ยนเท่านั้น) */
  private liveEmittedTransport: 'udp-segments' | 'jpeg-fallback' | null = null

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
    this.thumbnailMinIntervalMs = payload.thumbnailMinIntervalMs
    this.thumbnailMaxIntervalMs = payload.thumbnailMaxIntervalMs
    this.ringBuffer = new EncryptedRingBuffer({ sessionId, key })
    this.opts.sendRendererEvent('screen:session', {
      active: true,
      thumbnailMinIntervalMs: this.thumbnailMinIntervalMs,
      thumbnailMaxIntervalMs: this.thumbnailMaxIntervalMs
    })
    this.opts.onStatus?.(`ring buffer started at ${this.ringBuffer.directory}`)
    // ตั้งช่องทาง UDP (ถ้าเครื่องแม่ประกาศพอร์ตไว้) → SCREEN_UDP_REGISTER ผ่าน TLS
    void this.setupUdp(payload.udpScreenPort ?? null, key)
  }

  /** ตั้ง sender + ประกาศตำแหน่งขี้นเครื่องแม่ (SCREEN_UDP_REGISTER) */
  private async setupUdp(hostPort: number | null, key: Buffer): Promise<void> {
    this.teardownUdp()
    const hostIp = this.opts.getHostIp()
    if (!hostPort || !hostIp) {
      this.opts.onStatus?.('UDP transport disabled (no host udp port / host ip)')
      return
    }
    const sender = new UdpStreamSender(
      { hostAddress: hostIp, hostPort, keys: deriveScreenUdpKeys(key) },
      { onStatus: (message) => this.opts.onStatus?.(message) }
    )
    try {
      await sender.start()
    } catch (err) {
      this.opts.onStatus?.(`UDP_SETUP_FAILED: ${err instanceof Error ? err.message : 'unknown'}`)
      sender.close()
      this.sender = null
      this.emitLiveInspectEvent()
      return
    }
    this.sender = sender
    this.udpReadyReceived = false
    this.emitLiveInspectEvent()
    const client = this.opts.getClient()
    if (!client) return
    client.sendExamMessage(NetMsgType.screenUdpRegister, {
      channelId: sender.channelIdHex,
      udpPort: sender.port ?? 0,
      protoVersion: 1
    })
    // ถ้าไม่ได้รับ SCREEN_UDP_READY ภายใน 2.5 วินาที ให้ถือว่า UDP ล้มเหลว → fallback TCP
    this.udpRegisterTimer = setTimeout(() => {
      if (!this.udpReadyReceived) {
        this.udpActive = false
        this.opts.onStatus?.('UDP_REGISTER_TIMEOUT — ใช้ TCP fallback')
        this.emitLiveInspectEvent()
      }
    }, 2_500)
  }

  /** เครื่องแม่ยืนยันช่องทาง UDP (SCREEN_UDP_READY) */
  handleUdpReady(ok: boolean, reason?: string): void {
    this.udpReadyReceived = true
    if (this.udpRegisterTimer) clearTimeout(this.udpRegisterTimer)
    this.udpRegisterTimer = null
    this.udpActive = ok
    this.opts.onStatus?.(ok ? 'UDP transport ready' : `UDP transport rejected (${reason ?? 'unknown'})`)
    if (this.liveStream) this.emitLiveInspectEvent()
  }

  /** ประกาศโหมด live พร้อม transport ให้ renderer (ส่งซ้ำเมื่อ transport เปลี่ยนเท่านั้น) */
  private emitLiveInspectEvent(): void {
    if (!this.liveStream) return
    const transport: 'udp-segments' | 'jpeg-fallback' =
      this.udpActive && this.sender ? 'udp-segments' : 'jpeg-fallback'
    if (transport === this.liveEmittedTransport) return
    this.liveEmittedTransport = transport
    this.opts.sendRendererEvent('screen:inspect', {
      requestId: this.liveStream.requestId,
      mode: 'live',
      transport,
      ...(this.liveStream.displayId !== null ? { displayId: this.liveStream.displayId } : {})
    })
  }

  /** หยุดช่องทาง UDP (เริ่มเซสชันใหม่ / จบสอบ) */
  private teardownUdp(): void {
    if (this.udpRegisterTimer) clearTimeout(this.udpRegisterTimer)
    this.udpRegisterTimer = null
    this.udpActive = false
    this.udpReadyReceived = false
    this.liveStream = null
    this.sender?.close()
    this.sender = null
  }

  /** Zero-Trace Cleanup: ลบคีย์ + ลบโฟลเดอร์ ring buffer ทั้งหมด (จบสอบ/ปิดห้อง) */
  stopSession(reason: string): void {
    this.activeInspectRequests.clear()
    this.teardownUdp()
    this.liveEmittedTransport = null
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
        this.handleFetchSegment(request.requestId, request.segmentId, request.transport)
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
      this.liveStream = null
      this.liveEmittedTransport = null
      this.opts.sendRendererEvent('screen:inspect', { requestId, mode: 'stop' })
      return
    }
    if (mode === 'live') {
      // ภาพสด 720p/30fps: สตรีมวิดีโอเซกเมนต์ต่อเนื่องผ่าน UDP (ถ้าช่องทางพร้อม)
      // หาก UDP ยังไม่พร้อม จะประกาศ jpeg-fallback ก่อน แล้วปรับขึ้น UDP เมื่อ READY มาถึง
      this.liveStream = { requestId, displayId: displayId ?? null }
      this.liveEmittedTransport = null
      this.emitLiveInspectEvent()
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

  private handleFetchSegment(requestId: string, segmentId: string, transport?: 'udp' | 'tcp'): void {
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

    // ช่องทาง UDP (ค่าเริ่มต้น) — เครื่องแม่ Forced = 'tcp' หลัง atom หายบน UDP
    if (transport !== 'tcp' && this.udpActive && this.sender) {
      const data = new Uint8Array(webm)
      let startTimeMs = Date.now()
      let seqNo = 0
      for (const record of buffer.listSegments(displayId)) {
        if (record.segmentId === segmentId) {
          startTimeMs = record.startTimeMs
          seqNo = record.seqNo
          break
        }
      }
      const atomHeader: UdpSegmentAtomHeader = {
        origin: 'fetch',
        requestId,
        segmentId,
        displayId,
        mimeType: 'video/webm',
        seqNo,
        startTimeMs,
        endTimeMs: startTimeMs
      }
      const atomSeq = this.sender.sendSegmentAtom(atomHeader, data, UdpAtomType.segment)
      if (atomSeq !== null) {
        this.opts.onStatus?.(`FETCH over UDP (${data.byteLength}B, ${atomSeq})`)
        return
      }
    }

    // Fallback: TCP TLS binary frame (subType 0x02)
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

  /** เซกเมนต์ .webm จาก renderer → เข้ารหัส AES-256-GCM ลง ring buffer
   *  + สตรีมต่อเนื่องผ่าน UDP ระหว่างโหมดดูสด (Pull-on-Demand) */
  ingestSegment(input: RendererSegmentInput): boolean {
    if (!this.ringBuffer) return false
    try {
      // segmentId แบบ deterministic → meta ที่สตรีมผ่าน UDP ชี้ไปเซกเมนต์เดียวกันกับ ring buffer
      const segmentId = `ring-${input.displayId}-${input.seqNo}`
      this.ringBuffer.addSegment({
        segmentId,
        displayId: input.displayId,
        seqNo: input.seqNo,
        startTimeMs: input.startTimeMs,
        endTimeMs: input.endTimeMs,
        plaintext: Buffer.from(input.data)
      })
    } catch (err) {
      this.opts.onStatus?.(`SEGMENT_INGEST_FAILED: ${err instanceof Error ? err.message : 'unknown'}`)
      return false
    }
    this.sendLiveSegmentOverUdp(input)
    return true
  }

  /** Live stream ผ่าน UDP: เซกเมนต์ใหม่ของจอที่กำลังถูกดู → datagram (ตัด chunk + NACK retransmit) */
  private sendLiveSegmentOverUdp(input: RendererSegmentInput): void {
    const live = this.liveStream
    if (!live || !this.udpActive || !this.sender) return
    if (live.displayId !== null && live.displayId !== input.displayId) return
    const atomHeader: UdpSegmentAtomHeader = {
      origin: 'live',
      requestId: live.requestId,
      segmentId: `ring-${input.displayId}-${input.seqNo}`,
      displayId: input.displayId,
      mimeType: 'video/webm',
      seqNo: input.seqNo,
      startTimeMs: input.startTimeMs,
      endTimeMs: input.endTimeMs
    }
    this.sender.sendSegmentAtom(atomHeader, input.data, UdpAtomType.segment)
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

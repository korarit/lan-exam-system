import { z } from 'zod'

/* ============================================================
 * Phase 3c: Screen Monitoring — โปรโตคอลที่ใช้ร่วมกัน
 * - Thumbnail/Live frame และ Ring segment ส่งเป็น Binary Frame
 *   (frame type 0x02) ที่ header เป็น big-endian (DataView)
 * - ข้อความ JSON อื่น (SCREEN_SESSION, SCREEN_INSPECT_REQUEST,
 *   RING_SEGMENT_LIST, FETCH_RING_SEGMENT, PIN_RING_SEGMENTS)
 *   ใช้ท่อ Envelope + HMAC เดิม
 * ============================================================ */

/** ชนิดย่อยของ Binary Frame (payload byte แรก) */
export const ScreenBinarySubType = {
  /** ภาพย่อ/ภาพสดของแต่ละจอ (thumbnail + live ใช้เฟรมเดียวกัน ต่างที่ช่อง mode) */
  screenFrame: 0x01,
  /** เนื้อหาไฟล์ .webm ของเซกเมนต์ที่ถอดรหัสแล้ว (ตอบ FETCH_RING_SEGMENT) */
  ringSegmentData: 0x02
} as const

/** โหมดการส่งเฟรมหน้าจอ */
export const ScreenFrameModeSchema = z.enum(['thumbnail', 'live'])
export type ScreenFrameMode = z.infer<typeof ScreenFrameModeSchema>

/** โหมดของ SCREEN_INSPECT_REQUEST */
export const ScreenInspectModeSchema = z.enum(['live', 'playback', 'stop'])
export type ScreenInspectMode = z.infer<typeof ScreenInspectModeSchema>

/** ดัชนีเซกเมนต์ ring buffer (เดิมจาก plan — ใช้ส่งรายการกลับเครื่องแม่) */
export interface RingSegmentMeta {
  segmentId: string
  displayId: string
  seqNo: number
  startTimeMs: number
  endTimeMs: number
  /** เต็มเมื่อเซกเมนต์ถูกล็อกด้วยเหตุการณ์วิกฤต — จะไม่ถูกหมุนทับ */
  pinnedReason?: string | undefined
  byteLength: number
}

export const RingSegmentMetaSchema = z
  .object({
    segmentId: z.string().min(1).max(80),
    displayId: z.string().min(1).max(40),
    seqNo: z.number().int().nonnegative(),
    startTimeMs: z.number().int().nonnegative(),
    endTimeMs: z.number().int().nonnegative(),
    pinnedReason: z.string().max(80).optional(),
    byteLength: z.number().int().nonnegative()
  })
  .strict()

export const RingSegmentListPayloadSchema = z
  .object({
    requestId: z.string().min(1).max(64),
    displayId: z.string().min(1).max(40),
    segments: z.array(RingSegmentMetaSchema).max(600)
  })
  .strict()

/* ---------- Network message payload schemas (over TLS envelope) ---------- */

/** เครื่องแม่ → นักเรียน: เปิดเซสชันบันทึกหน้าจอ (ส่งคีย์เข้ารหัสผ่านหน่วยความจำ) */
export const ScreenSessionPayloadSchema = z
  .object({
    /** คีย์ AES-256 ต่อเซสชัน (base64 32 bytes) — ห้ามเขียนลงดิสก์ */
    screenBufferKey: z.string().min(1).max(64),
    /** ระยะห่างภาพย่อ ms (1000 ปกติ / 2000 เมื่อห้องเกิน 50 คน) */
    thumbnailIntervalMs: z.number().int().min(250).max(10_000)
  })
  .strict()
export type ScreenSessionPayload = z.infer<typeof ScreenSessionPayloadSchema>

/** เครื่องแม่ → นักเรียน: ขอดูหน้าจอสด / รายการย้อนหลัง / หยุดส่ง */
export const ScreenInspectRequestPayloadSchema = z
  .object({
    requestId: z.string().min(1).max(64),
    mode: ScreenInspectModeSchema,
    displayId: z.string().min(1).max(40).optional()
  })
  .strict()
export type ScreenInspectRequestPayload = z.infer<typeof ScreenInspectRequestPayloadSchema>

/** เครื่องแม่ → นักเรียน: ขอไฟล์เซกเมนต์หนึ่งชิ้น (ถอดรหัสแล้วสตรีมกลับ) */
export const FetchRingSegmentPayloadSchema = z
  .object({
    requestId: z.string().min(1).max(64),
    segmentId: z.string().min(1).max(80)
  })
  .strict()
export type FetchRingSegmentPayload = z.infer<typeof FetchRingSegmentPayloadSchema>

/** เครื่องแม่ → นักเรียน: ล็อกเซกเมนต์รอบเหตุการณ์ (Pin-on-Critical) */
export const PinRingSegmentsPayloadSchema = z
  .object({
    eventId: z.string().min(1).max(80),
    timestampMs: z.number().int().nonnegative(),
    reason: z.string().max(200).optional()
  })
  .strict()
export type PinRingSegmentsPayload = z.infer<typeof PinRingSegmentsPayloadSchema>

/* ---------- Binary frame encoding (big-endian, DataView — ใช้ได้ทั้ง Node/browser) ---------- */

/** header ของ screenFrame: [0]=subType [1]=mode [2]=displayIndex [3]=displayCount [4..12]=ts f64 [12..14]=mimeLen [14..16]=displayIdLen */
export interface ScreenFrameHeader {
  mode: ScreenFrameMode
  displayIndex: number
  displayCount: number
  timestampMs: number
  mimeType: string
  displayId: string
}

const FRAME_FIXED_HEADER = 16

export function encodeScreenFrame(header: ScreenFrameHeader, image: Uint8Array): Uint8Array {
  const mimeBytes = asciiBytes(header.mimeType.slice(0, 60))
  const displayIdBytes = asciiBytes(header.displayId.slice(0, 40))
  const total = FRAME_FIXED_HEADER + mimeBytes.length + displayIdBytes.length + image.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  out[0] = ScreenBinarySubType.screenFrame
  out[1] = header.mode === 'live' ? 1 : 0
  out[2] = header.displayIndex & 0xff
  out[3] = header.displayCount & 0xff
  view.setFloat64(4, header.timestampMs)
  view.setUint16(12, mimeBytes.length)
  view.setUint16(14, displayIdBytes.length)
  out.set(mimeBytes, FRAME_FIXED_HEADER)
  out.set(displayIdBytes, FRAME_FIXED_HEADER + mimeBytes.length)
  out.set(image, FRAME_FIXED_HEADER + mimeBytes.length + displayIdBytes.length)
  return out
}

export function decodeScreenFrame(payload: Uint8Array): { header: ScreenFrameHeader; image: Uint8Array } | null {
  if (payload.length < FRAME_FIXED_HEADER + 1) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const mimeLen = view.getUint16(12)
  const displayIdLen = view.getUint16(14)
  if (payload.length < FRAME_FIXED_HEADER + mimeLen + displayIdLen) return null
  const mimeType = asciiToString(payload.subarray(FRAME_FIXED_HEADER, FRAME_FIXED_HEADER + mimeLen))
  const displayId = asciiToString(payload.subarray(FRAME_FIXED_HEADER + mimeLen, FRAME_FIXED_HEADER + mimeLen + displayIdLen))
  const mode: ScreenFrameMode = payload[1] === 1 ? 'live' : 'thumbnail'
  return {
    header: {
      mode,
      displayIndex: payload[2] ?? 0,
      displayCount: payload[3] ?? 1,
      timestampMs: view.getFloat64(4),
      mimeType,
      displayId
    },
    image: payload.subarray(FRAME_FIXED_HEADER + mimeLen + displayIdLen)
  }
}

/** header ของ ringSegmentData: [0]=subType [1..3]=metaLen(16) [3..3+metaLen]=meta JSON */
export interface RingSegmentDataMeta {
  requestId: string
  segmentId: string
  displayId: string
  mimeType: string
}

const SEG_FIXED_HEADER = 3

export function encodeSegmentFrame(meta: RingSegmentDataMeta, webm: Uint8Array): Uint8Array {
  const metaBytes = asciiBytes(JSON.stringify(meta).slice(0, 4_000))
  const out = new Uint8Array(SEG_FIXED_HEADER + metaBytes.length + webm.length)
  const view = new DataView(out.buffer)
  out[0] = ScreenBinarySubType.ringSegmentData
  view.setUint16(1, metaBytes.length)
  out.set(metaBytes, SEG_FIXED_HEADER)
  out.set(webm, SEG_FIXED_HEADER + metaBytes.length)
  return out
}

export function decodeSegmentFrame(payload: Uint8Array): { meta: RingSegmentDataMeta; webm: Uint8Array } | null {
  if (payload.length < SEG_FIXED_HEADER + 2) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const metaLen = view.getUint16(1)
  if (payload.length < SEG_FIXED_HEADER + metaLen) return null
  try {
    const meta = JSON.parse(asciiToString(payload.subarray(SEG_FIXED_HEADER, SEG_FIXED_HEADER + metaLen))) as RingSegmentDataMeta
    return { meta, webm: payload.subarray(SEG_FIXED_HEADER + metaLen) }
  } catch {
    return null
  }
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff
  return out
}

function asciiToString(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i] ?? 0)
  return out
}

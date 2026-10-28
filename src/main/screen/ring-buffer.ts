import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/* ============================================================
 * Phase 3c: Encrypted 5-Minute Ring Buffer
 * - เขียนเซกเมนต์ 2 วินาทีต่อจอ (จาก MediaRecorder rotation
 *   ใน renderer) เข้ารหัส AES-256-GCM ด้วย screenBufferKey
 *   — เซกเมนต์สั้นลงเพื่อให้ DVR-style live stream ผ่าน UDP นุ่มลื่น
 * - เก็บสูงสุด 60 เซกเมนต์ต่อจอ (5 นาทีล่าสุด)
 * - Pin-on-Critical: เซกเมนต์ที่มี pinnedReason ไม่ถูกลบ
 * - destroy() = zero-trace (ลบโฟลเดอร์ + เขียนทับคีย์)
 * ============================================================ */

export const MAX_SEGMENTS_PER_DISPLAY = 60
/** Pin สูงสุดรวมกันทุกจอ (กันดิสก์เต็มเมื่อเกิดเหตุถี่) */
export const MAX_PINNED_SEGMENTS = 60

export interface RingSegmentRecord {
  segmentId: string
  displayId: string
  seqNo: number
  startTimeMs: number
  endTimeMs: number
  filePath: string
  ivBase64: string
  authTagBase64: string
  byteLength: number
  pinnedReason?: string
}

export interface AddSegmentInput {
  displayId: string
  seqNo: number
  startTimeMs: number
  endTimeMs: number
  plaintext: Buffer
  /** กำหนด segmentId เอง (ต้องไม่ซ้ำ) — ไม่ระบุจะสุ่ม UUID */
  segmentId?: string
}

export interface RingBufferOptions {
  sessionId: string
  /** คีย์ 32 bytes จากเครื่องแม่ (ผ่าน SCREEN_SESSION) */
  key: Buffer
  baseDir?: string
  maxSegmentsPerDisplay?: number
  maxPinnedSegments?: number
}

export interface PinSegmentResult {
  pinnedCount: number
  skippedReason: 'NO_BUFFER' | 'PIN_QUOTA_EXCEEDED' | null
}

/**
 * หมายเหตุการใช้งาน:
 * - ไฟล์ .enc บนดิสก์ = [12-byte IV][ciphertext][16-byte auth tag] เก็บต่อไฟล์
 * - Eviction: ลบเซกเมนต์เก่าสุด "ที่ไม่ถูก Pin" เท่านั้น (หากทุกตัวถูก Pin ให้เกินโควตาชั่วคราวได้)
 */
export class EncryptedRingBuffer {
  private readonly sessionId: string
  private key: Buffer | null
  private readonly baseDir: string
  private readonly maxPerDisplay: number
  private readonly maxPinned: number
  private readonly segments = new Map<string, RingSegmentRecord[]>() // displayId → records (เก่า→ใหม่)
  private destroyed = false

  constructor(options: RingBufferOptions) {
    if (options.key.length !== 32) throw new Error('SCREEN_BUFFER_KEY_MUST_BE_32_BYTES')
    this.sessionId = options.sessionId
    this.key = Buffer.from(options.key)
    this.baseDir = options.baseDir ?? path.join(os.tmpdir(), `ztexam-ring-${options.sessionId}`)
    this.maxPerDisplay = options.maxSegmentsPerDisplay ?? MAX_SEGMENTS_PER_DISPLAY
    this.maxPinned = options.maxPinnedSegments ?? MAX_PINNED_SEGMENTS
    fs.mkdirSync(this.baseDir, { recursive: true })
  }

  get directory(): string {
    return this.baseDir
  }

  /** รหัสเซสชันที่โฟลเดอร์ ring buffer ผูกอยู่ */
  get sessionIdValue(): string {
    return this.sessionId
  }

  get isDestroyed(): boolean {
    return this.destroyed
  }

  /** เพิ่มเซกเมนต์ใหม่ (เข้ารหัส + เขียนไฟล์ + evict ของเก่า) */
  addSegment(input: AddSegmentInput): RingSegmentRecord {
    this.assertAlive()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key!, iv)
    const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()])
    const authTag = cipher.getAuthTag()

    const segmentId = input.segmentId ?? randomUUID()
    const filePath = path.join(
      this.baseDir,
      `seg-${sanitize(input.displayId)}-${input.seqNo}-${segmentId.slice(0, 8)}.enc`
    )
    // รูปแบบไฟล์: [12 IV][ciphertext][16 tag]
    fs.writeFileSync(filePath, Buffer.concat([iv, ciphertext, authTag]))

    const record: RingSegmentRecord = {
      segmentId,
      displayId: input.displayId,
      seqNo: input.seqNo,
      startTimeMs: input.startTimeMs,
      endTimeMs: input.endTimeMs,
      filePath,
      ivBase64: iv.toString('base64'),
      authTagBase64: authTag.toString('base64'),
      byteLength: input.plaintext.length
    }
    const list = this.segments.get(input.displayId) ?? []
    list.push(record)
    this.segments.set(input.displayId, list)
    this.evict(input.displayId)
    return record
  }

  /** ล็อกเซกเมนต์รอบ timestamp: ก่อนเหตุ 2 เซกเมนต์ + ขณะเกิด + หลังเหตุ 3 เซกเมนต์ */
  pinAroundTimestamp(displayId: string, timestampMs: number, eventId: string): PinSegmentResult {
    this.assertAlive()
    const list = this.segments.get(displayId)
    if (!list || list.length === 0) return { pinnedCount: 0, skippedReason: 'NO_BUFFER' }
    const quota = this.maxPinned - list.filter((s) => s.pinnedReason !== undefined).length
    if (quota <= 0) return { pinnedCount: 0, skippedReason: 'PIN_QUOTA_EXCEEDED' }

    // หาเซกเมนต์ที่ timestamp อยู่ระหว่าง start..end (หรือตัวที่ใกล้ที่สุดก่อนหน้า)
    let anchorIndex = list.findIndex((s) => timestampMs >= s.startTimeMs && timestampMs <= s.endTimeMs)
    if (anchorIndex < 0) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const s = list[i]!
        if (s.startTimeMs <= timestampMs) {
          anchorIndex = i
          break
        }
      }
      if (anchorIndex < 0) anchorIndex = 0
    }
    const from = Math.max(0, anchorIndex - 2)
    const to = Math.min(list.length - 1, anchorIndex + 3)
    let pinned = 0
    for (let i = from; i <= to; i += 1) {
      const segment = list[i]!
      if (segment.pinnedReason === undefined && pinned < quota) {
        segment.pinnedReason = eventId
        pinned += 1
      }
    }
    return { pinnedCount: pinned, skippedReason: null }
  }

  /** รายการเซกเมนต์ทั้งหมดของจอหนึ่ง (เก่า→ใหม่) */
  listSegments(displayId: string): RingSegmentRecord[] {
    if (this.destroyed) return []
    return [...(this.segments.get(displayId) ?? [])]
  }

  /** ทุก displayId ที่มีเซกเมนต์อยู่ */
  listDisplays(): string[] {
    if (this.destroyed) return []
    return [...this.segments.keys()]
  }

  /** อ่าน + ถอดรหัสเซกเมนต์ (ส่งกลับเป็น .webm ที่เล่นได้) */
  readSegment(segmentId: string): Buffer | null {
    if (this.destroyed) return null
    for (const list of this.segments.values()) {
      const record = list.find((s) => s.segmentId === segmentId)
      if (!record) continue
      try {
        const raw = fs.readFileSync(record.filePath)
        const iv = raw.subarray(0, 12)
        const authTag = raw.subarray(raw.length - 16)
        const ciphertext = raw.subarray(12, raw.length - 16)
        const decipher = createDecipheriv('aes-256-gcm', this.key!, iv)
        decipher.setAuthTag(authTag)
        return Buffer.concat([decipher.update(ciphertext), decipher.final()])
      } catch {
        return null
      }
    }
    return null
  }

  /** ลบทุกอย่าง: ไฟล์ + โฟลเดอร์ + zeroize คีย์ (Zero-Trace Cleanup) */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    try {
      fs.rmSync(this.baseDir, { recursive: true, force: true })
    } catch {
      // ลบไม่สำเร็จ (ไฟล์ถูกล็อก) — ข้ามได้
    }
    this.segments.clear()
    if (this.key) {
      this.key.fill(0)
      this.key = null
    }
  }

  private evict(displayId: string): void {
    const list = this.segments.get(displayId)
    if (!list) return
    while (list.length > this.maxPerDisplay) {
      const oldestIndex = list.findIndex((s) => s.pinnedReason === undefined)
      if (oldestIndex < 0) break // ทุกตัวถูก Pin — ยอมให้เกินโควตาชั่วคราว
      const [oldest] = list.splice(oldestIndex, 1)
      if (!oldest) break
      try {
        fs.rmSync(oldest.filePath, { force: true })
      } catch {
        // ไฟล์หายไปแล้ว — ไม่เป็นไร
      }
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('RING_BUFFER_DESTROYED')
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'display'
}

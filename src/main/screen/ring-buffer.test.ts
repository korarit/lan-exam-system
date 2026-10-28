import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { EncryptedRingBuffer, MAX_SEGMENTS_PER_DISPLAY } from './ring-buffer'

describe('EncryptedRingBuffer (Phase 3c)', () => {
  let baseDir: string
  let key: Buffer

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-ring-test-'))
    key = randomBytes(32)
  })

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  function makeBuffer(): EncryptedRingBuffer {
    return new EncryptedRingBuffer({ sessionId: 'test-session', key, baseDir })
  }

  function addSegment(buffer: EncryptedRingBuffer, seqNo: number, payload = `seg-${seqNo}-payload`): string {
    const record = buffer.addSegment({
      displayId: 'display-1',
      seqNo,
      startTimeMs: seqNo * 10_000,
      endTimeMs: seqNo * 10_000 + 10_000,
      plaintext: Buffer.from(payload, 'utf8')
    })
    return record.segmentId
  }

  it('เข้ารหัสไฟล์ .enc บนดิสก์ — อ่านตรง ๆ ไม่เห็นเนื้อหาเดิม (Encrypted Segment Test)', () => {
    const buffer = makeBuffer()
    const secret = 'SECRET_WEBM_SEGMENT_CONTENT_ไม่หลุดบนดิสก์'
    addSegment(buffer, 0, secret)

    const [record] = buffer.listSegments('display-1')
    expect(record).toBeTruthy()
    const raw = fs.readFileSync(record!.filePath)
    expect(raw.length).toBeGreaterThan(28)
    expect(raw.toString('utf8')).not.toContain('SECRET_WEBM_SEGMENT')
    // ต้องถอดรหัสด้วยคีย์ที่ถูกต้องเท่านั้น
    expect(buffer.readSegment(record!.segmentId)!.toString('utf8')).toBe(secret)
    buffer.destroy()
  })

  it('ถอดรหัสด้วยคีย์ผิดต้องล้มเหลว (GCM auth)', () => {
    const buffer = makeBuffer()
    addSegment(buffer, 0)
    const [record] = buffer.listSegments('display-1')
    const raw = fs.readFileSync(record!.filePath)
    buffer.destroy()

    // ลองถอดไฟล์ .enc จากดิสก์ด้วยคีย์ที่ไม่ตรง → GCM ต้องปฏิเสธ
    const decipher = createDecipheriv('aes-256-gcm', randomBytes(32), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(raw.length - 16))
    decipher.update(raw.subarray(12, raw.length - 16))
    expect(() => decipher.final()).toThrow()
  })

  it('Rotation: เกิน 30 เซกเมนต์ต่อจอ → ลบเก่าสุดทิ้ง จำนวนไฟล์คงที่', () => {
    const buffer = makeBuffer()
    for (let i = 0; i < 45; i += 1) addSegment(buffer, i)

    const list = buffer.listSegments('display-1')
    expect(list.length).toBe(MAX_SEGMENTS_PER_DISPLAY)
    expect(list[0]!.seqNo).toBe(15) // ตัว 0-14 ถูกวนลบ
    const files = fs.readdirSync(baseDir).filter((f) => f.endsWith('.enc'))
    expect(files.length).toBe(MAX_SEGMENTS_PER_DISPLAY)
    buffer.destroy()
  })

  it('Pin-on-Critical: เซกเมนต์ที่ Pin ไม่ถูกลบ และถอดรหัสกลับได้ครบ (Ring Buffer Rotation & Pinning Test)', () => {
    const buffer = makeBuffer()
    const segmentIds = new Map<number, string>()
    for (let i = 0; i < 45; i += 1) {
      segmentIds.set(i, addSegment(buffer, i))
      // เกิดเหตุวิกฤตช่วงเซกเมนต์ 5-7 → ล็อกทันทีก่อนถูกวนลบ
      if (i === 5 || i === 6 || i === 7) {
        const result = buffer.pinAroundTimestamp('display-1', i * 10_000, `event-${i}`)
        expect(result.pinnedCount).toBeGreaterThan(0)
      }
    }

    const list = buffer.listSegments('display-1')
    // pinAroundTimestamp ล็อกรอบเหตุ (ก่อน 2 + หลัง 3) — ขอบเขตเซกเมนต์ทับกันทำให้ช่วงลาก 2-7
    const pinned = list.filter((s) => s.pinnedReason !== undefined)
    expect(pinned.map((s) => s.seqNo).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7])
    // เซกเมนต์ที่ไม่ Pin ตัวเก่า (0-1 และ 8-14) ถูกลบออกจากดิสก์จริง
    for (const seq of [0, 1, 8, 9, 10, 11, 12, 13, 14]) {
      expect(list.find((s) => s.seqNo === seq)).toBeUndefined()
    }
    // โควตาทั้งหมด = 30 (Pin 6 ตัว + ปกติ 24 ตัว)
    expect(list.length).toBe(MAX_SEGMENTS_PER_DISPLAY)
    const liveCount = list.filter((s) => s.pinnedReason === undefined).length
    expect(liveCount).toBe(MAX_SEGMENTS_PER_DISPLAY - pinned.length)
    for (const seq of [5, 6, 7]) {
      const record = list.find((s) => s.seqNo === seq)
      expect(record).toBeTruthy()
      expect(fs.existsSync(record!.filePath)).toBe(true)
      // ถอดรหัสกลับได้ตรงต้นฉบับ 100%
      expect(buffer.readSegment(record!.segmentId)!.toString('utf8')).toBe(`seg-${seq}-payload`)
      expect(buffer.readSegment(segmentIds.get(seq)!)!.toString('utf8')).toBe(`seg-${seq}-payload`)
    }
    buffer.destroy()
  })

  it('Pin รอบ timestamp: ล็อกก่อนเหตุ 2 + หลังเหตุ 3 เซกเมนต์ (รวม 6)', () => {
    const buffer = makeBuffer()
    for (let i = 0; i < 20; i += 1) addSegment(buffer, i)
    // เหตุเกิดระหว่างเซกเมนต์ 10
    const result = buffer.pinAroundTimestamp('display-1', 10 * 10_000 + 5_000, 'critical-event')
    expect(result.pinnedCount).toBe(6)
    const pinnedSeqs = buffer
      .listSegments('display-1')
      .filter((s) => s.pinnedReason === 'critical-event')
      .map((s) => s.seqNo)
    expect(pinnedSeqs.sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12, 13])
    buffer.destroy()
  })

  it('destroy(): ลบโฟลเดอร์ทั้งหมด (Zero-Trace Cleanup)', () => {
    const buffer = makeBuffer()
    addSegment(buffer, 0)
    expect(fs.existsSync(buffer.directory)).toBe(true)
    buffer.destroy()
    expect(buffer.isDestroyed).toBe(true)
    expect(fs.existsSync(buffer.directory)).toBe(false)
    expect(buffer.readSegment('nope')).toBeNull()
    expect(buffer.listDisplays()).toEqual([])
  })

  it('หลายจอ (multi-display) วนลบแยกกัน', () => {
    const buffer = makeBuffer()
    for (let i = 0; i < 32; i += 1) {
      buffer.addSegment({
        displayId: 'display-2',
        seqNo: i,
        startTimeMs: i * 10_000,
        endTimeMs: i * 10_000 + 10_000,
        plaintext: Buffer.from('two')
      })
    }
    expect(buffer.listSegments('display-2').length).toBe(30)
    expect(buffer.listDisplays()).toEqual(['display-2'])
    buffer.destroy()
  })
})

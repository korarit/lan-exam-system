import { createHmac } from 'node:crypto'
import { computeHmac } from '../crypto/primitives'
import { renderPromptTemplate } from '@shared/exam-template'
import type { QuestionParameterSpec } from '@shared/exam-schema'

/* ============================================================
 * Deterministic Seeded PRNG (xoshiro128**)
 * - Seed 128-bit จาก HMAC(ต่อเหมาะกับบริบท) → ผลการสุ่มชุดเดิม = ผลลัพธ์เดิมเป๊ะ 100%
 * ============================================================ */

/** splitmix32: ใช้เริ่ม state 4 คำจาก seed bytes เต็ม (กัน state มาจาก byte ต่ำ ๆ เท่านั้น) */
function splitmix32(state: number): number {
  state = (state + 0x9e3779b9) | 0
  let z = state | 0
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) | 0
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) | 0
  return (z ^ (z >>> 15)) >>> 0
}

/**
 * xoshiro128** — fast, deterministic, good statistical quality สำหรับ 128-bit state
 * คืนฟังก์ชัน rng() ที่คืนค่า float [0, 1) และ rngInt(maxBelow) สำหรับจำนวนเต็ม
 */
export function createSeededRng(seedBytes: Buffer): SeededRng {
  if (seedBytes.length < 16) throw new Error('PRNG seed must be at least 16 bytes')
  const words: [number, number, number, number] = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) {
    const offset = i * 4
    const packed =
      ((seedBytes[offset] ?? 0) |
        ((seedBytes[offset + 1] ?? 0) << 8) |
        ((seedBytes[offset + 2] ?? 0) << 16) |
        ((seedBytes[offset + 3] ?? 0) << 24)) >>>
      0
    words[i] = splitmix32(packed)
  }
  // กัน all-zero state (ทำให้ xoshiro ตายถาวร) — ผลักตำแหน่งแรกให้เป็น 1 ทันที
  if (words.every((x) => x === 0)) words[0] = 1
  const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0
  const nextUint32 = (): number => {
    // xoshiro128**: output จาก s1 (ก่อนอัปเดต state)
    const result = Math.imul(rotl(Math.imul(words[1], 5), 7), 9) >>> 0
    // state update: t = (s1 << 9); s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t; s3 = rotl(s3, 11)
    const t = (words[1] << 9) >>> 0
    words[2] = (words[2] ^ words[0]) >>> 0
    words[3] = (words[3] ^ words[1]) >>> 0
    words[1] = (words[1] ^ words[2]) >>> 0
    words[0] = (words[0] ^ words[3]) >>> 0
    words[2] = (words[2] ^ t) >>> 0
    words[3] = rotl(words[3], 11)
    return result
  }

  return {
    nextFloat32: () => nextUint32() / 4294967296,
    nextInt: (maxBelow: number) => {
      if (maxBelow <= 0 || maxBelow > 0x40000000) {
        throw new Error('nextInt(maxBelow) must be in (0, 2^30]')
      }
      // rejection sampling → บังคับ unbiased เสมอ
      const limit = Math.floor(4294967296 / maxBelow) * maxBelow
      let x = nextUint32()
      while (x >= limit) x = nextUint32()
      return x % maxBelow
    }
  }
}

export interface SeededRng {
  /** [0, 1) */
  nextFloat32(): number
  /** เลขจำนวนเต็ม [0, maxBelow) แบบ unbiased */
  nextInt(maxBelow: number): number
}

function hmacSeed(base: string, context: string): Buffer {
  return computeHmac(Buffer.from(base, 'utf8'), context)
}

/* ============================================================
 * Student Seeding (per-room, per-student deterministic)
 * ============================================================ */

/**
 * studentSeed = HMAC(secretSeed, studentId)
 * - สุ่มข้อ/ตัวเลือกให้ต่างกันรายคน
 * - คำนวณซ้ำเมื่อ reconnect กลับมาได้เป๊ะ 100% (deterministic)
 * - เก็บลงตาราง students ตั้งแต่ phase 1 (column `seed`)
 */
export function deriveStudentSeed(roomSecretSeed: string, studentId: string): string {
  const seed = createHmac('sha256', Buffer.from(roomSecretSeed, 'utf8'))
    .update(studentId)
    .digest('hex')
  return seed
}

/** Fisher-Yates สลับลำดับรายการด้วย seeded PRNG (ไม่มี bias, stable) */
export function shuffleOrder(rng: SeededRng, items: readonly string[]): string[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1)
    const tmp = out[i]
    out[i] = out[j]!
    out[j] = tmp!
  }
  return out
}

/* ============================================================
 * Shuffler — ของนักเรียนคนหนึ่ง
 * ============================================================ */

export class StudentShuffler {
  private readonly studentSeed: string

  constructor(studentSeedHex: string) {
    this.studentSeed = studentSeedHex
  }

  /** ลำดับ questionId ที่สุ่มเฉพาะคน (Fisher-Yates ด้วย seed + 'question-order') */
  computeQuestionOrder(questionIds: readonly string[]): string[] {
    const rng = createSeededRng(hmacSeed(this.studentSeed, 'question-order'))
    return shuffleOrder(rng, questionIds)
  }

  /** ลำดับ choiceId ในข้อปรนัยที่สุ่มเฉพาะคน (seed + questionId + 'choice-order') */
  computeChoiceOrder(questionId: string, choiceIds: readonly string[]): string[] {
    const rng = createSeededRng(hmacSeed(this.studentSeed, `choice:${questionId}`))
    return shuffleOrder(rng, choiceIds)
  }

  /**
   * สุ่มค่าตัวแปรพารามิเตอร์ (seed + questionId + 'params') คืนแผนที่ชื่อ → ค่า
   * ค่าที่ได้จะเท่ากับ min + (k × step) ตาม step ที่ข้อกำหนด
   */
  resolveParameters(
    questionId: string,
    specs: Record<string, QuestionParameterSpec>
  ): Record<string, number> {
    const rng = createSeededRng(hmacSeed(this.studentSeed, `params:${questionId}`))
    const result: Record<string, number> = {}
    for (const key of Object.keys(specs).sort()) {
      const spec = specs[key]
      if (!spec) continue
      const min = Math.min(spec.min, spec.max)
      const max = Math.max(spec.min, spec.max)
      const step = Math.max(1, spec.step)
      const candidates = Math.floor((max - min) / step) + 1
      const index = rng.nextInt(candidates)
      result[key] = min + index * step
    }
    return result
  }

  /** โจทย์ที่แทนค่าตามพารามิเตอร์ที่สุ่มแล้ว */
  renderPrompt(
    questionId: string,
    template: string,
    specs: Record<string, QuestionParameterSpec>
  ): { prompt: string; values: Record<string, number> } {
    const values = specs && Object.keys(specs).length ? this.resolveParameters(questionId, specs) : {}
    return { prompt: renderPromptTemplate(template, values), values }
  }
}

export { renderPromptTemplate }

import { describe, it, expect } from 'vitest'
import {
  createSeededRng,
  deriveStudentSeed,
  shuffleOrder,
  StudentShuffler
} from './shuffler'
import type { QuestionParameterSpec } from '@shared/exam-schema'

const ROOM_SECRET = 'room-secret-seed-abcdef-0123456789abcdef'

describe('createSeededRng', () => {
  it('returns deterministic sequences for the same seed', () => {
    const seed = Buffer.alloc(16, 7)
    const a = createSeededRng(seed).nextInt(1000)
    const b = createSeededRng(Buffer.alloc(16, 7)).nextInt(1000)
    expect(a).toBe(b)
  })

  it('produces different streams for different seeds', () => {
    const a = createSeededRng(Buffer.alloc(16, 1)).nextInt(1000)
    const b = createSeededRng(Buffer.alloc(16, 2)).nextInt(1000)
    expect(a).not.toBe(b)
  })

  it('stays inside the requested range over many draws', () => {
    const rng = createSeededRng(Buffer.alloc(16, 3))
    for (let i = 0; i < 5000; i++) {
      const v = rng.nextInt(7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
    }
  })

  it('covers all values unbiasedly with reasonable sample size', () => {
    const rng = createSeededRng(Buffer.alloc(16, 4))
    const seen = new Set<number>()
    for (let i = 0; i < 2000; i++) seen.add(rng.nextInt(6))
    expect(seen.size).toBe(6)
  })
})

describe('shuffleOrder (Fisher-Yates)', () => {
  it('permutes deterministically for the same seed and inputs', () => {
    const seed = deriveStudentSeed(ROOM_SECRET, 's-001')
    expect(shuffleOrder(
      createSeededRng(Buffer.from(seed, 'utf8').subarray(0, 16)),
      ['a', 'b', 'c', 'd', 'e']
    )).toEqual(shuffleOrder(
      createSeededRng(Buffer.from(seed, 'utf8').subarray(0, 16)),
      ['a', 'b', 'c', 'd', 'e']
    ))
  })

  it('keeps every element exactly once', () => {
    const rng = createSeededRng(Buffer.alloc(16, 9))
    expect(shuffleOrder(rng, ['1', '2', '3', '4', '5', '6']).sort()).toEqual([
      '1', '2', '3', '4', '5', '6'
    ])
  })
})

describe('deriveStudentSeed', () => {
  it('is deterministic per (secret, studentId) and differs across students', () => {
    expect(deriveStudentSeed(ROOM_SECRET, 's-001')).toBe(deriveStudentSeed(ROOM_SECRET, 's-001'))
    expect(deriveStudentSeed(ROOM_SECRET, 's-001')).not.toBe(deriveStudentSeed(ROOM_SECRET, 's-002'))
    expect(deriveStudentSeed(ROOM_SECRET, 's-001')).toHaveLength(64)
  })
})

describe('StudentShuffler', () => {
  const questionIds = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8']
  const choiceIds = ['c1', 'c2', 'c3', 'c4']

  it('returns the original question order when given same seed twice', () => {
    const seed = deriveStudentSeed(ROOM_SECRET, 'dupe')
    const s = new StudentShuffler(seed)
    expect(s.computeQuestionOrder(questionIds)).toEqual(s.computeQuestionOrder(questionIds))
  })

  it('gives different students different orders (but same membership)', () => {
    const a = new StudentShuffler(deriveStudentSeed(ROOM_SECRET, 'A'))
    const b = new StudentShuffler(deriveStudentSeed(ROOM_SECRET, 'B'))
    const orderA = a.computeQuestionOrder(questionIds)
    const orderB = b.computeQuestionOrder(questionIds)
    expect(orderA).toEqual(new StudentShuffler(deriveStudentSeed(ROOM_SECRET, 'A')).computeQuestionOrder(questionIds))
    expect([...orderA].sort()).toEqual([...questionIds].sort())
    expect([...orderB].sort()).toEqual([...questionIds].sort())
    expect(orderA).not.toEqual(orderB)
  })

  it('shuffles per-question choice order deterministically', () => {
    const seed = deriveStudentSeed(ROOM_SECRET, 'C')
    const s = new StudentShuffler(seed)
    expect(s.computeChoiceOrder('q1', choiceIds)).toEqual(s.computeChoiceOrder('q1', choiceIds))
    expect([...s.computeChoiceOrder('q1', choiceIds)].sort()).toEqual([...choiceIds].sort())
  })

  it('resolves parameters inside [min, max] and on step boundaries', () => {
    const s = new StudentShuffler(deriveStudentSeed(ROOM_SECRET, 'param'))
    const specs: Record<string, QuestionParameterSpec> = { a: { min: 2, max: 20, step: 3 } }
    for (let run = 0; run < 20; run++) {
      const values = s.resolveParameters('qX', specs)
      const a = values.a!
      expect(a).toBeGreaterThanOrEqual(2)
      expect(a).toBeLessThanOrEqual(20)
      expect((a - 2) % 3).toBe(0)
    }
    // deterministic ต่อ (seed, questionId)
    expect(s.resolveParameters('qX', specs)).toEqual(s.resolveParameters('qX', specs))
  })

  it('renders prompt with the resolved parameter values', () => {
    const s = new StudentShuffler(deriveStudentSeed(ROOM_SECRET, 'render'))
    const { prompt, values } = s.renderPrompt('q1', 'จงหาค่าของ {{a}} + {{b}}', {
      a: { min: 1, max: 9, step: 1 },
      b: { min: 1, max: 9, step: 1 }
    })
    expect(prompt).toBe(`จงหาค่าของ ${values.a} + ${values.b}`)
    expect(prompt.includes('{{')).toBe(false)
  })

  it('leaves unknown template placeholders untouched', () => {
    const s = new StudentShuffler(deriveStudentSeed(ROOM_SECRET, 'render'))
    const { prompt } = s.renderPrompt('q1', 'ค่า {{c}} ยังไม่มีในพารามิเตอร์', {
      a: { min: 1, max: 2, step: 1 }
    })
    expect(prompt).toBe('ค่า {{c}} ยังไม่มีในพารามิเตอร์')
  })
})

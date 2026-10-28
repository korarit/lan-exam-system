import { describe, it, expect } from 'vitest'
import { QuestionDispatcher } from './dispatcher'
import type { ExamDefinition } from '@shared/exam-schema'

const baseExam: ExamDefinition = {
  moduleId: 'stepping-runner',
  title: 'คณิตศาสตร์ทดสอบ',
  durationSeconds: 3600,
  questions: [
    {
      questionId: 'q1',
      type: 'mcq',
      promptTemplate: '1 + 1 = ?',
      points: 1,
      allowBackNavigation: false,
      choices: [
        { choiceId: 'c1', text: '2' },
        { choiceId: 'c2', text: '3' },
        { choiceId: 'c3', text: '4' },
        { choiceId: 'c4', text: '5' }
      ],
      correctChoiceId: 'c1'
    },
    {
      questionId: 'q2',
      type: 'short-answer',
      promptTemplate: 'จงหาค่าของ {{a}} + {{b}}',
      points: 2,
      allowBackNavigation: true,
      caseSensitive: false,
      parameters: {
        a: { min: 1, max: 9, step: 1 },
        b: { min: 1, max: 9, step: 1 }
      },
      correctAnswerExpression: 'a + b'
    },
    {
      questionId: 'q3',
      type: 'essay',
      promptTemplate: 'อธิบายทฤษบทพีทาโกรัส',
      points: 5,
      allowBackNavigation: false
    }
  ]
}

function makeDispatcher(examOverrides: Partial<ExamDefinition> = {}): QuestionDispatcher {
  const exam = { ...baseExam, ...examOverrides }
  return new QuestionDispatcher(exam, { isOpen: () => true, now: () => 0 })
}

describe('Zero-leakage payload', () => {
  it('does not include correctChoiceId, correctAnswer, or his choiceIds in the payload', () => {
    const d = makeDispatcher()
    d.registerStudent('s-001', 'room-secret')
    const payload = d.getPayload('s-001', 0)
    expect(payload).not.toBeNull()
    const json = JSON.stringify(payload)
    expect(json).not.toContain('correctChoiceId')
    expect(json).not.toContain('correctAnswer')
    expect(json).not.toContain('c1')
    expect(json).not.toContain('c2')
    expect(json).not.toContain('choiceId')
    // ทุกตัวเลือกใน payload เป็นแค่ข้อความ
    payload!.choices?.forEach((choice) => {
      expect(Object.keys(choice)).toEqual(['text'])
    })
  })

  it('only ever hands out the current question (never question others)', () => {
    const d = makeDispatcher()
    d.registerStudent('s-001', 'room-secret')
    const first = d.getPayload('s-001', 0)
    expect(first!.cursorIndex).toBe(0)
    // ทุก cursor ต้องดึงเฉพาะข้อนั้น — เครื่องนักเรียนไม่เคยเห็นข้ออื่นใน payload เดียวกัน
    const second = d.getPayload('s-001', 1)
    expect(second!.cursorIndex).toBe(1)
    expect(first!.questionId).not.toBe(second!.questionId)
    // ข้อเดียวต่อ payload เสมอ
    expect(Object.keys(first!)).not.toContain('questions')
  })

  it('resolves parameter values per student deterministically', () => {
    const d = makeDispatcher()
    d.registerStudent('s-001a', 'room-secret')
    const payload = d.getPayload('s-001a', 1)
    expect(payload!.prompt).toMatch(/จงหาค่าของ \d+ \+ \d+/)
    expect(d.getPayload('s-001a', 1)!.prompt).toBe(payload!.prompt)
  })

  it('throws on unregistered student lookup', () => {
    const d = makeDispatcher()
    expect(() => d.getPayload('ghost', 0)).toThrow(/STUDENT_NOT_REGISTERED/)
  })
})

describe('Stepping enforcement', () => {
  it('advances the cursor exactly one step per submit', () => {
    const d = makeDispatcher()
    d.registerStudent('s-001', 'room-secret')
    const first = d.getPayload('s-001', 0)!
    const r1 = d.handleSubmitAnswer('s-001', {
      questionId: first.questionId,
      cursorIndex: 0,
      answer: { type: 'mcq', choiceIndex: 0 },
      timeSpentMs: 100
    })
    expect(r1.accepted).toBe(true)
    expect(d.getCursor('s-001')).toBe(1)
    const second = d.getPayload('s-001', 1)!
    const r2 = d.handleSubmitAnswer('s-001', {
      questionId: second.questionId,
      cursorIndex: 1,
      answer: { type: 'text', content: '7' },
      timeSpentMs: 100
    })
    expect(r2.accepted).toBe(true)
    expect(d.getCursor('s-001')).toBe(2)
  })

  it('rejects an answer of question 5 when the current cursor is at question 2', () => {
    const d = makeDispatcher()
    d.registerStudent('s-001', 'room-secret')
    // ตัวจริงเริ่มที่ cursor 0 — ลองโต้โดยตรง
    const anomalies: unknown[] = []
    const d2 = new QuestionDispatcher(baseExam, { isOpen: () => true, now: () => 0 }, (a) => anomalies.push(a))
    d2.registerStudent('s-001', 'room-secret')
    const second1 = d2.getPayload('s-001', 1)!
    const reject = d2.handleSubmitAnswer('s-001', {
      questionId: second1.questionId,
      cursorIndex: 4, // ข้ามข้อ
      answer: { type: 'text', content: 'x' },
      timeSpentMs: 10
    })
    expect(reject.accepted).toBe(false)
    if (!reject.accepted) expect(reject.reason).toBe('cursor-mismatch')
    expect(anomalies.some((a) => (a as { reason: string }).reason === 'SUBMIT_CURSOR_MISMATCH')).toBe(true)
    expect(d2.getCursor('s-001')).toBe(0)
  })

  it('rejects submit with a wrong questionId at the current cursor', () => {
    const anys: unknown[] = []
    const d = new QuestionDispatcher(baseExam, { isOpen: () => true, now: () => 0 }, (a) => anys.push(a))
    d.registerStudent('s-001', 'room-secret')
    const r = d.handleSubmitAnswer('s-001', {
      questionId: 'not-a-real-id',
      cursorIndex: 0,
      answer: { type: 'text', content: 'x' },
      timeSpentMs: 10
    })
    expect(r.accepted).toBe(false)
    expect(anys.some((a) => (a as { reason: string }).reason === 'SUBMIT_UNKNOWN_QUESTION')).toBe(true)
  })

  it('rejects when the exam window is closed (time-expired)', () => {
    let open = true
    const d = new QuestionDispatcher(baseExam, { isOpen: () => open, now: () => 0 })
    d.registerStudent('s-001', 'room-secret')
    open = false
    const first = d.getPayload('s-001', 0)!
    const r = d.handleSubmitAnswer('s-001', {
      questionId: first.questionId,
      cursorIndex: 0,
      answer: { type: 'mcq', choiceIndex: 0 },
      timeSpentMs: 10
    })
    expect(r.accepted).toBe(false)
    if (!r.accepted) expect(r.reason).toBe('time-expired')
  })

  it('translates the shuffled choiceIndex back to the original choiceId', () => {
    const d = makeDispatcher()
    d.registerStudent('s-001', 'room-secret')
    const payload = d.getPayload('s-001', 0)!
    const order = payload.choices ?? []
    // ปรนัย 4 ช้อยส์: ดัชนี 0..3 แปลงเป็น set ชุดเดียวกับ (c1..c4)
    const translatedIds = order.map((_c, i) => d.translateChoiceIndex('s-001', payload.questionId, i))
    expect([...translatedIds].sort()).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(d.translateChoiceIndex('s-001', payload.questionId, 99)).toBeNull()
  })

  it('supports back-navigation only up to maxReachedCursor', () => {
    const d = makeDispatcher()
    d.registerStudent('s-001', 'room-secret')
    const first = d.getPayload('s-001', 0)!
    d.handleSubmitAnswer('s-001', {
      questionId: first.questionId,
      cursorIndex: 0,
      answer: { type: 'text', content: 'a' },
      timeSpentMs: 10
    })
    const second = d.getPayload('s-001', 1)!
    d.handleSubmitAnswer('s-001', {
      questionId: second.questionId,
      cursorIndex: 1,
      answer: { type: 'text', content: 'b' },
      timeSpentMs: 10
    })
    // ย้อนไปข้อ 0 ได้ (เคยผ่านแล้ว)
    expect(d.navigateBack('s-001', { cursorIndex: 0 }).ok).toBe(true)
    // ย้อนไปดูข้อที่ยังไม่ถึง = ต้องถูกปฏิเสธ
    const anomalies: unknown[] = []
    const d2 = new QuestionDispatcher(baseExam, { isOpen: () => true, now: () => 0 }, (a) => anomalies.push(a))
    d2.registerStudent('s-002', 'room-secret')
    const res = d2.navigateBack('s-002', { cursorIndex: 5 })
    expect(res.ok).toBe(false)
    expect(anomalies.some((a) => (a as { reason: string }).reason === 'NAVIGATE_AHEAD_OF_PROGRESS')).toBe(true)
  })

  it('accepts resubmitting an older back-navigable question without advancing wrongly', () => {
    const d = makeDispatcher()
    d.registerStudent('s-001', 'room-secret')
    const payloadByIndex = [0, 1, 2].map((i) => d.getPayload('s-001', i)!)
    for (let i = 0; i < payloadByIndex.length; i++) {
      const p = payloadByIndex[i]!
      const answer = p.type === 'mcq' ? ({ type: 'mcq', choiceIndex: 0 } as const) : ({ type: 'text', content: String(i) } as const)
      d.handleSubmitAnswer('s-001', { questionId: p.questionId, cursorIndex: i, answer, timeSpentMs: 5 })
    }
    expect(d.getCursor('s-001')).toBe(3)

    // ข้อที่อนุญาตย้อนกลับ (q2 — short-answer) แก้ใหม่หลังย้อนไปดูได้
    const backIndex = payloadByIndex.findIndex((p) => p.allowBackNavigation)
    expect(backIndex).toBeGreaterThanOrEqual(0)
    const backPayload = payloadByIndex[backIndex]!
    const result = d.handleSubmitAnswer('s-001', {
      questionId: backPayload.questionId,
      cursorIndex: backIndex,
      answer: { type: 'text', content: 'แก้แล้ว' },
      timeSpentMs: 5
    })
    expect(result.accepted).toBe(true)
    expect(d.getCursor('s-001')).toBe(3)

    // ข้อที่ไม่อนุญาตย้อนกลับ ส่งซ้ำด้วย cursor ที่ไม่ตรง = ถูกปฏิเสธ
    const strictIndex = payloadByIndex.findIndex((p) => !p.allowBackNavigation)
    expect(strictIndex).toBeGreaterThanOrEqual(0)
    const strictPayload = payloadByIndex[strictIndex]!
    const d2 = makeDispatcher()
    d2.registerStudent('s-002', 'room-secret')
    const first = d2.getPayload('s-002', 0)!
    d2.handleSubmitAnswer('s-002', {
      questionId: first.questionId,
      cursorIndex: 0,
      answer: { type: 'text', content: 'x' },
      timeSpentMs: 5
    })
    const reject = d2.handleSubmitAnswer('s-002', {
      questionId: strictPayload.questionId === first.questionId ? 'wrong-id' : first.questionId,
      cursorIndex: 0,
      answer: { type: 'text', content: 'y' },
      timeSpentMs: 5
    })
    expect(reject.accepted).toBe(false)
  })

  it('reports null next question (completed) after the final submit', () => {
    const d = makeDispatcher()
    d.registerStudent('s-001', 'room-secret')
    for (let index = 0; index < baseExam.questions.length; index++) {
      const payload = d.getPayload('s-001', index)!
      const answer =
        payload.type === 'mcq'
          ? ({ type: 'mcq', choiceIndex: 0 } as const)
          : ({ type: 'text', content: 'answer' } as const)
      d.handleSubmitAnswer('s-001', {
        questionId: payload.questionId,
        cursorIndex: index,
        answer,
        timeSpentMs: 100
      })
    }
    expect(d.getCursor('s-001')).toBe(3)
    expect(d.getPayload('s-001', 3)).toBeNull()
    expect(d.getMaxReachedCursor('s-001')).toBe(3)
  })
})


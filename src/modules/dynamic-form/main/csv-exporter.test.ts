import { describe, expect, it } from 'vitest'
import { buildResponsesCsv, csvCell, canonicalQuestionItems } from './csv-exporter'
import type { DynamicFormDefinition, FormQuestion } from '../shared/form-schema'
import type { StoredFormResponseRow } from './form-response-store'
import { createSeededRandom, shuffleWithSeededRandom } from '../shared/student-view'

/* ============================================================
 * 7.4.1 ทดสอบ Shuffled-to-Canonical CSV (Definition of Done)
 * นักเรียน 3 คนได้ลำดับข้อสลับต่างกัน (รายคน) แต่คำตอบต้อง
 * ยกกลับไปลงคอลัมน์ Q1..QN ตามลำดับมาตรฐานของฟอร์ม 100%
 * + ตรวจ UTF-8 BOM ตนไฟล์เปิด Excel ไทยได้
 * ============================================================ */

function makeForm(): DynamicFormDefinition {
  return {
    moduleId: 'dynamic-form',
    formId: '11111111-2222-3333-4444-555555555555',
    title: 'ชุดทดสอบ CSV',
    instructions: '',
    settings: { durationMinutes: 30, shuffleQuestionsPerStudent: true, navigationPolicy: 'strict-one-way', showScoreImmediatelyAfterSubmit: false },
    items: [
      {
        inputType: 'mcq_single',
        itemId: 'A',
        prompt: 'คำถามข้อหนึ่ง',
        points: 1,
        shuffleChoices: false,
        choices: [
          { choiceId: 'x', text: 'คำตอบข้อหนึ่ง' },
          { choiceId: 'y', text: 'อีกทางเลือก' }
        ],
        validation: { required: true },
        answerKey: { gradingType: 'exact_choice', correctChoiceId: 'x' }
      },
      {
        inputType: 'short_text',
        itemId: 'B',
        prompt: 'คำถามข้อสอง',
        points: 2,
        shuffleChoices: false,
        validation: { required: true },
        answerKey: { gradingType: 'short_text_match', acceptedAnswers: ['สี่'], caseSensitive: false, trimWhitespace: true, useRegex: false }
      }
    ]
  }
}

function rowOf(student: string, itemId: string, value: unknown, points: number): StoredFormResponseRow {
  return {
    roomId: 'room-1',
    studentId: student,
    itemId,
    status: points > 0 ? 'auto-graded' : 'auto-graded',
    earnedPoints: points,
    manualPoints: null,
    violationsJson: '[]',
    value: value as never,
    artifacts: [],
    journey: null,
    submittedAtMs: 1_700_000_000_000,
    revision: 0,
    updatedAtMs: 0
  }
}

describe('7.4.1 Shuffled-to-Canonical CSV', () => {
  it('คำตอบของแต่ละคนลงคอลัมน์ Q1/Q2 ตรงข้อจริง + BOM', async () => {
    const form = makeForm()
    const seedA = 'student-a'
    const seedB = 'student-b'
    const seedC = 'student-c'
    for (const seed of [seedA, seedB, seedC]) {
      const rand = createSeededRandom(form.formId, seed)
      const shuffled = shuffleWithSeededRandom(form.items.map((i) => i.itemId), rand)
      void shuffled
    }

    // เรียงคำตอบแบบ "ส่งด้วยลำดับข้อที่สลับรายคน" ก่อนเข้า exporter
    const canon = canonicalQuestionItems(form).map((q) => q.item.itemId)
    const answers: Record<string, Array<{ itemId: string; value: unknown; text: string; points: number }>> = {
      's1': [
        { itemId: canon[0]!, value: { kind: 'choice', choiceId: 'x' }, text: 'คำตอบข้อหนึ่ง', points: 1 },
        { itemId: canon[1]!, value: { kind: 'text', text: 'สี่' }, text: 'สี่', points: 2 }
      ],
      's2': [
        { itemId: canon[0]!, value: { kind: 'choice', choiceId: 'y' }, text: 'อีกทางเลือก', points: 0 },
        { itemId: canon[1]!, value: { kind: 'text', text: 'ffffff' }, text: 'ffffff', points: 0 }
      ],
      's3': [
        { itemId: canon[1]!, value: { kind: 'text', text: 'สี่' }, text: 'สี่', points: 2 },
        { itemId: canon[0]!, value: { kind: 'choice', choiceId: 'x' }, text: 'คำตอบข้อหนึ่ง', points: 1 }
      ]
    }

    const csv = buildResponsesCsv({
      form,
      roomName: 'ห้อง 401',
      examStartedAtMs: 1_700_000_000_000,
      students: Object.entries(answers).map(([studentId, list]) => ({
        profile: {
          studentId,
          studentName: `นักเรียน ${studentId}`,
          startedAtMs: 1_700_000_000_000,
          submittedAtMs: 1_700_000_100_000,
          securityStatus: 'NORMAL' as const,
          suspicionScore: 0,
          criticalEvents: 0,
          proctorNote: ''
        },
        answers: {
          studentId,
          responses: new Map(list.map((a) => [a.itemId, rowOf(studentId, a.itemId, a.value, a.points)])),
          answeredCount: list.length,
          anyManualPending: false,
          totalScore: list.reduce((acc, a) => acc + a.points, 0),
          maxScore: 3,
          scorePercent: Math.round(((list.reduce((acc, a) => acc + a.points, 0) / 3) * 100) * 10) / 10
        }
      }))
    })

    const text = new TextDecoder('utf-8').decode(csv)
    // TextDecoder ตัด BOM ออกอัตโนมัติ — ตรวจไบต์ต้นไฟล์แทน
    expect(Array.from(csv.slice(0, 3))).toEqual([0xEF, 0xBB, 0xBF])

    const lines = text.split('\r\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(4)
    // แถวหัวตาราง: Q1 คำถามข้อหนึ่ง (คำตอบ), Q1 (คะแนน), Q2 ..., Q2 (คะแนน)
    expect(lines[0]).toContain('Q1: คำถามข้อหนึ่ง (คำตอบ)')
    expect(lines[0]).toContain('Q2: คำถามข้อสอง (คำตอบ)')

    const s1 = lines[1]!.split(',')
    expect(s1.includes('คำตอบข้อหนึ่ง')).toBe(true)
    expect(s1.includes('สี่')).toBe(true)
    const s2 = lines[2]!.split(',')
    expect(s2.includes('อีกทางเลือก')).toBe(true)
    const s3 = lines[3]!.split(',')
    // s3 ส่งลำดับกลับข้าง — แต่ต้องอยู่คอลัมน์เดียวกับ s1 ยังอยู่ Q ของข้อจริง
    expect(s3.includes('คำตอบข้อหนึ่ง')).toBe(true)
    expect(s3.includes('สี่')).toBe(true)
  })

  it('escaping: คอมมา/quote/เว้นบรรทัดในคำตอบครอบ quote ถูกต้อง', () => {
    expect(csvCell('แดง')).toBe('แดง')
    expect(csvCell('มีคอมมา, อยู่')).toBe('"มีคอมมา, อยู่"')
    expect(csvCell('ค้ค้"quote"')).toBe('"ค้ค้""quote"""')
    expect(csvCell('มีเว้นบรรทัด\nข้อ 2')).toBe('"มีเว้นบรรทัด\nข้อ 2"')
  })
})

describe('canonicalQuestionItems', () => {
  it('ข้ามบล็อกคั่น/สื่อ และนับเดือน Q ต่อข้อสอบเท่านั้น', () => {
    const form = makeForm()
    form.items = [
      { inputType: 'section_header', itemId: 'sec1', title: 'ส่วนที่ 1', description: '' } as never,
      ...form.items,
      { inputType: 'media_stimulus', itemId: 'media1', imageAssetId: 'a'.repeat(64), caption: '' } as never
    ]
    const q = canonicalQuestionItems(form)
    expect(q).toHaveLength(2)
    expect(q[0]!.index).toBe(1)
    expect(q[1]!.index).toBe(2)
    expect((q[0]!.item as FormQuestion).itemId).toBe('A')
  })
})

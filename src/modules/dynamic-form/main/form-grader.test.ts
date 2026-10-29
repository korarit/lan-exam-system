import { describe, expect, it } from 'vitest'
import { evaluateSafeArithmetic, gradeAnsweredPoints } from '../shared/form-grading'
import type { FormQuestion, DynamicFormDefinition } from '../shared/form-schema'
import { gradeFormItem, summarizeGrading, type ItemGradeOutcome } from './form-grader'
import { runRegradeAllForRoom } from './form-host-service'

/* ชุดทดสอบ 7.2.1 / 7.2.2 / 7.2.3 ตามข้อกำหนด "Definition of Done" ของแผน */

const PARAM_A3B4C2 = { a: 3, b: 4, c: 2 }
const PARAM_A5B6C1 = { a: 5, b: 6, c: 1 }

function numericQuestion(): FormQuestion {
  return {
    itemId: 'q-n',
    prompt: '',
    points: 10,
    shuffleChoices: false,
    validation: { required: true },
    answerKey: { gradingType: 'numeric_formula', formulaOrValue: 'a * b + c', tolerance: 0.01 },
    unit: '',
    inputType: 'numeric_param'
  } as unknown as FormQuestion
}

describe('7.2.1 SafeMathEvaluator (โดยไม่ใช้ eval)', () => {
  it('โจทย์ a * b + c: นักเรียน A (3,4,2) = 14 และ B (5,6,1) = 31 แม่นยำตามตัวแปรรายคน', () => {
    expect(evaluateSafeArithmetic('a * b + c', PARAM_A3B4C2)).toBe(14)
    expect(evaluateSafeArithmetic('a * b + c', PARAM_A5B6C1)).toBe(31)
  })
  it('ฟังก์ชัน sqrt/sin/cos/abs/round/ln พร้อมวงเล็บ', () => {
    expect(evaluateSafeArithmetic('sqrt(a^2 + b^2)', { a: 3, b: 4 })).toBeCloseTo(5)
    expect(evaluateSafeArithmetic('abs(0 - 7)')).toBe(7)
    expect(evaluateSafeArithmetic('round(b / 2)', { a: 1, b: 5 })).toBe(3)
    expect(evaluateSafeArithmetic('ln(1)', {})).toBe(0)
    expect(evaluateSafeArithmetic('cos(0)', {})).toBeCloseTo(1)
    expect(evaluateSafeArithmetic('sin(0)', {})).toBeCloseTo(0)
  })
  it('ปฏิเสธชื่อที่ไม่อยู่ในชุดฟังก์ชัน (ต้องไม่ใช่ exec ทางลัด)', () => {
    expect(evaluateSafeArithmetic('eval("1")')).toBeNull()
  })
})

describe('7.2.2 Auto-Grading: checkbox partial-with-penalty', () => {
  const item: FormQuestion = {
    itemId: 'q-chk',
    prompt: 'เลือก',
    points: 10,
    validation: { required: true },
    answerKey: {
      gradingType: 'multi_choice',
      correctChoiceIds: ['c1', 'c2'],
      scoringMode: 'partial-with-penalty',
      penaltyPerWrongRatio: 0.5
    },
    inputType: 'checkbox_multi',
    choices: [
      { choiceId: 'c1', text: 'a' },
      { choiceId: 'c2', text: 'b' },
      { choiceId: 'c3', text: 'c' }
    ]
  } as unknown as FormQuestion

  it('เลือกถูก 2 ข้อแต่มีผิดติดมา 1 ข้อ  หักตามสัดส่วน (10*(2/2 - 0.5*1/2) = 7.5)', () => {
    const outcome = gradeFormItem({ item, value: { kind: 'multi', choiceIds: ['c1', 'c2', 'c3'] }, artifacts: [] })
    expect(outcome.earnedPoints).toBe(7.5)
    expect(outcome.status).toBe('auto-graded')
  })
  it('ไม่ติดลบต่ำกว่า 0 (clamp ที่ 0)', () => {
    const clamp = gradeAnsweredPoints(item, { choiceIds: ['c3'], fileNames: [] })
    expect(clamp.earnedPoints).toBeGreaterThanOrEqual(0)
  })
  it('all-or-nothing: เลือกถูก 2 ติด 1 ผิด  0 คะแนน', () => {
    const strict = { ...item, answerKey: { ...item.answerKey, scoringMode: 'all-or-nothing' } } as unknown as FormQuestion
    const outcome = gradeFormItem({ item: strict, value: { kind: 'multi', choiceIds: ['c1', 'c2', 'c3'] }, artifacts: [] })
    expect(outcome.earnedPoints).toBe(0)
  })
})

describe('7.2.2 numeric_formula ตัวแปรรายคน', () => {
  it('เฉลยคำนวณตามตัวแปรของนักเรียนแต่ละคน', () => {
    const item = numericQuestion()
    expect(gradeFormItem({ item, value: { kind: 'numeric', numeric: 14 }, artifacts: [], resolvedParameters: PARAM_A3B4C2 }).earnedPoints).toBe(10)
    expect(gradeFormItem({ item, value: { kind: 'numeric', numeric: 14 }, artifacts: [], resolvedParameters: PARAM_A5B6C1 }).earnedPoints).toBe(0)
    expect(gradeFormItem({ item, value: { kind: 'numeric', numeric: 31 }, artifacts: [], resolvedParameters: PARAM_A5B6C1 }).earnedPoints).toBe(10)
  })
})

describe('7.2.2 manual_rubric keyword scan', () => {
  const item: FormQuestion = {
    itemId: 'q-essay',
    prompt: 'อธิบาย',
    points: 10,
    validation: { required: true },
    answerKey: {
      gradingType: 'manual_rubric',
      expectedKeywords: ['encapsulation', 'inheritance', 'polymorphism']
    },
    inputType: 'long_text'
  } as unknown as FormQuestion

  it('สแกนหา keyword ให้ครูเห็น (พบ 2/3)', () => {
    const outcome = gradeFormItem({
      item,
      value: { kind: 'text', text: 'OOP มี encapsulation และ inheritance ช่วยจัดการ' },
      artifacts: []
    })
    expect(outcome.status).toBe('needs-manual')
    expect(outcome.keywordHits).toBe(2)
    expect(outcome.keywordTotal).toBe(3)
  })
})

describe('7.1.1 ผิดกฎ server-side  สถานะ invalid 0 คะแนน', () => {
  it('ค่าที่ไม่ใช่ตัวเลข', () => {
    const outcome = gradeFormItem({
      item: numericQuestion(),
      value: { kind: 'numeric', numeric: Number.NaN },
      artifacts: [],
      violations: [{ code: 'NOT_A_NUMBER', message: 'ต้องเป็นตัวเลขจริง' }]
    })
    expect(outcome.status).toBe('invalid')
    expect(outcome.earnedPoints).toBe(0)
  })
})

describe('7.2.3 regradeAllSubmissions (แก้เฉลย  ตรวจใหม่ทั้งห้อง)', () => {
  it('คำนวณใหม่จากคำตอบดิบ + ข้อที่ครูให้เอง (manual-graded) ไม่ถูกทับ', () => {
    const rows: Array<Record<string, unknown>> = [
      { roomId: 'r', studentId: 's1', itemId: 'q-n', status: 'auto-graded', earnedPoints: 0, manualPoints: null, violationsJson: '[]', value: { kind: 'numeric', numeric: 14 }, artifacts: [], journey: null, submittedAtMs: 1, revision: 0, updatedAtMs: 0 },
      { roomId: 'r', studentId: 's1', itemId: 'q-manual', status: 'manual-graded', earnedPoints: 3, manualPoints: 3, violationsJson: '[]', value: { kind: 'text', text: 'คำตอบ' }, artifacts: [], journey: null, submittedAtMs: 1, revision: 1, updatedAtMs: 0 },
      { roomId: 'r', studentId: 's2', itemId: 'q-n', status: 'auto-graded', earnedPoints: 10, manualPoints: null, violationsJson: '[]', value: { kind: 'numeric', numeric: 999 }, artifacts: [], journey: null, submittedAtMs: 1, revision: 0, updatedAtMs: 0 }
    ]
    const upserts: Array<{ studentId: string; itemId: string; earnedPoints: number; status: string }> = []
    const fakeStore = {
      listResponses: () => rows as never,
      upsert: (input: { studentId: string; itemId: string; earnedPoints: number; status: string; manualPoints: number | undefined }): void => {
        upserts.push({ studentId: input.studentId, itemId: input.itemId, earnedPoints: input.earnedPoints, status: input.status })
      }
    }
    const updatedForm: DynamicFormDefinition = {
      moduleId: 'dynamic-form',
      formId: '4f60a5a5-6a2b-4a5e-9f8a-000000000001',
      title: 'Regrade test',
      instructions: '',
      settings: { durationMinutes: 30, shuffleQuestionsPerStudent: false, navigationPolicy: 'strict-one-way', showScoreImmediatelyAfterSubmit: false },
      items: [
        numericQuestion(),
        {
          itemId: 'q-manual',
          prompt: 'อัตนัย',
          points: 5,
          validation: { required: true },
          answerKey: { gradingType: 'manual_rubric' },
          inputType: 'long_text'
        } as unknown as FormQuestion
      ]
    }
    const summary = runRegradeAllForRoom('r', updatedForm, fakeStore as never, {
      resolvedParametersFor: () => ({ 'q-n': PARAM_A3B4C2 })
    })
    expect(summary.students).toBe(2)
    expect(summary.changedItems).toBe(2)
    expect(summary.totalDeltaPoints).toBe(0)
    expect(upserts).toContainEqual({ studentId: 's1', itemId: 'q-n', earnedPoints: 10, status: 'auto-graded' })
    expect(upserts).toContainEqual({ studentId: 's2', itemId: 'q-n', earnedPoints: 0, status: 'auto-graded' })
    expect(upserts.some((u) => u.studentId === 's1' && u.itemId === 'q-manual')).toBe(false)
  })
})

describe('summarizeGrading', () => {
  it('รวม auto + manual และ percent', () => {
    const outcomes: ItemGradeOutcome[] = [
      { itemId: 'a', status: 'auto-graded', earnedPoints: 7, maxPoints: 10, violations: [] },
      { itemId: 'b', status: 'needs-manual', earnedPoints: 0, maxPoints: 10, violations: [] }
    ]
    const totals = summarizeGrading(outcomes, { b: 4 })
    expect(totals.totalPoints).toBe(11)
    expect(totals.maxPoints).toBe(20)
    expect(totals.percent).toBe(55)
  })
})

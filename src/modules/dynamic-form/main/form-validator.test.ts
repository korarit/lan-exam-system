import { describe, expect, it } from 'vitest'
import { validateServerAnswer } from './form-validator'
import type { FormItem } from '../shared/form-schema'

function mcqSingle(): FormItem {
  return {
    inputType: 'mcq_single',
    itemId: 'q1',
    prompt: 'เลือก',
    points: 1,
    shuffleChoices: false,
    choices: [
      { choiceId: 'a', text: 'A' },
      { choiceId: 'b', text: 'B' }
    ],
    validation: { required: true },
    answerKey: { gradingType: 'exact_choice', correctChoiceId: 'a' }
  }
}

describe('7.1.1 FormValidator (server-side)', () => {
  it('choiceId ที่ไม่มีอยู่จริง → INVALID_CHOICE', () => {
    const result = validateServerAnswer({ item: mcqSingle(), value: { kind: 'choice', choiceId: 'ghost' } })
    expect(result.some((v) => v.code === 'INVALID_CHOICE')).toBe(true)
  })
  it('ตอบครบช่องกริด → ผ่าน / ขาดแถว → INCOMPLETE_ROWS', () => {
    const grid: FormItem = {
      inputType: 'mcq_grid',
      itemId: 'q2',
      prompt: '',
      points: 2,
      shuffleChoices: false,
      rows: [
        { rowId: 'r1', label: 'เมืองหลวงไทย' },
        { rowId: 'r2', label: 'เมืองหลวงญี่ปุ่น' }
      ],
      columns: [
        { columnId: 'c1', label: 'กรุงเทพฯ' },
        { columnId: 'c2', label: 'โตเกียว' }
      ],
      validation: { required: true },
      answerKey: { gradingType: 'grid_match', rowAnswerMap: { r1: 'c1', r2: 'c2' }, pointsPerRow: 1 }
    }
    expect(validateServerAnswer({ item: grid, value: { kind: 'rows', rowAnswers: { r1: 'c1', r2: 'c2' } } })).toHaveLength(0)
    const missing = validateServerAnswer({ item: grid, value: { kind: 'rows', rowAnswers: { r1: 'c1' } } })
    expect(missing.some((v) => v.code === 'INCOMPLETE_ROWS')).toBe(true)
    const wrongColumn = validateServerAnswer({ item: grid, value: { kind: 'rows', rowAnswers: { r1: 'zz', r2: 'c2' } } })
    expect(wrongColumn.some((v) => v.code === 'INVALID_COLUMN')).toBe(true)
  })
  it('คำตอบคนละชนิดกับข้อ → VALUE_TYPE_MISMATCH', () => {
    const mismatch = validateServerAnswer({ item: mcqSingle(), value: { kind: 'multi', choiceIds: ['a'] } })
    expect(mismatch.some((v) => v.code === 'VALUE_TYPE_MISMATCH')).toBe(true)
  })
  it('checkbox min/max + ตัวเลือกปลอม', () => {
    const item: FormItem = {
      inputType: 'checkbox_multi',
      itemId: 'q3',
      prompt: '',
      points: 3,
      shuffleChoices: false,
      choices: [
        { choiceId: 'a', text: '1' },
        { choiceId: 'b', text: '2' },
        { choiceId: 'c', text: '3' }
      ],
      validation: { required: true, minSelect: 1, maxSelect: 2 },
      answerKey: { gradingType: 'multi_choice', correctChoiceIds: ['a'], scoringMode: 'all-or-nothing', penaltyPerWrongRatio: 0.5 }
    }
    expect(validateServerAnswer({ item, value: { kind: 'multi', choiceIds: ['a'] } })).toHaveLength(0)
    expect(
      validateServerAnswer({ item, value: { kind: 'multi', choiceIds: ['a', 'b', 'c'] } }).some((v) => v.code === 'MAX_SELECT')
    ).toBe(true)
    expect(validateServerAnswer({ item, value: { kind: 'multi', choiceIds: ['zz'] } }).some((v) => v.code === 'INVALID_CHOICE')).toBe(true)
  })
  it('short_text: ความยาว/คำ/regex', () => {
    const item: FormItem = {
      inputType: 'short_text',
      itemId: 'q4',
      prompt: '',
      points: 1,
      shuffleChoices: false,
      validation: { required: true, minLength: 3, maxLength: 6, regexPattern: '^[0-9]+$' },
      answerKey: { gradingType: 'ungraded' }
    }
    expect(validateServerAnswer({ item, value: { kind: 'text', text: '123' } })).toHaveLength(0)
    expect(validateServerAnswer({ item, value: { kind: 'text', text: '12' } }).some((v) => v.code === 'MIN_LENGTH')).toBe(true)
    expect(validateServerAnswer({ item, value: { kind: 'text', text: '12345678' } }).some((v) => v.code === 'MAX_LENGTH')).toBe(true)
    expect(validateServerAnswer({ item, value: { kind: 'text', text: 'abc' } }).some((v) => v.code === 'PATTERN_MISMATCH')).toBe(true)
  })
  it('linear_scale อยู่ในช่วง', () => {
    const item: FormItem = {
      inputType: 'linear_scale',
      itemId: 'q5',
      prompt: '',
      points: 1,
      shuffleChoices: false,
      scaleMin: 1,
      scaleMax: 5,
      validation: { required: true },
      answerKey: { gradingType: 'ungraded' }
    }
    expect(validateServerAnswer({ item, value: { kind: 'scale', value: 5 } })).toHaveLength(0)
    expect(validateServerAnswer({ item, value: { kind: 'scale', value: 9 } }).some((v) => v.code === 'SCALE_OUT_OF_RANGE')).toBe(true)
  })
  it('file_upload: นามสกุล/ขนาด/จำนวน', () => {
    const item: FormItem = {
      inputType: 'file_upload',
      itemId: 'q6',
      prompt: '',
      points: 1,
      shuffleChoices: false,
      acceptMultiple: false,
      validation: { required: true, allowedExtensions: ['.py'], maxFileSizeBytes: 10 },
      answerKey: { gradingType: 'manual_rubric' }
    }
    expect(
      validateServerAnswer({
        item,
        value: { kind: 'files', artifactIds: ['ar1'] },
        artifacts: { ar1: { artifactId: 'ar1', fileName: 'main.py', mimeType: 'text/x-python', sizeBytes: 9, sha256: 'a'.repeat(64) } }
      })
    ).toHaveLength(0)
    expect(
      validateServerAnswer({
        item,
        value: { kind: 'files', artifactIds: ['ar1', 'ar2'] },
        artifacts: {
          ar1: { artifactId: 'ar1', fileName: 'main.py', mimeType: 'text/x-python', sizeBytes: 1, sha256: 'a'.repeat(64) },
          ar2: { artifactId: 'ar2', fileName: 'b.py', mimeType: 'text/x-python', sizeBytes: 1, sha256: 'b'.repeat(64) }
        }
      }).some((v) => v.code === 'TOO_MANY_FILES')
    ).toBe(true)
    expect(
      validateServerAnswer({
        item,
        value: { kind: 'files', artifactIds: ['ar1'] },
        artifacts: { ar1: { artifactId: 'ar1', fileName: 'evil.exe', mimeType: 'application/x-msdownload', sizeBytes: 1, sha256: 'a'.repeat(64) } }
      }).some((v) => v.code === 'FILE_EXTENSION_BLOCKED')
    ).toBe(true)
  })
})

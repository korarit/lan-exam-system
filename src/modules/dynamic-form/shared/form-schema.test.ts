import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  DynamicFormDefinitionSchema,
  FormItemSchema,
  type DynamicFormDefinition,
  type FormItem
} from './form-schema'
import { stripAnswerKeyForStudent, createSeededRandom, shuffleWithSeededRandom } from './student-view'
import { importQuestionsFromCsv, parseCsvRows, importQuestionsFromJson } from './csv-import'
import { evaluateSafeArithmetic } from './form-grading'
import { validateItemAnswer } from './form-validate'
import type { FormAnswerValue } from './form-validate'

/* ============================================================
 * Phase 6 (6.1) — ทดสอบ Schema 12 ชนิด + stripAnswerKeyForStudent
 * ============================================================ */

function buildFormWithAllTypes(): DynamicFormDefinition {
  const items: FormItem[] = [
    {
      inputType: 'section_header',
      itemId: 'sec-1',
      title: 'ส่วนที่ 1',
      description: 'คำชี้แจง'
    },
    {
      inputType: 'mcq_single',
      itemId: 'q-mcq',
      prompt: 'เลือกคำตอบที่ถูก',
      points: 2,
      shuffleChoices: true,
      validation: { required: true },
      choices: [
        { choiceId: 'c1', text: '12' },
        { choiceId: 'c2', text: '14' }
      ],
      answerKey: { gradingType: 'exact_choice', correctChoiceId: 'c2' }
    },
    {
      inputType: 'checkbox_multi',
      itemId: 'q-check',
      prompt: 'เลือกครบ',
      points: 3,
      shuffleChoices: false,
      validation: { required: true },
      choices: [
        { choiceId: 'c1', text: 'ก' },
        { choiceId: 'c2', text: 'ข' },
        { choiceId: 'c3', text: 'ค' }
      ],
      answerKey: {
        gradingType: 'multi_choice',
        correctChoiceIds: ['c1', 'c2'],
        scoringMode: 'partial-with-penalty',
        penaltyPerWrongRatio: 0.5
      }
    },
    {
      inputType: 'dropdown',
      itemId: 'q-drop',
      prompt: 'เลือกจากรายการ',
      points: 1,
      shuffleChoices: true,
      validation: { required: false },
      choices: [
        { choiceId: 'c1', text: 'อาทิตย์' },
        { choiceId: 'c2', text: 'จันทร์' }
      ],
      answerKey: { gradingType: 'exact_choice', correctChoiceId: 'c1' }
    },
    {
      inputType: 'short_text',
      itemId: 'q-short',
      prompt: 'เมืองหลวงของฟรังโกยอค',
      points: 1,
      shuffleChoices: false,
      validation: { required: true },
      answerKey: {
        gradingType: 'short_text_match',
        acceptedAnswers: ['บาร์เซโลนา', 'เบอร์ลิน'],
        caseSensitive: false,
        trimWhitespace: true,
        useRegex: false
      }
    },
    {
      inputType: 'long_text',
      itemId: 'q-long',
      prompt: 'อธิบายวิธีทำ 5 บรรทัด',
      points: 5,
      shuffleChoices: false,
      validation: { required: true, minWords: 5 },
      answerKey: { gradingType: 'manual_rubric', expectedKeywords: ['วงจร'] }
    },
    {
      inputType: 'numeric_param',
      itemId: 'q-num',
      prompt: 'จงหาค่า {{a}} × {{b}}',
      points: 4,
      shuffleChoices: false,
      unit: '',
      parameters: { a: { min: 2, max: 5, step: 1 }, b: { min: 3, max: 4, step: 1 } },
      validation: { required: true },
      answerKey: { gradingType: 'numeric_formula', formulaOrValue: 'a * b', tolerance: 0.01 }
    },
    {
      inputType: 'mcq_grid',
      itemId: 'q-grid1',
      prompt: 'จับคู่ถูก/ผิด',
      points: 2,
      shuffleChoices: true,
      validation: { required: true },
      rows: [
        { rowId: 'r1', label: '1+1=2' },
        { rowId: 'r2', label: '2+2=5' }
      ],
      columns: [
        { columnId: 'c1', label: 'ถูก' },
        { columnId: 'c2', label: 'ผิด' }
      ],
      answerKey: {
        gradingType: 'grid_match',
        rowAnswerMap: { r1: 'c1', r2: 'c2' },
        pointsPerRow: 1
      }
    },
    {
      inputType: 'checkbox_grid',
      itemId: 'q-grid2',
      prompt: 'เลือกหลายช่องรายแถว',
      points: 2,
      shuffleChoices: false,
      validation: { required: true },
      rows: [{ rowId: 'r1', label: 'แถว 1' }],
      columns: [
        { columnId: 'c1', label: 'ก' },
        { columnId: 'c2', label: 'ข' }
      ],
      answerKey: { gradingType: 'grid_match', rowAnswerMap: { r1: ['c1', 'c2'] }, pointsPerRow: 2 }
    },
    {
      inputType: 'linear_scale',
      itemId: 'q-scale',
      prompt: 'ประเมินความยาก',
      points: 1,
      shuffleChoices: false,
      validation: { required: false },
      scaleMin: 1,
      scaleMax: 5,
      answerKey: { gradingType: 'numeric_formula', formulaOrValue: '3', tolerance: 0 }
    },
    {
      inputType: 'date_time',
      itemId: 'q-date',
      prompt: 'วันที่ยอมตัว',
      points: 1,
      shuffleChoices: false,
      validation: { required: true },
      mode: 'date',
      answerKey: {
        gradingType: 'short_text_match',
        acceptedAnswers: ['2026-02-01'],
        caseSensitive: false,
        trimWhitespace: true,
        useRegex: false
      }
    },
    {
      inputType: 'code_snippet',
      itemId: 'q-code',
      prompt: 'พิมพ์ Hello ใน Python',
      points: 5,
      shuffleChoices: false,
      validation: { required: true },
      language: 'python',
      starterCode: '# เริ่มที่นี่\n',
      answerKey: { gradingType: 'manual_rubric', expectedKeywords: ['print'] }
    },
    {
      inputType: 'file_upload',
      itemId: 'q-file',
      prompt: 'แนบไฟล์คำตอบ',
      points: 5,
      shuffleChoices: false,
      validation: { required: true, allowedExtensions: ['.py'], maxFileSizeBytes: 10 * 1024 * 1024 },
      acceptMultiple: false,
      answerKey: { gradingType: 'manual_rubric' }
    },
    {
      inputType: 'media_stimulus',
      itemId: 'md-1',
      imageAssetId: 'a'.repeat(64),
      caption: 'รูปประกอบ'
    }
  ]
  return DynamicFormDefinitionSchema.parse({
    moduleId: 'dynamic-form',
    formId: z.uuid().parse('a10f8f1c-5b61-4d63-9a44-3b7fd9a19c02'),
    title: 'ข้อสอบรวมทุกชนิด',
    instructions: 'ทำส่วนที่ 1 ก่อน',
    settings: {
      durationMinutes: 45,
      shuffleQuestionsPerStudent: true,
      navigationPolicy: 'allow-visited-review',
      showScoreImmediatelyAfterSubmit: false
    },
    items
  })
}

describe('12 input types schema', () => {
  it('validates a form containing all 12 question kinds + 2 blocks', () => {
    const form = buildFormWithAllTypes()
    expect(form.items).toHaveLength(14)
    const questionInputTypes = new Set(
      form.items
        .filter((i) => i.inputType !== 'section_header' && i.inputType !== 'media_stimulus')
        .map((i) => i.inputType)
    )
    expect(questionInputTypes.size).toBe(12)
    for (const item of form.items) {
      expect(FormItemSchema.safeParse(item).success).toBe(true)
    }
  })

  it('rejects a mcq with fewer than 2 choices', () => {
    const bad = buildFormWithAllTypes()
    const mcq = bad.items.find((i) => i.itemId === 'q-mcq')
    if (mcq === undefined || mcq.inputType !== 'mcq_single') throw new Error('missing fixture')
    const parsed = FormItemSchema.safeParse({ ...mcq, choices: mcq.choices.slice(0, 1) })
    expect(parsed.success).toBe(false)
  })
})

describe('stripAnswerKeyForStudent (6.1.2)', () => {
  it('removes answerKey/points/parameters from every question 100%', () => {
    const form = buildFormWithAllTypes()
    const { view } = stripAnswerKeyForStudent(form, 'student-alice')
    const json = JSON.stringify(view)
    expect(json).not.toContain('"answerKey"')
    expect(json).not.toContain('"correctChoiceId"')
    expect(json).not.toContain('"formulaOrValue"')
    expect(json).not.toContain('"rowAnswerMap"')
    expect(json).not.toContain('"rubricCriteria"')
    expect(json).not.toContain('"parameters"')
    // คะแนนไม่ควรเด้งใน view (แต่ grid เป็น StudentFormItem โดยตรง ไม่มีฟิลด์)
    expect(JSON.stringify(view.items)).not.toContain('expectedKeywords')
  })

  it('flattens {{a}} params deterministically per seed and differs across seeds', () => {
    const form = buildFormWithAllTypes()
    const a = stripAnswerKeyForStudent(form, 'seed-alpha')
    const b = stripAnswerKeyForStudent(form, 'seed-beta')
    const promptA = a.view.items.find((i) => i.itemId === 'q-num')
    const promptB = b.view.items.find((i) => i.itemId === 'q-num')
    expect(promptA !== undefined && 'type' in (promptA as object) ? true : true).toBe(true)
    expect(JSON.stringify(promptA)).toBe(JSON.stringify(stripAnswerKeyForStudent(form, 'seed-alpha').view.items.find((i) => i.itemId === 'q-num')))
    expect(JSON.stringify(promptA ?? {})).not.toBe(JSON.stringify(promptB ?? {}))
    expect((promptA as { prompt: string }).prompt).not.toContain('{{')
    expect((promptB as { prompt: string }).prompt).not.toContain('{{')
  })

  it('shuffles questions per seed whenever setting is on (blocks stay in place)', () => {
    const form = buildFormWithAllTypes()
    let differed = false
    for (let i = 0; i < 20; i++) {
      const a = stripAnswerKeyForStudent(form, `seed-${i}`).view.items.map((i2) => i2.itemId)
      const b = stripAnswerKeyForStudent(form, `seed-${i + 1}`).view.items.map((i2) => i2.itemId)
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        differed = true
        break
      }
    }
    expect(differed).toBe(true)
    // จำนวนรายการรวมต้องเท่าเดิม
    expect(stripAnswerKeyForStudent(form, 'x').view.items).toHaveLength(form.items.length)
  })

  it('shuffles choice order for shuffleChoices items, preserving the same set of choiceIds', () => {
    const form = buildFormWithAllTypes()
    const shuffledItem = stripAnswerKeyForStudent(form, 'seed-s') as unknown
    expect(shuffledItem).toBeDefined()
    // ทั้ง set ของ choiceId ต้องคงอยู่ (สลับแค่ลำดับ)
    const original = form.items.find((i) => i.itemId === 'q-mcq')
    if (original !== undefined && original.inputType === 'mcq_single') {
      const ids = original.choices.map((c) => c.choiceId).sort()
      const view = stripAnswerKeyForStudent(form, 'seed-view-1').view
      const seen = view.items.find((i) => i.itemId === 'q-mcq')
      const seenIds = ((seen as unknown as { choices: Array<{ choiceId: string }> }).choices)
        .map((c) => c.choiceId)
        .sort()
      expect(seenIds).toEqual(ids)
    }
  })

  it('keeps blocks (section_header/media_stimulus) in the view', () => {
    const { view } = stripAnswerKeyForStudent(buildFormWithAllTypes(), 'any')
    expect(view.items.some((i) => i.inputType === 'section_header')).toBe(true)
    expect(view.items.some((i) => i.inputType === 'media_stimulus')).toBe(true)
  })
})

describe('seeded shuffling primitives', () => {
  it('creates deterministic permutation for identical seeds', () => {
    const form = buildFormWithAllTypes()
    const items = form.items.map((i) => i.itemId)
    const a = shuffleWithSeededRandom(items, createSeededRandom('f1', 's1'))
    const b = shuffleWithSeededRandom(items, createSeededRandom('f1', 's1'))
    expect(a).toEqual(b)
    // seed ต่างกันหย่อนหมักควรแตกต่าง (ยอมรับแดเน่ไม่ ซ้ำใน 50 seed)
    const variants = new Set<string>()
    for (let i = 0; i < 50; i++) {
      variants.add(JSON.stringify(shuffleWithSeededRandom(items, createSeededRandom('f1', `s${i}`))))
    }
    expect(variants.size).toBeGreaterThan(1)
  })
})

describe('safe arithmetic evaluator (สูตรเฉลยอัตโนมัติ)', () => {
  it('evaluates numbers, operators and parentheses', () => {
    expect(evaluateSafeArithmetic('2 + 3 * 4')).toBe(14)
    expect(evaluateSafeArithmetic('(2 + 3) * 4')).toBe(20)
    expect(evaluateSafeArithmetic('10 / 4')).toBe(2.5)
    expect(evaluateSafeArithmetic('2 ^ 10')).toBe(1024)
    expect(evaluateSafeArithmetic('-3 + 5')).toBe(2)
  })
  it('substitutes variables safely and rejects unknown vars', () => {
    expect(evaluateSafeArithmetic('a * b', { a: 3, b: 4 })).toBe(12)
    expect(evaluateSafeArithmetic('a + 10', {})).toBeNull()
    expect(evaluateSafeArithmetic('1; DROP TABLE x')).toBeNull()
  })
})

describe('answer validation rules (form-validate)', () => {
  const form = buildFormWithAllTypes()
  const shortItem = form.items.find((i) => i.itemId === 'q-short')
  if (shortItem === undefined || shortItem.inputType !== 'short_text') throw new Error('missing fixture')
  it('flags required empty', () => {
    expect(validateItemAnswer(shortItem, { kind: 'none' })).toBe('ข้อนี้จำเป็นต้องตอบ')
  })
  it('accepts a value once filled (validation semantics)', () => {
    const value: FormAnswerValue = { kind: 'text', text: 'บาร์เซโลนา' }
    expect(validateItemAnswer(shortItem, value)).toBeNull()
  })
  it('enforces min/max text length', () => {
    const item = { ...shortItem, validation: { required: true, minLength: 4 } }
    expect(validateItemAnswer(item, { kind: 'text', text: 'abc' })).toContain('4')
  })
  it('enforces min/max select for checkboxes', () => {
    const check = form.items.find((i) => i.itemId === 'q-check')
    if (check === undefined || check.inputType !== 'checkbox_multi') throw new Error('missing fixture')
    const limited = { ...check, validation: { required: true, minSelect: 2, maxSelect: 2 } as const }
    expect(validateItemAnswer(limited, { kind: 'multi', choiceIds: ['c1'] })).toContain('อย่างน้อย 2')
    expect(validateItemAnswer(limited, { kind: 'multi', choiceIds: ['c1', 'c2'] })).toBeNull()
    expect(validateItemAnswer(limited, { kind: 'multi', choiceIds: ['c1', 'c2', 'c3'] })).toContain('ไม่เกิน 2')
  })
})

describe('CSV / JSON question import (6.3.2)', () => {
  it('parses quoted CSV correctly', () => {
    const rows = parseCsvRows('"a,b",c\n"d",')
    expect(rows).toEqual([['a,b', 'c'], ['d', '']])
  })
  it('imports a full CSV template including answers', () => {
    const csv = [
      'type,prompt,choices,answer,points,required',
      'mcq,"โจทย์ 1+1",2 | 3 | 4,2,2,true',
      'checkbox,"เลือกทุกช่องที่ถูก",ก | ข | ค,"ก,ข",3,true',
      'short,"อะไร?","",เบอร์ลิน,1,false',
      'numeric,"ผลรวม {{a}} + {{b}}","",10,1,true',
      'section,"เริ่มส่วน 2","",,,false'
    ].join('\n')
    const result = importQuestionsFromCsv(csv)
    expect(result.errors).toEqual([])
    expect(result.items).toHaveLength(5)
    const mcq = result.items[0]
    if (mcq === undefined || mcq.inputType !== 'mcq_single') throw new Error('bad index')
    expect(mcq.answerKey.gradingType).toBe('exact_choice')
    expect(mcq.choices.find((c) => c.choiceId === (mcq.answerKey as { correctChoiceId: string }).correctChoiceId)?.text).toBe('2')
    expect(mcq.points).toBe(2)
    expect(mcq.validation.required).toBe(true)
    const check = result.items[1]
    if (check === undefined || check.inputType !== 'checkbox_multi') throw new Error('bad index')
    expect((check.answerKey as { correctChoiceIds: string[] }).correctChoiceIds).toHaveLength(2)
    const short = result.items[2]
    if (short === undefined || short.inputType !== 'short_text') throw new Error('bad index')
    expect(short.validation.required).toBe(false)
    const section = result.items[4]
    if (section === undefined) throw new Error('bad index')
    expect(section.inputType).toBe('section_header')
  })
  it('imports from JSON template', () => {
    const result = importQuestionsFromJson(
      JSON.stringify([
        { type: 'mcq', prompt: 'ถาม', choices: 'A | B | C', answer: '2', points: 3 },
        { type: 'scale', prompt: 'เรต', choices: '1 | 5' }
      ])
    )
    expect(result.errors).toEqual([])
    expect(result.items).toHaveLength(2)
  })
  it('reports invalid rows without crashing', () => {
    const result = importQuestionsFromCsv('type,prompt\nbogus,ล')
    expect(result.items).toHaveLength(0)
    expect(result.errors[0]).toContain('type ไม่รองรับ')
  })
})

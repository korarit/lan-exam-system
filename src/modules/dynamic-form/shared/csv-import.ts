import { z } from 'zod'
import {
  FormChoiceSchema,
  GridColumnSchema,
  GridRowSchema,
  type AnswerKey,
  type FormItem
} from './form-schema'

/* ============================================================
 * Phase 6 (6.3.2) — นำเข้าคำถามจาก CSV / JSON Template
 * CSV: type,prompt,choices,answer,points,required
 *   - choices เขียนต่อกันใน 1 ช่อง แยกด้วย " | "
 *   - answer: เลือกเดียว/ดรอปดาวน์ = ข้อความหรือเลขตำแหน่ง (1-based),
 *     checkbox = คั่นด้วยเครื่องหมาย , ; หรือ | / ข้อความ,
 *     short/numeric/date/time = ค่าเฉลย, ปล่อยว่าง = ยังไม่ตั้งเฉลย
 * JSON: [&]( { type, prompt, choices?, answer?, points? } )
 * ============================================================ */

const CSV_TYPE_ALIASES: Record<string, FormItem['inputType']> = {
  mcq: 'mcq_single',
  'mcq_single': 'mcq_single',
  radio: 'mcq_single',
  single: 'mcq_single',
  checkbox: 'checkbox_multi',
  checks: 'checkbox_multi',
  multi: 'checkbox_multi',
  dropdown: 'dropdown',
  select: 'dropdown',
  short: 'short_text',
  short_text: 'short_text',
  shorttext: 'short_text',
  long: 'long_text',
  paragraph: 'long_text',
  long_text: 'long_text',
  essay: 'long_text',
  number: 'numeric_param',
  numeric: 'numeric_param',
  numeric_param: 'numeric_param',
  grid: 'mcq_grid',
  mcq_grid: 'mcq_grid',
  checkbox_grid: 'checkbox_grid',
  scale: 'linear_scale',
  linear_scale: 'linear_scale',
  date: 'date_time',
  time: 'date_time',
  date_time: 'date_time',
  datetime: 'date_time',
  code: 'code_snippet',
  code_snippet: 'code_snippet',
  file: 'file_upload',
  upload: 'file_upload',
  file_upload: 'file_upload',
  section: 'section_header',
  section_header: 'section_header',
  media: 'media_stimulus',
  media_stimulus: 'media_stimulus'
}

export interface ImportResult {
  items: FormItem[]
  errors: string[]
}

interface RawQuestionRow {
  type: string
  prompt: string
  choices: string
  answer: string
  points: string
  required: string
  detail: string
}

/* ---------- CSV Parser (RFC-4180-ish) ---------- */

export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      continue
    }
    if (ch === '\r') continue
    field += ch
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0))
}

/* ---------- ตัวเลือกชนิดของ CSV (CSV_TYPE_ALIASES) ---------- */

/** นำเข้าจากข้อความ CSV — คืนข้อความ error รายบรรทัดหากไม่เข้ากัน */
export function importQuestionsFromCsv(text: string): ImportResult {
  const rows = parseCsvRows(text)
  if (rows.length === 0) return { items: [], errors: ['ไฟล์ CSV ว่าง'] }
  const header = rows[0]!.map((h) => h.trim().toLowerCase())
  const findCol = (name: string): number => header.findIndex((h) => h === name)
  const typeCol = findCol('type')
  const promptCol = findCol('prompt')
  const choicesCol = findCol('choices')
  const answerCol = findCol('answer')
  const pointsCol = findCol('points')
  const requiredCol = findCol('required')
  const detailCol = findCol('detail')
  if (typeCol < 0 || promptCol < 0) {
    return { items: [], errors: ['ต้องมีคอลัมน์อย่างน้อย: type, prompt'] }
  }
  const items: FormItem[] = []
  const errors: string[] = []
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!
    const row: RawQuestionRow = {
      type: (cells[typeCol] ?? '').trim(),
      prompt: (cells[promptCol] ?? '').trim(),
      choices: (cells[choicesCol] ?? '').trim(),
      answer: (cells[answerCol] ?? '').trim(),
      points: (cells[pointsCol] ?? '').trim(),
      required: (cells[requiredCol] ?? '').trim(),
      detail: (cells[detailCol] ?? '').trim()
    }
    const excelRow = r + 1
    try {
      items.push(...buildItemsFromRow(row))
    } catch (err) {
      errors.push(`แถวที่ ${excelRow}: ${err instanceof Error ? err.message : 'ไม่ทราบสาเหตุ'}`)
    }
  }
  return { items, errors }
}

function buildItemsFromRow(row: RawQuestionRow): FormItem[] {
  const typeRaw = row.type.toLowerCase().trim()
  const inputType = CSV_TYPE_ALIASES[typeRaw]
  if (inputType === undefined) throw new Error(`type ไม่รองรับ: "${row.type}"`)
  const itemId = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const points = row.points.length > 0 ? Number(row.points) : 1
  if (!Number.isFinite(points) || points <= 0) throw new Error(`points ต้องเป็นเลขมากกว่า 0`)
  const required = !(row.required.toLowerCase() === 'false' || row.required === 'no' || row.required === '0')

  if (inputType === 'section_header') {
    return [
      {
        inputType: 'section_header',
        itemId,
        title: row.prompt || 'หัวข้อใหม่',
        description: row.detail || ''
      }
    ]
  }
  if (inputType === 'media_stimulus') {
    throw new Error('media_stimulus ต้องแนบรูปเองในหน้าสร้าง (CSV ใส่ tag ไม่ได้)')
  }

  const base = {
    itemId,
    prompt: row.prompt,
    points,
    shuffleChoices: false,
    validation: { required }
  }
  const choiceTexts = row.choices
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
  const answerText = row.answer

  switch (inputType) {
    case 'mcq_single':
    case 'dropdown':
    case 'checkbox_multi': {
      if (choiceTexts.length < 2) throw new Error('type นี้ต้องมีตัวเลือกชั้นน้อย 2 ข้อ (choices คั่นด้วย |)')
      const choices = choiceTexts.map((text, idx) => FormChoiceSchema.parse({ choiceId: `c${idx + 1}`, text }))
      let answerKey: AnswerKey
      if (inputType === 'checkbox_multi') {
        const selected = new Set(
          answerText
            .split(/[,;|]+/)
            .map((a) => resolveChoiceAnswer(a, choiceTexts))
            .filter((s): s is string => s !== null)
        )
        answerKey =
          selected.size > 0
            ? {
                gradingType: 'multi_choice' as const,
                correctChoiceIds: choices.filter((c) => selected.has(c.text)).map((c) => c.choiceId),
                scoringMode: 'all-or-nothing' as const,
                penaltyPerWrongRatio: 0.5
              }
            : { gradingType: 'ungraded' as const }
      } else {
        const correctText = resolveChoiceAnswer(answerText, choiceTexts)
        const correct = correctText !== null ? choices.find((c) => c.text === correctText) : undefined
        answerKey = correct
          ? { gradingType: 'exact_choice' as const, correctChoiceId: correct.choiceId }
          : { gradingType: 'ungraded' as const }
      }
      return [
        {
          inputType,
          itemId,
          prompt: row.prompt,
          points,
          shuffleChoices: false,
          validation: { required },
          choices,
          answerKey
        } as FormItem
      ]
    }
    case 'short_text': {
      const answerKey: AnswerKey =
        answerText.length > 0
          ? {
              gradingType: 'short_text_match',
              acceptedAnswers: answerText.split('|').map((a) => a.trim()).filter((a) => a.length > 0),
              caseSensitive: false,
              trimWhitespace: true,
              useRegex: false
            }
          : { gradingType: 'ungraded' }
      return [{ ...base, inputType, answerKey } as FormItem]
    }
    case 'numeric_param': {
      const answerKey: AnswerKey =
        answerText.length > 0
          ? { gradingType: 'numeric_formula', formulaOrValue: answerText, tolerance: 0.01 }
          : { gradingType: 'ungraded' as const }
      return [{ ...base, inputType, unit: row.detail || '', answerKey } as FormItem]
    }
    case 'linear_scale': {
      const parts = row.choices.split('|').map((n) => Number(n.trim()))
      const minVal = parts[0]
      const maxVal = parts[1]
      return [
        {
          inputType,
          itemId,
          prompt: row.prompt,
          points,
          shuffleChoices: false,
          validation: { required },
          scaleMin: minVal !== undefined && Number.isFinite(minVal) ? Math.max(0, Math.trunc(minVal)) : 1,
          scaleMax: maxVal !== undefined && Number.isFinite(maxVal) ? Math.max(1, Math.trunc(maxVal)) : 5,
          answerKey: answerText.length > 0 && Number.isFinite(Number(answerText))
            ? { gradingType: 'numeric_formula', formulaOrValue: answerText, tolerance: 0 }
            : { gradingType: 'ungraded' }
        } as FormItem
      ]
    }
    case 'date_time': {
      const mode = ['time', 'datetime'].includes(typeRaw) ? (typeRaw as 'time' | 'datetime') : 'date'
      return [
        {
          inputType,
          itemId,
          prompt: row.prompt,
          points,
          shuffleChoices: false,
          validation: { required },
          mode,
          answerKey: answerText.length > 0
            ? {
                gradingType: 'short_text_match',
                acceptedAnswers: [answerText],
                caseSensitive: false,
                trimWhitespace: true,
                useRegex: false
              }
            : { gradingType: 'ungraded' }
        } as FormItem
      ]
    }
    case 'long_text':
    case 'code_snippet': {
      return [
        {
          inputType,
          itemId,
          prompt: row.prompt,
          points,
          shuffleChoices: false,
          validation: { required },
          ...(inputType === 'code_snippet' ? { language: 'python' as const, starterCode: row.detail || '' } : {}),
          answerKey:
            answerText.length > 0
              ? ({ gradingType: 'manual_rubric' as const, teacherReferenceNote: answerText } as AnswerKey)
              : ({ gradingType: 'manual_rubric' as const } as AnswerKey)
        } as FormItem
      ]
    }
    case 'file_upload': {
      return [
        {
          inputType,
          itemId,
          prompt: row.prompt,
          points,
          shuffleChoices: false,
          validation: {
            required,
            allowedExtensions: answerText.length > 0
              ? answerText.split('|').map((e) => (e.startsWith('.') ? e : `.${e}`)).slice(0, 20)
              : undefined,
            maxFileSizeBytes: 10 * 1024 * 1024
          },
          acceptMultiple: false,
          answerKey: { gradingType: 'manual_rubric' }
        } as FormItem
      ]
    }
    case 'mcq_grid':
    case 'checkbox_grid': {
      if (choiceTexts.length < 3) throw new Error('grid ต้องใส่ row1|row2|...|col-option อย่างน้อย 3 ชิ้น')
      const rowsPart = choiceTexts.slice(0, -1)
      const columnsPart = choiceTexts[choiceTexts.length - 1]?.split(';').map((c) => c.trim()).filter((c) => c.length > 0) ?? []
      if (columnsPart.length < 2) throw new Error('คอลัมน์ของ grid ต้องมีชั้นน้อย 2 ค่า คั่นด้วย ; ในชื่อตัวเลือกชิ้นสุดท้าย')
      const rows = rowsPart.map((label, idx) => GridRowSchema.parse({ rowId: `r${idx + 1}`, label }))
      const columns = columnsPart.map((label, idx) => GridColumnSchema.parse({ columnId: `c${idx + 1}`, label }))
      const rowAnswerMap: Record<string, string | string[]> = {}
      if (answerText.length > 0) {
        const perRow = answerText.split('|')
        rows.forEach((rowDef, idx) => {
          const cell = (perRow[idx] ?? '').trim()
          if (cell.length === 0) return
          if (inputType === 'checkbox_grid') {
            rowAnswerMap[rowDef.rowId] = cell.split(';').map((c) => c.trim()).filter((c) => c.length > 0)
          } else {
            rowAnswerMap[rowDef.rowId] = cell
          }
        })
      }
      const answerKey: AnswerKey =
        answerText.length > 0
          ? {
              gradingType: 'grid_match',
              rowAnswerMap,
              pointsPerRow: Math.max(0.1, points / Math.max(1, rows.length))
            }
          : { gradingType: 'manual_rubric' }
      return [
        {
          inputType,
          itemId,
          prompt: row.prompt,
          points,
          shuffleChoices: false,
          validation: { required },
          rows,
          columns,
          answerKey
        } as FormItem
      ]
    }
    default:
      throw new Error('type แปลก (fallback ไม่รองรับ)')
  }
}

function resolveChoiceAnswer(answerText: string, choiceTexts: string[]): string | null {
  const t = answerText.trim()
  if (t.length === 0) return null
  // เทียบข้อความตรงก่อน (เช่นเฉลยคือตัวเลือก "2") ก่อนตีความเป็นเลขตำแหน่ง
  if (choiceTexts.includes(t)) return t
  const idx = Number(t)
  if (Number.isInteger(idx) && idx >= 1 && idx <= choiceTexts.length) {
    return choiceTexts[idx - 1] ?? null
  }
  return t
}

/* ---------- JSON Template ---------- */

const JsonImportItemSchema = z.object({
  type: z.string().min(1).max(40),
  prompt: z.string().max(4000).default(''),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  choices: z.string().max(2000).optional(),
  answer: z.string().max(2000).optional(),
  points: z.number().positive().max(10000).optional(),
  required: z.boolean().optional(),
  detail: z.string().max(2000).optional()
})

export function importQuestionsFromJson(text: string): ImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { items: [], errors: ['JSON ไม่ถูกต้อง'] }
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const items: FormItem[] = []
  const errors: string[] = []
  list.forEach((entry, idx) => {
    const check = JsonImportItemSchema.safeParse(entry)
    if (!check.success) {
      errors.push(`รายการที่ ${idx + 1}: โครงไม่ถูกต้อง (ต้องมี type)`)
      return
    }
    const data = check.data
    try {
      items.push(
        ...buildItemsFromRow({
          type: data.type,
          prompt: data.type === 'section_header' ? (data.title ?? data.prompt) : data.prompt,
          choices: data.choices ?? '',
          answer: data.answer ?? '',
          points: data.points !== undefined ? String(data.points) : '1',
          required: data.required === false ? 'false' : 'true',
          detail: data.detail ?? ''
        })
      )
    } catch (err) {
      errors.push(`รายการที่ ${idx + 1}: ${err instanceof Error ? err.message : 'ไม่ทราบสาเหตุ'}`)
    }
  })
  return { items, errors }
}

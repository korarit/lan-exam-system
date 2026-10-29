import {
  type DynamicFormDefinition,
  type FormQuestion,
  type FormChoice,
  type ResolvedParameters,
  type StudentFormViewItem,
  type StudentFormItem,
  type StudentFormView,
  isFormItemQuestion
} from './form-schema'

/* ============================================================
 * Phase 6 — stripAnswerKeyForStudent
 * ประกันในระดับ Type + Runtime ว่าโจทย์ที่ส่งถึงนักเรียน
 * ไม่มีฟิลด์เฉลย/คะแนน/พารามิเตอร์แม่สูตร เหลืออยู่แม้แต่ตัวเดียว
 * และสลับลำดับข้อ/ตัวเลือก พร้อมแทนค่า {{param}} ที่ฝั่งเครื่องแม่
 * ============================================================ */

/** PRNG แบบ deterministic ต่อ (formId, studentSeed) — mulberry32 */
export function createSeededRandom(formId: string, studentSeed: string): () => number {
  // cyrb53 แปลง string → 32-bit state 2 ชุด
  let h1 = 0xdeadbeef ^ strHash(formId)
  let h2 = 0x41c6ce57 ^ strHash(formId, 1000)
  const seedStr = `${formId}|${studentSeed}`
  h1 = (h1 ^ strHash(seedStr)) | 0
  h2 = (h2 ^ strHash(seedStr, 88)) | 0
  return function next(): number {
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
    h1 = Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 15), 666264791)
    h2 = Math.imul(h2 ^ (h2 >>> 12), 2246822519)
    const t = ((h1 >>> 0) + (h2 >>> 0)) >>> 0
    let r = t
    r = (r + 0x6d2b79f5) | 0
    r = Math.imul(r ^ (r >>> 15), r | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function strHash(str: string, offset: number = 0): number {
  let h = offset
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + (str.charCodeAt(i) | 0)) | 0
  }
  return h
}

/** Fisher-Yates shuffle (คืน array ใหม่ ไม่แก้ของเดิม) */
export function shuffleWithSeededRandom<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const a = out[i] as T
    const b = out[j] as T
    out[i] = b
    out[j] = a
  }
  return out
}

/** เลือกค่า integer แบบสุ่มตาม spec (min..max, ก้าว step) */
function pickParameterValue(min: number, max: number, step: number, rand: () => number): number {
  const steps = Math.max(0, Math.floor((max - min) / Math.max(1, step)))
  return min + Math.floor(rand() * (steps + 1)) * step
}

/** แทนค่า {{var}} ในโจทย์ด้วยตัวเลขตาม seed */
export function renderPromptTemplate(
  prompt: string,
  parameters: Record<string, QuestionParameterSpecInput> | undefined,
  rand: () => number,
  resolvedOut: Record<string, number>
): string {
  if (!parameters || Object.keys(parameters).length === 0) return prompt
  return prompt.replace(/\{\{\s*([a-zA-Z][\w]{0,15})\s*\}\}/g, (full, name: string) => {
    const spec = parameters[name]
    if (!spec) return full
    const value = pickParameterValue(spec.min, spec.max, spec.step, rand)
    resolvedOut[name] = value
    return String(value)
  })
}

/* สเปคพารามิเตอร์ต่อข้อ (local type เพื่อกัน dependency กลับข้าง) */
export interface QuestionParameterSpecInput {
  min: number
  max: number
  step: number
}

/**
 * ตัดเฉลยออกทั้งหมด + เตรียมโจทย์รายบุคคล:
 * - ลบ answerKey / points / validation / parameters ออกทุกข้อ
 * - สลับลำดับข้อเมื่อ settings.shuffleQuestionsPerStudent
 * - สลับลำดับตัวเลือก (choices/สเกล) เฉพาะข้อที่ติง shuffleChoices
 * - แทนค่า {{a}} {{b}} ใน prompt ด้วย seed ของนักเรียนคนนั้น
 * - ให้ resolvedParameters กลับมาฝั่งเครื่องแม่เท่านั้น (ผู้ครูใช้ตรวจ)
 */
export function stripAnswerKeyForStudent(
  form: DynamicFormDefinition,
  studentSeed: string
): { view: StudentFormView; resolvedParameters: ResolvedParameters } {
  const rand = createSeededRandom(form.formId, studentSeed)
  const resolvedParameters: ResolvedParameters = {}
  const questions = form.items.filter(isFormItemQuestion)
  const shuffledQuestions = form.settings.shuffleQuestionsPerStudent
    ? shuffleWithSeededRandom(questions, rand)
    : questions

  // ทุก slot ของ "ข้อ" ใช้ไอเต็มจากลิสต์สลับแล้ว (บล็อกคั่นคงตำแหน่ง)
  const viewItems: StudentFormViewItem[] = []
  let qCursor = 0
  for (const entry of form.items) {
    if (isFormItemQuestion(entry)) {
      const transformed = shuffledQuestions[qCursor] as FormQuestion
      qCursor++
      viewItems.push(buildStudentFormItem(transformed, rand, resolvedParameters))
    } else {
      viewItems.push(entry)
    }
  }

  return {
    view: {
      moduleId: form.moduleId,
      formId: form.formId,
      title: form.title,
      instructions: form.instructions,
      settings: form.settings,
      items: viewItems
    },
    resolvedParameters
  }
}

function buildStudentFormItem(
  item: FormQuestion,
  rand: () => number,
  resolvedParameters: ResolvedParameters
): StudentFormItem {
  const localResolved: Record<string, number> = {}
  const promptResolved = renderPromptTemplate(item.prompt, item.parameters, rand, localResolved)
  if (Object.keys(localResolved).length > 0) {
    resolvedParameters[item.itemId] = localResolved
  }

  const core = {
    itemId: item.itemId,
    prompt: promptResolved,
    validation: item.validation,
    shuffleChoices: item.shuffleChoices
  }
  /* imageAssetId ใส่เมื่อมีเท่านั้น (exactOptionalPropertyTypes ไม่รับ undefined ชัดเจน) */
  const withImage = (rest: Record<string, unknown>): StudentFormItem =>
    (item.imageAssetId === undefined ? { ...core, ...rest } : { ...core, imageAssetId: item.imageAssetId, ...rest }) as StudentFormItem

  switch (item.inputType) {
    case 'mcq_single':
    case 'checkbox_multi':
    case 'dropdown':
      return withImage({
        inputType: item.inputType,
        choices: item.shuffleChoices ? shuffleChoices(item.choices, rand) : item.choices
      })
    case 'short_text':
      return withImage({ inputType: 'short_text' })
    case 'long_text':
      return withImage({ inputType: 'long_text' })
    case 'numeric_param':
      return withImage({ inputType: 'numeric_param', unit: item.unit })
    case 'mcq_grid':
    case 'checkbox_grid':
      return withImage({
        inputType: item.inputType,
        rows: item.shuffleChoices ? shuffleWithSeededRandom(item.rows, rand) : item.rows,
        columns: item.columns
      })
    case 'linear_scale': {
      // สลับทิศการอ่านสเกล (ป้ายซ้าย/ขวา) — ตัวเลขและคะแนนคงเดิม
      const rest: Record<string, unknown> = { inputType: 'linear_scale', scaleMin: item.scaleMin, scaleMax: item.scaleMax }
      if (item.leftLabel !== undefined) rest.leftLabel = item.leftLabel
      if (item.rightLabel !== undefined) rest.rightLabel = item.rightLabel
      if (item.shuffleChoices) {
        delete rest.leftLabel
        delete rest.rightLabel
        if (item.rightLabel !== undefined) rest.leftLabel = item.rightLabel
        if (item.leftLabel !== undefined) rest.rightLabel = item.leftLabel
      }
      return withImage(rest)
    }
    case 'date_time':
      return withImage({ inputType: 'date_time', mode: item.mode })
    case 'code_snippet':
      return withImage({ inputType: 'code_snippet', language: item.language, starterCode: item.starterCode })
    case 'file_upload':
      return withImage({ inputType: 'file_upload', acceptMultiple: item.acceptMultiple })
  }
}

function shuffleChoices(choices: FormChoice[], rand: () => number): FormChoice[] {
  return shuffleWithSeededRandom(choices, rand)
}

/** นับจำนวนข้อจริง (ไม่รวมหัวข้อ/สื่อประกอบ) */
export function countFormQuestions(items: { inputType: string }[]): number {
  return items.filter((i) => i.inputType !== 'section_header' && i.inputType !== 'media_stimulus').length
}

/** คะแนนรวมของฟอร์ม */
export function sumFormPoints(items: FormQuestion[]): number {
  return items.reduce((total, item) => total + item.points, 0)
}

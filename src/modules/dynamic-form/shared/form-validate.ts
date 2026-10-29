import type { FormValidationRule, FormItem, FormQuestion } from './form-schema'
import { isFormItemQuestion } from './form-schema'
import type { NormalizedItemAnswer } from './form-grading'

/* ============================================================
 * Phase 6 — ตรวจคำตอบของข้อ (ก่อนจะถึงเฉลย)
 * รายงานข้อความ error เท่านั้น แยกจากการคิดคะแนน (form-grading)
 * ============================================================ */

export type FormAnswerValue =
  | { kind: 'none' }
  | { kind: 'choice'; choiceId: string }
  | { kind: 'multi'; choiceIds: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'numeric'; numeric: number }
  | { kind: 'rows'; rowAnswers: Record<string, string | string[]> }
  | { kind: 'scale'; value: number }
  | { kind: 'files'; fileNames: string[] }

export interface FormItemAnswer {
  itemId: string
  value: FormAnswerValue
}

export function emptyItemAnswer(itemId: string): FormItemAnswer {
  return { itemId, value: { kind: 'none' } }
}

/** คำตอบว่างหรือไม่ (required ใช้กับค่านี้) */
function hasFilledValue(value: FormAnswerValue): boolean {
  switch (value.kind) {
    case 'choice':
      return value.choiceId.length > 0
    case 'scale':
      return Number.isFinite(value.value)
    case 'numeric':
      return Number.isFinite(value.numeric)
    case 'multi':
      return value.choiceIds.length > 0
    case 'rows':
      return Object.values(value.rowAnswers).some((given) =>
        Array.isArray(given) ? given.length > 0 : given.length > 0
      )
    case 'text':
      return value.text.length > 0
    case 'files':
      return value.fileNames.length > 0
    default:
      return false
  }
}

/** ตรวจกฎ Validation ต่อข้อ — คืน error message ถ้าไม่ผ่าน (null = ผ่าน) */
export function validateItemAnswer(item: FormQuestion, value: FormAnswerValue): string | null {
  const rule: FormValidationRule = item.validation
  const hasValue = hasFilledValue(value)
  if (!hasValue) {
    return rule.required ? (rule.customErrorMessage ?? 'ข้อนี้จำเป็นต้องตอบ') : null
  }
  const errors: string[] = []
  if (value.kind === 'text') {
    if (rule.minLength !== undefined && value.text.trim().length < rule.minLength) {
      errors.push(`ต้องมีอย่างน้อย ${rule.minLength} ตัวอักษร`)
    }
    if (rule.maxLength !== undefined && value.text.length > rule.maxLength) {
      errors.push(`ยาวได้ไม่เกิน ${rule.maxLength} ตัวอักษร`)
    }
    if (rule.minWords !== undefined && countWords(value.text) < rule.minWords) {
      errors.push(`ต้องมีอย่างน้อย ${rule.minWords} คำ`)
    }
    if (rule.maxWords !== undefined && countWords(value.text) > rule.maxWords) {
      errors.push(`มีได้ไม่เกิน ${rule.maxWords} คำ`)
    }
    if (rule.regexPattern !== undefined && rule.regexPattern.length > 0) {
      try {
        if (!new RegExp(rule.regexPattern).test(value.text)) errors.push('ไม่ตรงรูปแบบที่กำหนด')
      } catch {
        errors.push('กฎ regex ที่ตั้งไว้ไม่ถูกต้อง')
      }
    }
  }
  if (value.kind === 'multi') {
    if (rule.minSelect !== undefined && value.choiceIds.length < rule.minSelect) {
      errors.push(`เลือกอย่างน้อย ${rule.minSelect} ข้อ`)
    }
    if (rule.maxSelect !== undefined && value.choiceIds.length > rule.maxSelect) {
      errors.push(`เลือกได้ไม่เกิน ${rule.maxSelect} ข้อ`)
    }
  }
  if (value.kind === 'rows' && rule.maxSelect !== undefined) {
    for (const given of Object.values(value.rowAnswers)) {
      if (Array.isArray(given) && given.length > rule.maxSelect) {
        errors.push(`บางแถวเลือกเกิน ${rule.maxSelect} ช่อง`)
        break
      }
    }
  }
  if (value.kind === 'files' && rule.allowedExtensions !== undefined && rule.allowedExtensions.length > 0) {
    for (const fileName of value.fileNames) {
      const ok = rule.allowedExtensions.some((ext) => fileName.toLowerCase().endsWith(ext.toLowerCase()))
      if (!ok) {
        errors.push(`นามสกุลไฟล์นี้ไม่อนุญาต: ${fileName}`)
        break
      }
    }
  }
  if (errors.length === 0) return null
  return rule.customErrorMessage ?? errors.join(' • ')
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length
}

/** แปลงคำตอบของข้อหนึ่งเป็นรูป normalize ไว้ยิงเข้า grader */
export function normalizeAnswer(item: FormItem, value: FormAnswerValue): NormalizedItemAnswer | null {
  if (!isFormItemQuestion(item)) return null
  switch (value.kind) {
    case 'none':
      return { fileNames: [] }
    case 'choice':
      return { choiceId: value.choiceId, fileNames: [] }
    case 'multi':
      return { choiceIds: value.choiceIds, fileNames: [] }
    case 'text':
      return { text: value.text, fileNames: [] }
    case 'rows':
      return { rowAnswers: value.rowAnswers, fileNames: [] }
    case 'scale':
      return { scaleValue: value.value, fileNames: [] }
    case 'numeric':
      return { numeric: value.numeric, fileNames: [] }
    case 'files':
      return { fileNames: value.fileNames }
  }
}

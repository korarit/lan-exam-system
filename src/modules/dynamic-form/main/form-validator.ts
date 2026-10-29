import type { FormItem, FormQuestion, FormValidationRule } from '../shared/form-schema'
import { isFormItemQuestion } from '../shared/form-schema'
import type { StoredAnswerValue, StoredArtifactDescriptor } from '../shared/form-answer-schema'

/* ============================================================
 * Phase 7 (7.1.1) — Server-Side Dynamic Input Validator
 * ตรวจคำตอบที่เครื่องนักเรียนส่งมาถึง "ที่ฝั่งเครื่องแม่อีกครั้งเสมอ"
 * (ไม่เชื่อผลตรวจจากฝั่ง UI) — ทั้งกฎ FormValidationRule และ
 * ความถูกต้องเชิงโครงสร้าง (choiceId/rowId/columnId ต้องมีจริง)
 * ============================================================ */

export interface AnswerViolation {
  code: string
  message: string
}

export interface ValidateServerAnswerInput {
  item: FormItem
  value: StoredAnswerValue
  /** descriptors ที่ vault รับไว้แล้ว (ข้อ file_upload) — key = artifactId */
  artifacts?: Record<string, StoredArtifactDescriptor>
}

const MAX_TEXT_LENGTH = 20_000

export function validateServerAnswer(input: ValidateServerAnswerInput): AnswerViolation[] {
  const item = input.item
  if (!isFormItemQuestion(item)) return []
  const rule = item.validation
  const violations: AnswerViolation[] = []
  const value = input.value

  const required = rule.required !== false
  if (isEmptyValue(value)) {
    if (required) violations.push({ code: 'REQUIRED_EMPTY', message: rule.customErrorMessage ?? 'ข้อนี้จำเป็นต้องตอบ' })
    return violations
  }
  if (value.kind !== answerKindForInputType(item)) {
    violations.push({ code: 'VALUE_TYPE_MISMATCH', message: `คำตอบไม่ตรงกับชนิดข้อสอบ (${item.inputType})` })
    return violations
  }

  switch (item.inputType) {
    case 'mcq_single':
    case 'dropdown': {
      if (value.kind !== 'choice') break
      if (!item.choices.some((c) => c.choiceId === value.choiceId)) {
        violations.push({ code: 'INVALID_CHOICE', message: 'เลือกตัวเลือกที่ไม่มีอยู่จริง' })
      }
      break
    }
    case 'checkbox_multi': {
      if (value.kind !== 'multi') break
      const count = value.choiceIds.length
      if (rule.minSelect !== undefined && count < rule.minSelect) {
        violations.push({ code: 'MIN_SELECT', message: `เลือกอย่างน้อย ${rule.minSelect} ข้อ` })
      }
      if (rule.maxSelect !== undefined && count > rule.maxSelect) {
        violations.push({ code: 'MAX_SELECT', message: `เลือกได้ไม่เกิน ${rule.maxSelect} ข้อ` })
      }
      const valid = new Set(item.choices.map((c) => c.choiceId))
      if (value.choiceIds.some((id) => !valid.has(id))) {
        violations.push({ code: 'INVALID_CHOICE', message: 'เลือกตัวเลือกที่ไม่มีอยู่จริง' })
      }
      break
    }
    case 'short_text':
    case 'long_text': {
      if (value.kind !== 'text') break
      violations.push(...checkTextRules(value.text, rule))
      break
    }
    case 'code_snippet': {
      if (value.kind !== 'code') break
      violations.push(...checkTextRules(value.text, rule))
      break
    }
    case 'numeric_param': {
      if (value.kind !== 'numeric') break
      if (!Number.isFinite(value.numeric)) {
        violations.push({ code: 'NOT_A_NUMBER', message: 'ต้องเป็นตัวเลขจริง' })
      }
      break
    }
    case 'linear_scale': {
      if (value.kind !== 'scale') break
      if (!Number.isFinite(value.value)) {
        violations.push({ code: 'NOT_A_NUMBER', message: 'ค่าสเกลต้องเป็นตัวเลข' })
      } else if (value.value < item.scaleMin || value.value > item.scaleMax) {
        violations.push({ code: 'SCALE_OUT_OF_RANGE', message: `ค่าต้องอยู่ระหว่าง ${item.scaleMin}..${item.scaleMax}` })
      }
      break
    }
    case 'mcq_grid':
    case 'checkbox_grid': {
      if (value.kind !== 'rows') break
      const rowIds = new Set(item.rows.map((r) => r.rowId))
      const columnIds = new Set(item.columns.map((c) => c.columnId))
      let foreignRow = false
      for (const rowId of Object.keys(value.rowAnswers)) {
        if (!rowIds.has(rowId)) {
          foreignRow = true
          break
        }
      }
      if (foreignRow) {
        violations.push({ code: 'INVALID_ROW', message: 'มีแถวที่ไม่มีอยู่จริง' })
        break
      }
      let foreignColumn = false
      let missingColumn = false
      for (const given of Object.values(value.rowAnswers)) {
        const givenList = Array.isArray(given) ? given : [given]
        if (givenList.length === 0) {
          missingColumn = missingColumn || rule.required
        }
        if (givenList.some((g) => !columnIds.has(g))) {
          foreignColumn = true
          break
        }
        if (item.inputType === 'checkbox_grid' && rule.maxSelect !== undefined && givenList.length > rule.maxSelect) {
          violations.push({ code: 'GRID_MAX_SELECT', message: `บางแถวเลือกเกิน ${rule.maxSelect} ช่อง` })
          break
        }
      }
      if (foreignColumn) {
        violations.push({ code: 'INVALID_COLUMN', message: 'มีตัวเลือกคอลัมน์ที่ไม่มีอยู่จริง' })
        break
      }
      if (rule.required) {
        if (missingColumn || Object.keys(value.rowAnswers).length < item.rows.length) {
          violations.push({ code: 'INCOMPLETE_ROWS', message: 'ต้องตอบครบทุกแถว' })
        }
      }
      break
    }
    case 'date_time': {
      if (value.kind !== 'date') break
      if (Number.isNaN(Date.parse(value.value))) {
        violations.push({ code: 'INVALID_DATE', message: 'รูปแบบวันที่/เวลาไม่ถูกต้อง' })
      }
      break
    }
    case 'file_upload': {
      if (value.kind !== 'files') break
      const desc = input.artifacts ?? {}
      const maxFiles = item.acceptMultiple ? 20 : 1
      if (value.artifactIds.length > maxFiles) {
        violations.push({ code: 'TOO_MANY_FILES', message: item.acceptMultiple ? 'แนบไฟล์เกินจำนวนที่กำหนด' : 'ข้อนี้แนบไฟล์ได้เพียงไฟล์เดียว' })
      }
      if (value.artifactIds.length === 0 && required) {
        violations.push({ code: 'REQUIRED_EMPTY', message: rule.customErrorMessage ?? 'ต้องแนบไฟล์งาน' })
      }
      for (const id of value.artifactIds) {
        const artifact = desc[id]
        if (artifact === undefined) {
          violations.push({ code: 'ARTIFACT_NOT_SAVED', message: 'ไฟล์แนบยังไม่ถูกบันทึกทางเครื่องแม่' })
          continue
        }
        const lowerName = artifact.fileName.toLowerCase()
        if (rule.allowedExtensions !== undefined && rule.allowedExtensions.length > 0) {
          const ok = rule.allowedExtensions.some((ext) => lowerName.endsWith(ext.toLowerCase()))
          if (!ok) violations.push({ code: 'FILE_EXTENSION_BLOCKED', message: `นามสกุลไฟล์ไม่อนุญาต: ${artifact.fileName}` })
        }
        if (rule.maxFileSizeBytes !== undefined && artifact.sizeBytes > rule.maxFileSizeBytes) {
          violations.push({ code: 'FILE_TOO_LARGE', message: `ไฟล์เกินขนาดกำหนด: ${artifact.fileName}` })
        }
      }
      break
    }
  }
  return violations
}

function checkTextRules(
  text: string,
  rule: FormValidationRule,
  hardLimit: number = MAX_TEXT_LENGTH
): AnswerViolation[] {
  const out: AnswerViolation[] = []
  if (text.length > hardLimit) {
    out.push({ code: 'TEXT_TOO_LONG', message: 'คำตอบยาวเกินขีดจำกัดของระบบ' })
    return out
  }
  if (rule.minLength !== undefined && text.trim().length < rule.minLength) {
    out.push({ code: 'MIN_LENGTH', message: `ต้องมีอย่างน้อย ${rule.minLength} ตัวอักษร` })
  }
  if (rule.maxLength !== undefined && text.length > rule.maxLength) {
    out.push({ code: 'MAX_LENGTH', message: `ยาวได้ไม่เกิน ${rule.maxLength} ตัวอักษร` })
  }
  if (rule.minWords !== undefined && countWords(text) < rule.minWords) {
    out.push({ code: 'MIN_WORDS', message: `ต้องมีอย่างน้อย ${rule.minWords} คำ` })
  }
  if (rule.maxWords !== undefined && countWords(text) > rule.maxWords) {
    out.push({ code: 'MAX_WORDS', message: `มีได้ไม่เกิน ${rule.maxWords} คำ` })
  }
  if (rule.regexPattern !== undefined && rule.regexPattern.length > 0) {
    try {
      if (!new RegExp(rule.regexPattern).test(text)) {
        out.push({
          code: 'PATTERN_MISMATCH',
          message: rule.customErrorMessage ?? 'ไม่ตรงรูปแบบที่กำหนด'
        })
      }
    } catch {
      out.push({ code: 'BAD_REGEX_RULE', message: 'กฎ regex ที่ตั้งไว้ไม่ถูกต้อง' })
    }
  }
  return out
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length
}

function isEmptyValue(value: StoredAnswerValue): boolean {
  switch (value.kind) {
    case 'none':
      return true
    case 'choice':
      return value.choiceId.length === 0
    case 'multi':
      return value.choiceIds.length === 0
    case 'text':
      return value.text.trim().length === 0
    case 'date':
      return value.value.length === 0
    case 'numeric':
      return !Number.isFinite(value.numeric)
    case 'rows':
      return !Object.values(value.rowAnswers).some((given) =>
        Array.isArray(given) ? given.length > 0 : given.length > 0
      )
    case 'scale':
      return !Number.isFinite(value.value)
    case 'code':
      return value.text.length === 0
    case 'files':
      return value.artifactIds.length === 0
  }
}

function answerKindForInputType(item: FormQuestion): StoredAnswerValue['kind'] {
  switch (item.inputType) {
    case 'mcq_single':
    case 'dropdown':
      return 'choice'
    case 'checkbox_multi':
      return 'multi'
    case 'short_text':
    case 'long_text':
      return 'text'
    case 'numeric_param':
      return 'numeric'
    case 'mcq_grid':
    case 'checkbox_grid':
      return 'rows'
    case 'linear_scale':
      return 'scale'
    case 'date_time':
      return 'date'
    case 'code_snippet':
      return 'code'
    case 'file_upload':
      return 'files'
  }
}

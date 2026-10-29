import type {
  DynamicFormDefinition,
  FormItem,
  AnswerKey,
  ResolvedParameters
} from '../shared/form-schema'
import { isFormItemQuestion } from '../shared/form-schema'
import { gradeAnsweredRatio, type NormalizedItemAnswer } from '../shared/form-grading'
import type {
  StoredAnswerValue,
  StoredArtifactDescriptor,
  FormItemGradeStatus,
  FormItemSubmission
} from '../shared/form-answer-schema'
import type { AnswerViolation } from './form-validator'

/* ============================================================
 * Phase 7 (7.2.2) — Instant Auto-Grading Engine (ฝั่งเครื่องแม่)
 * ทันทีที่รับคำตอบรายข้อ คิดคะแนนเทียบ AnswerKey ของข้อนั้น:
 * - exact_choice / multi_choice (all-or-nothing + partial-with-penalty)
 * - short_text_match (trim/case/regex)
 * - numeric_formula (Safe Math + ตัวแปรสุ่มรายคน + tolerance)
 * - grid_match (ให้คะแนนรายแถวรวมเป็นคะแนนข้อ)
 * - manual_rubric → status รอตรวจ + สแกน expectedKeywords ไว้ชี้ครู
 * คะแนน = ratio(0..1) × points (ปัดให้ปลอด error ทศนิยม 2 ตำแหน่ง)
 * ============================================================ */

export interface ItemGradeInput {
  item: FormItem
  value: StoredAnswerValue
  artifacts: StoredArtifactDescriptor[]
  /** ตัวแปรสุ่มรายคนของข้อนั้น เช่น { a: 12, b: 5 } (ถ้ามี) */
  resolvedParameters?: Record<string, number>
  /** ผลตรวจ server-side validator (ถ้าผ่านมาแล้ว — ส่ง [] ได้) */
  violations?: AnswerViolation[]
}

export interface ItemGradeOutcome {
  itemId: string
  status: FormItemGradeStatus
  earnedPoints: number
  /** คะแนนเต็มของข้อ (จาก definition) */
  maxPoints: number
  /** ผลสแกน expectedKeywords ของข้อ manual_rubric */
  keywordHits?: number
  keywordTotal?: number
  keywordFound?: string[]
  violations: Array<{ code: string; message: string }>
}

function roundPoints(points: number): number {
  return Math.round(points * 100) / 100
}

function normalizeStoredValue(
  value: StoredAnswerValue,
  artifacts: StoredArtifactDescriptor[]
): NormalizedItemAnswer {
  const namesById = new Map(artifacts.map((a) => [a.artifactId, a.fileName]))
  const noFiles: NormalizedItemAnswer = { fileNames: [] }
  switch (value.kind) {
    case 'none':
      return noFiles
    case 'choice':
      return { choiceId: value.choiceId, fileNames: [] }
    case 'multi':
      return { choiceIds: value.choiceIds, fileNames: [] }
    case 'text':
      return { text: value.text, fileNames: [] }
    case 'date':
      return { dateTime: value.value, fileNames: [] }
    case 'numeric':
      return { numeric: value.numeric, fileNames: [] }
    case 'rows':
      return { rowAnswers: value.rowAnswers, fileNames: [] }
    case 'scale':
      return { scaleValue: value.value, fileNames: [] }
    case 'code':
      return { codeText: value.text, fileNames: [] }
    case 'files':
      return { fileNames: value.artifactIds.map((id) => namesById.get(id) ?? id) }
  }
}

function scanKeywords(
  key: Extract<AnswerKey, { gradingType: 'manual_rubric' }>,
  value: StoredAnswerValue
): { hits: number; total: number; found: string[] } | undefined {
  const keywords = key.expectedKeywords
  if (keywords === undefined || keywords.length === 0) return undefined
  const haystack = value.kind === 'text' || value.kind === 'code' ? value.text : ''
  const lower = haystack.toLowerCase()
  const found: string[] = []
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) found.push(kw)
  }
  return { hits: found.length, total: keywords.length, found }
}

/** ตรวจข้อเดียวฝั่งเครื่องแม่ */
export function gradeFormItem(input: ItemGradeInput): ItemGradeOutcome {
  const item = input.item
  const violations = input.violations ?? []
  if (!isFormItemQuestion(item)) {
    return { itemId: item.itemId, status: 'ungraded', earnedPoints: 0, maxPoints: 0, violations }
  }
  const resolved = input.resolvedParameters
  if (violations.length > 0) {
    return { itemId: item.itemId, status: 'invalid', earnedPoints: 0, maxPoints: item.points, violations }
  }
  if (item.answerKey.gradingType === 'ungraded') {
    return { itemId: item.itemId, status: 'ungraded', earnedPoints: 0, maxPoints: item.points, violations }
  }
  const normalized = normalizeStoredValue(input.value, input.artifacts)
  const graded = gradeAnsweredRatio(item.answerKey, normalized, resolved)
  if (item.answerKey.gradingType === 'manual_rubric') {
    const scan = scanKeywords(item.answerKey, input.value)
    const base: ItemGradeOutcome = {
      itemId: item.itemId,
      status: 'needs-manual',
      earnedPoints: 0,
      maxPoints: item.points,
      violations
    }
    if (scan !== undefined) {
      base.keywordHits = scan.hits
      base.keywordTotal = scan.total
      base.keywordFound = scan.found
    }
    return base
  }
  return {
    itemId: item.itemId,
    status: 'auto-graded',
    earnedPoints: roundPoints(graded.ratio * item.points),
    maxPoints: item.points,
    violations
  }
}

/* ---------- Auto-Grading ทั้งชุดต่อนักเรียน ---------- */

export interface FormGradingTotals {
  autoPoints: number
  /** คะแนนที่ครูให้เพิ่มข้ออัตนัย (จาก manualPoints ที่บันทึกแล้ว) */
  manualPoints: number
  totalPoints: number
  maxPoints: number
  percent: number
  needsManualCount: number
  invalidCount: number
  ungradedCount: number
  answeredCount: number
}

/** จุดเข้าใช้ไม่จำกัดชื่อลำดับข้อ — รับคำตอบรายข้อแบบ submission ของนักเรียน */
export function gradeFormSubmission(
  form: DynamicFormDefinition,
  submissions: FormItemSubmission[],
  resolvedParameters?: ResolvedParameters,
  precomputedViolations?: Record<string, AnswerViolation[]>
): ItemGradeOutcome[] {
  const byItemId = new Map(form.items.map((item) => [item.itemId, item] as const))
  const outcomes: ItemGradeOutcome[] = []
  for (const submission of submissions) {
    const item = byItemId.get(submission.itemId)
    if (item === undefined) {
      outcomes.push({
        itemId: submission.itemId,
        status: 'invalid',
        earnedPoints: 0,
        maxPoints: 0,
        violations: [{ code: 'UNKNOWN_ITEM', message: 'คำตอบส่งเข้าข้อที่ไม่มีในฟอร์ม' }]
      })
      continue
    }
    outcomes.push(
      gradeFormItem({
        item,
        value: submission.value,
        artifacts: [],
        violations: precomputedViolations?.[submission.itemId] ?? [],
        ...(resolvedParameters?.[submission.itemId] !== undefined
          ? { resolvedParameters: resolvedParameters[submission.itemId] }
          : {})
      })
    )
  }
  return outcomes
}

/** รวมคะแนนเป็นสรุปต่อคน (manualPoints = รวมคะแนนที่ครูให้แล้ว) */
export function summarizeGrading(
  outcomes: ItemGradeOutcome[],
  manualPointsByItem?: Record<string, number>
): FormGradingTotals {
  let autoPoints = 0
  let manualPoints = 0
  let maxPoints = 0
  let needsManualCount = 0
  let invalidCount = 0
  let ungradedCount = 0
  const answeredCount = outcomes.length
  for (const o of outcomes) {
    maxPoints += o.maxPoints
    switch (o.status) {
      case 'auto-graded':
        autoPoints += o.earnedPoints
        break
      case 'needs-manual':
        needsManualCount += 1
        if (manualPointsByItem?.[o.itemId] !== undefined) {
          manualPoints += manualPointsByItem[o.itemId] as number
        }
        break
      case 'manual-graded':
        manualPoints += manualPointsByItem?.[o.itemId] ?? o.earnedPoints
        break
      case 'invalid':
        invalidCount += 1
        break
      case 'ungraded':
        ungradedCount += 1
        break
    }
  }
  const total = roundPoints(autoPoints + manualPoints)
  const percent = maxPoints > 0 ? Math.round((total / maxPoints) * 1000) / 10 : 0
  return {
    autoPoints: roundPoints(autoPoints),
    manualPoints: roundPoints(manualPoints),
    totalPoints: total,
    maxPoints: roundPoints(maxPoints),
    percent,
    needsManualCount,
    invalidCount,
    ungradedCount,
    answeredCount
  }
}

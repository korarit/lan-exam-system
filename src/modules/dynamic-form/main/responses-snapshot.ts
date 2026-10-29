import type { FormItem, FormQuestion, ZtformContainer } from '../shared/form-schema'
import { isFormItemQuestion, AnswerKeySchema } from '../shared/form-schema'
import { answerToDisplay, canonicalQuestionItems } from './csv-exporter'
import { summarizeGrading, type ItemGradeOutcome } from './form-grader'
import { listRegradeHistory, type FormResponseStore, type StoredFormResponseRow } from './form-response-store'
import type { HostDatabase } from '@main/storage/db'
import type { FormJourneyRecord } from '../shared/form-answer-schema'
import type {
  FormResponsesSnapshot,
  FormStudentResponsesView,
  FormItemAnswerView,
  FormItemStatsView,
  FormItemGradeStatus
} from '../shared/form-responses-view'

/* ============================================================
 * Phase 7 (7.3.1) — Snapshot builder ให้หน้า Responses Dashboard
 * ถอดคำตอบจาก store แล้วจัดรูปเป็น JSON บางตัวเดียวต่อโหลด
 * ============================================================ */

interface StudentRow {
  student_id: string
  display_name: string
  seed: string
  joined_at_ms: number
  status: string
  suspicion_score: number
}

interface AuditCountRow {
  student_id: string
  critical_events: number
}

export function buildResponsesSnapshot(
  db: HostDatabase,
  roomId: string,
  roomName: string,
  container: ZtformContainer,
  store: FormResponseStore,
  kind: 'database' | 'archive',
  startedAtMs: number | null,
  endedAtMs: number | null
): FormResponsesSnapshot {
  const form = container.form
  const rows = store.listResponses(roomId)
  const byStudent = new Map<string, StoredFormResponseRow[]>()
  for (const row of rows) {
    const bucket = byStudent.get(row.studentId) ?? []
    bucket.push(row)
    byStudent.set(row.studentId, bucket)
  }
  const studentsRaw = db.db
    .prepare(
      `SELECT student_id, display_name, seed, joined_at_ms, status, suspicion_score
       FROM students WHERE session_id = ? ORDER BY display_name, student_id`
    )
    .all(roomId) as unknown as StudentRow[]
  const criticalCounts = db.db
    .prepare(
      `SELECT student_id, COUNT(*) AS critical_events
       FROM audit_logs WHERE session_id = ? AND severity = 'critical' GROUP BY student_id`
    )
    .all(roomId) as unknown as AuditCountRow[]
  const criticalByStudent = new Map(criticalCounts.map((r) => [r.student_id, r.critical_events] as const))

  const studentViews: FormStudentResponsesView[] = []
  for (const student of studentsRaw) {
    const studentRows = byStudent.get(student.student_id) ?? []
    const byItemId = new Map(studentRows.map((r) => [r.itemId, r] as const))
    const items: FormItemAnswerView[] = canonicalQuestionItems(form)
      .filter((q): q is { index: number; item: FormQuestion } => isFormItemQuestion(q.item))
      .map((q) => buildItemView(q.item, byItemId.get(q.item.itemId)))

    const manualByItem: Record<string, number> = {}
    for (const view of items) {
      if (view.manualPoints !== null) manualByItem[view.itemId] = view.manualPoints
    }
    const outcomes: ItemGradeOutcome[] = items.map((view) => ({
      itemId: view.itemId,
      status: view.status,
      earnedPoints: view.earnedPoints,
      maxPoints: view.maxPoints,
      violations: view.violations
    }))
    const totals = summarizeGrading(outcomes, manualByItem)
    const lastSubmittedAt = studentRows.reduce<number | null>((acc, r) => {
      if (r.submittedAtMs === null) return acc
      return acc === null ? r.submittedAtMs : Math.max(acc, r.submittedAtMs)
    }, null)
    const criticalEvents = criticalByStudent.get(student.student_id) ?? 0
    const securityStatus: 'NORMAL' | 'WARNING' | 'CRITICAL' =
      criticalEvents > 0 ? 'CRITICAL' : student.suspicion_score >= 40 ? 'WARNING' : 'NORMAL'
    studentViews.push({
      studentId: student.student_id,
      studentName: student.display_name,
      studentSeed: student.seed,
      joinedAtMs: student.joined_at_ms,
      submittedAtMs: lastSubmittedAt,
      finishReason: student.status === 'submitted' ? 'submitted' : null,
      security: {
        status: securityStatus,
        suspicionScore: student.suspicion_score,
        criticalEvents,
        proctorNote: ''
      },
      totals,
      items
    })
  }

  /* ---------- สถิติรายข้อ ---------- */
  const itemStats: FormItemStatsView[] = canonicalQuestionItems(form).map((q, idx) => {
    if (!isFormItemQuestion(q.item)) {
      return {
        itemId: q.item.itemId,
        inputType: q.item.inputType,
        index: idx + 1,
        maxPoints: 0,
        responsesCount: 0,
        correctCount: 0,
        correctRate: 0,
        flaggedHard: false
      }
    }
    let responses = 0
    let correct = 0
    for (const sv of studentViews) {
      const view = sv.items.find((i) => i.itemId === q.item.itemId)
      if (view === undefined) continue
      responses += 1
      if (view.earnedPoints >= view.maxPoints - 0.01) correct += 1
    }
    const correctRate = responses > 0 ? correct / responses : 0
    return {
      itemId: q.item.itemId,
      inputType: q.item.inputType,
      index: idx + 1,
      maxPoints: q.item.points,
      responsesCount: responses,
      correctCount: correct,
      correctRate,
      flaggedHard: responses > 0 && correctRate < 0.3
    }
  })

  /* ---------- สรุปภาพรวม + กราฟที่ถนอมมอง ---------- */
  const percents = studentViews.map((s) => s.totals.percent)
  const sorted = [...percents].sort((a, b) => a - b)
  const mean = percents.length > 0 ? percents.reduce((a, b) => a + b, 0) / percents.length : 0
  const median =
    sorted.length > 0
      ? sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]!
        : ((sorted[sorted.length / 2 - 1] as number) + (sorted[sorted.length / 2] as number)) / 2
      : 0
  const boundaries = [0, 25, 50, 75, 100]
  const distribution = boundaries.map((edge, index) => {
    const next = boundaries[index + 1]
    const count = studentViews.filter((s) =>
      s.totals.percent >= edge && (next === undefined ? s.totals.percent <= edge + 100 : s.totals.percent < next)
    ).length
    return { bucketLow: edge, bucketHigh: next ?? 100, count }
  })
  const needsManualCount = studentViews.reduce((acc, s) => acc + s.totals.needsManualCount, 0)

  let regradeHistory: Array<{ runAtMs: number; summaryJson: string }> = []
  try {
    regradeHistory = listRegradeHistory(db, roomId).map((h) => ({
      runAtMs: h.run_at_ms,
      summaryJson: h.summary_json
    }))
  } catch {
    void roomId
  }

  return {
    kind,
    roomId,
    roomName,
    formTitle: form.title,
    form,
    startedAtMs,
    endedAtMs,
    students: studentViews,
    itemStats,
    distribution: distribution.length === 0 ? [] : distribution,
    summary: {
      mean: Math.round(mean * 10) / 10,
      median: Math.round(median * 10) / 10,
      min: sorted.length > 0 ? (sorted[0] as number) : 0,
      max: sorted.length > 0 ? (sorted[sorted.length - 1] as number) : 0,
      studentCount: studentViews.length,
      needsManualCount
    },
    regradeHistory
  }
}

/** ทำสแนปช็อตของมุมมองสอบรายคน (ไฟล์ .ztresults ขึ้นโค้ด 100% ในรูปเดียวกัน) */
export function buildItemView(item: FormQuestion, row?: StoredFormResponseRow): FormItemAnswerView {
  const status: FormItemGradeStatus = row?.status ?? 'invalid'
  return {
    itemId: item.itemId,
    inputType: item.inputType,
    displayValue: row !== undefined ? answerToDisplay(item, row) : '',
    value: row?.value ?? { kind: 'none' },
    artifacts: (row?.artifacts ?? []).map((a) => ({
      artifactId: a.artifactId,
      fileName: a.fileName,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256
    })),
    status,
    earnedPoints: row?.earnedPoints ?? 0,
    manualPoints: row?.manualPoints ?? null,
    maxPoints: item.points,
    violations: safeViolations(row),
    journey: (row?.journey ?? null) as FormJourneyRecord | null,
    revision: row?.revision ?? 0,
    updatedAtMs: row?.updatedAtMs ?? 0,
    correctDisplay: correctAnswerDisplay(item),
    ...keywordHints(item, row)
  }
}

function keywordHints(
  item: FormQuestion,
  row?: StoredFormResponseRow
): { keywordHits?: number; keywordTotal?: number; keywordFound?: string[] } {
  if (item.answerKey.gradingType !== 'manual_rubric') return {}
  const keywords = item.answerKey.expectedKeywords
  if (keywords === undefined || keywords.length === 0) return {}
  const text = row !== undefined && (row.value.kind === 'text' || row.value.kind === 'code') ? row.value.text : ''
  const found = keywords.filter((kw) => text.toLowerCase().includes(kw.toLowerCase()))
  return {
    keywordHits: found.length,
    keywordTotal: keywords.length,
    keywordFound: found
  }
}

function safeViolations(row?: StoredFormResponseRow): Array<{ code: string; message: string }> {
  if (row === undefined) return []
  try {
    const parsed = JSON.parse(row.violationsJson) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (v): v is { code: string; message: string } =>
          typeof v === 'object' && v !== null && 'code' in v && 'message' in v
      )
    }
  } catch {
    void row
  }
  return []
}

/** เฉลยที่ถูกต้องแสดงเป็นข้อความ (เฉลยมีอยู่ฝั่งเครื่องแม่/.ztresults เท่านั้น) */
export function correctAnswerDisplay(rawItem: FormItem): string | null {
  if (!isFormItemQuestion(rawItem)) return null
  const item = rawItem
  const keyCheck = AnswerKeySchema.safeParse(item.answerKey)
  if (!keyCheck.success) return null
  const key = keyCheck.data
  switch (key.gradingType) {
    case 'exact_choice': {
      if (item.inputType !== 'mcq_single' && item.inputType !== 'dropdown') return null
      return item.choices.find((c) => c.choiceId === key.correctChoiceId)?.text ?? null
    }
    case 'multi_choice': {
      if (item.inputType !== 'checkbox_multi') return null
      return key.correctChoiceIds
        .map((id) => item.choices.find((c) => c.choiceId === id)?.text ?? id)
        .join(' | ')
    }
    case 'short_text_match':
      return key.acceptedAnswers.join(' หรือ ')
    case 'numeric_formula':
      return `${key.formulaOrValue} (ยอมผิด ±${key.tolerance})`
    case 'grid_match': {
      if (item.inputType !== 'mcq_grid' && item.inputType !== 'checkbox_grid') return null
      return item.rows
        .map((r) => {
          const expected = key.rowAnswerMap[r.rowId]
          if (expected === undefined) return undefined
          const cells = (Array.isArray(expected) ? expected : [expected])
            .map((c) => item.columns.find((col) => col.columnId === c)?.label ?? c)
            .join('/')
          return `${r.label}: ${cells}`
        })
        .filter((s): s is string => s !== undefined)
        .join(' | ')
    }
    case 'manual_rubric':
      return key.teacherReferenceNote ?? '(ตรวจตาม Rubric)'
    case 'ungraded':
      return null
  }
}

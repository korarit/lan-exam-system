import type { DynamicFormDefinition, ZtformContainer } from '../shared/form-schema'
import { isFormItemQuestion } from '../shared/form-schema'
import type { FormResponsesSnapshot, FormItemAnswerView, FormItemStatsView } from '../shared/form-responses-view'
import { correctAnswerDisplay } from './responses-snapshot'
import { answerToDisplay } from './csv-exporter'
import {
  buildZtresultsContainer,
  type ZtresultsContainer,
  type ZtresultsArtifactsRecord,
  type ZtresultsStudentRecord
} from './ztresults-io'
import type { StoredFormResponseRow, FormResponseStore } from './form-response-store'
import type { FileVault } from './file-vault'
import { buildResponsesCsv, canonicalQuestionItems } from './csv-exporter'
import { summarizeGrading, type ItemGradeOutcome } from './form-grader'
import type { FormItemGradeStatus } from '../shared/form-answer-schema'
import type { HostDatabase } from '@main/storage/db'

/* ============================================================
 * Phase 7 โ€” Result Exporter glue
 * - CSV (7.4.1): เนเธ–เธงเธ•เนเธญเธเธฑเธเน€เธฃเธตเธขเธ + เธเธญเธฅเธฑเธกเธเนเธฃเธฒเธขเธเนเธญเธกเธฒเธ•เธฃเธเธฒเธ (เธเธฑเธ”เธ”เนเธงเธข itemId)
 * - .ztresults (7.4.2): .ztform + เธเธณเธ•เธญเธเธฃเธฒเธขเธเธ + score + เนเธเธฅเนเนเธเธ + audit tail
 * ============================================================ */

interface StudentRow {
  student_id: string
  display_name: string
  seed: string
  joined_at_ms: number
  status: string
  suspicion_score: number
}

function loadStudents(db: HostDatabase, roomId: string): StudentRow[] {
  return db.db
    .prepare(
      `SELECT student_id, display_name, seed, joined_at_ms, status, suspicion_score
       FROM students WHERE session_id = ? ORDER BY display_name, student_id`
    )
    .all(roomId) as unknown as StudentRow[]
}

function loadExamWindow(db: HostDatabase, roomId: string): { started_at_ms: number | null; ended_at_ms: number | null } | undefined {
  return db.db
    .prepare('SELECT started_at_ms, ended_at_ms FROM exam_sessions WHERE id = ?')
    .get(roomId) as { started_at_ms: number | null; ended_at_ms: number | null } | undefined
}

function groupRowsByStudent(rows: StoredFormResponseRow[]): Map<string, StoredFormResponseRow[]> {
  const byStudent = new Map<string, StoredFormResponseRow[]>()
  for (const row of rows) {
    const bucket = byStudent.get(row.studentId) ?? []
    bucket.push(row)
    byStudent.set(row.studentId, bucket)
  }
  return byStudent
}

function lastSubmittedAt(rows: StoredFormResponseRow[]): number | null {
  return rows.reduce<number | null>((acc, r) => {
    if (r.submittedAtMs === null) return acc
    return acc === null ? r.submittedAtMs : Math.max(acc, r.submittedAtMs)
  }, null)
}

function criticalCount(db: HostDatabase, roomId: string, studentId: string): number {
  const row = db.db
    .prepare(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE session_id = ? AND student_id = ? AND severity = 'critical'"
    )
    .get(roomId, studentId) as { c: number } | undefined
  return row?.c ?? 0
}

function manualMap(rows: StoredFormResponseRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) if (r.manualPoints !== null) out[r.itemId] = r.manualPoints
  return out
}

/** outcomes เธ•เนเธญเธเธฑเธเน€เธฃเธตเธขเธ (max เธเธญเธเธเนเธญเน€เธญเธฒเธเธฒเธเธเธญเธฃเนเธกเนเธกเนเนเธเนเนเธ–เธง DB) */
function outcomesFor(
  studentRows: StoredFormResponseRow[],
  maxByItem: Map<string, number>
): ItemGradeOutcome[] {
  return studentRows.map((r) => ({
    itemId: r.itemId,
    status: r.status,
    earnedPoints: r.earnedPoints,
    maxPoints: maxByItem.get(r.itemId) ?? 0,
    violations: []
  }))
}

function securityStatusOf(suspicionScore: number, criticalEvents: number): 'NORMAL' | 'WARNING' | 'CRITICAL' {
  if (criticalEvents > 0) return 'CRITICAL'
  if (suspicionScore >= 40) return 'WARNING'
  return 'NORMAL'
}

/* ---------- 7.4.1: CSV ---------- */

export function buildResultsCsvForRoom(
  db: HostDatabase,
  roomId: string,
  roomName: string,
  form: DynamicFormDefinition,
  store: FormResponseStore
): Uint8Array {
  const rows = store.listResponses(roomId)
  const byStudent = groupRowsByStudent(rows)
  const studentsRaw = loadStudents(db, roomId)
  const examWindow = loadExamWindow(db, roomId)
  const questions = canonicalQuestionItems(form)
  const maxByItem = new Map(
    questions.map((q) => [q.item.itemId, isFormItemQuestion(q.item) ? q.item.points : 0] as const)
  )

  const csvStudents = studentsRaw.map((student) => {
    const studentRows = byStudent.get(student.student_id) ?? []
    const totals = summarizeGrading(
      outcomesFor(studentRows, maxByItem),
      manualMap(studentRows)
    )
    const criticalEvents = criticalCount(db, roomId, student.student_id)
    return {
      profile: {
        studentId: student.student_id,
        studentName: student.display_name,
        startedAtMs: examWindow?.started_at_ms ?? null,
        submittedAtMs: lastSubmittedAt(studentRows),
        securityStatus: securityStatusOf(student.suspicion_score, criticalEvents),
        suspicionScore: student.suspicion_score,
        criticalEvents,
        proctorNote: ''
      },
      answers: {
        studentId: student.student_id,
        responses: new Map(studentRows.map((r) => [r.itemId, r] as const)),
        answeredCount: studentRows.length,
        anyManualPending: studentRows.some((r) => r.status === 'needs-manual'),
        totalScore: totals.totalPoints,
        maxScore: totals.maxPoints,
        scorePercent: totals.percent
      }
    }
  })

  return buildResponsesCsv({
    form,
    students: csvStudents,
    roomName,
    examStartedAtMs: examWindow?.started_at_ms ?? null
  })
}

/* ---------- 7.4.2: .ztresults ---------- */

export function buildZtresultsForRoom(
  db: HostDatabase,
  roomId: string,
  roomName: string,
  ztform: ZtformContainer,
  store: FormResponseStore,
  vault: FileVault,
  endedAtMs: number | null
): ZtresultsContainer {
  const rows = store.listResponses(roomId)
  const byStudent = groupRowsByStudent(rows)
  const studentsRaw = loadStudents(db, roomId)
  const examWindow = loadExamWindow(db, roomId)
  const questions = canonicalQuestionItems(ztform.form)
  const maxByItem = new Map(
    questions.map((q) => [q.item.itemId, isFormItemQuestion(q.item) ? q.item.points : 0] as const)
  )

  const responses: ZtresultsStudentRecord[] = studentsRaw.map((student) => {
    const studentRows = byStudent.get(student.student_id) ?? []
    const responsesMap = new Map(studentRows.map((r) => [r.itemId, r] as const))
    const items = questions.map((q) => {
      const r = responsesMap.get(q.item.itemId)
      return {
        itemId: q.item.itemId,
        value: r?.value ?? ({ kind: 'none' } as const),
        artifacts: r?.artifacts ?? [],
        status: (r?.status ?? 'invalid') as FormItemGradeStatus,
        earnedPoints: r?.earnedPoints ?? 0,
        manualPoints: r?.manualPoints ?? null,
        violations: safeViolations(r),
        timeSpentMs: r?.journey?.timeSpentMs ?? 0,
        submittedAtMs: r?.submittedAtMs ?? null,
        revision: r?.revision ?? 0
      }
    })
    return {
      studentId: student.student_id,
      studentName: student.display_name,
      studentSeed: student.seed,
      startedAtMs: examWindow?.started_at_ms ?? null,
      submittedAtMs: lastSubmittedAt(studentRows),
      finishReason: student.status === 'submitted' ? 'submitted' : null,
      items,
      totals: summarizeGrading(
        items.map((it) => ({
          itemId: it.itemId,
          status: it.status,
          earnedPoints: it.earnedPoints,
          maxPoints: maxByItem.get(it.itemId) ?? 0,
          violations: it.violations
        })),
        manualMap(studentRows)
      )
    }
  })

  /** เธเธฑเธเนเธเธฅเนเนเธเธเธ—เธฑเนเธเธซเนเธญเธ (เธ–เธญเธ”เธฃเธซเธฑเธชเธเธฒเธ vault โ’ base64) เน€เธเธทเนเธญเธเธเนเธเน€เธเธฃเธทเนเธญเธเธเธฃเธน */
  const artifacts: ZtresultsArtifactsRecord[] = []
  for (const meta of store.listArtifactMeta(roomId)) {
    try {
      const blob = vault.readArtifact(artifactMetaFromRow(meta), roomId)
      artifacts.push({
        studentId: meta.student_id,
        itemId: meta.item_id,
        artifactId: meta.artifact_id,
        fileName: meta.file_name,
        mimeType: meta.mime_type,
        sizeBytes: meta.size_bytes,
        sha256: meta.sha256,
        dataBase64: blob.toString('base64')
      })
    } catch {
      void meta
    }
  }

  return buildZtresultsContainer({
    roomId,
    roomName,
    createdAtMs: examWindow?.ended_at_ms ?? Date.now(),
    endedAtMs,
    ztform,
    responses,
    artifacts,
    auditTail: listAuditTail(db, roomId, 300)
  })
}

function artifactMetaFromRow(meta: {
  student_id: string
  item_id: string
  artifact_id: string
  file_name: string
  mime_type: string
  size_bytes: number
  sha256: string
  file_path: string
  iv: string
  tag: string
  row_hmac: string
}): Parameters<FileVault['readArtifact']>[0] {
  return {
    studentId: meta.student_id,
    itemId: meta.item_id,
    artifactId: meta.artifact_id,
    fileName: meta.file_name,
    mimeType: meta.mime_type,
    sizeBytes: meta.size_bytes,
    sha256: meta.sha256,
    filePath: meta.file_path,
    iv: meta.iv,
    tag: meta.tag,
    rowHmac: meta.row_hmac
  }
}

function listAuditTail(
  db: HostDatabase,
  roomId: string,
  limit: number
): ZtresultsContainer['auditTail'] {
  const rows = db.db
    .prepare(
      `SELECT seq_no, timestamp_ms, event_type, severity, student_id, summary_text, entry_hash, prev_hash
       FROM audit_logs WHERE session_id = ? ORDER BY seq_no DESC LIMIT ?`
    )
    .all(roomId, limit) as unknown as Array<{
    seq_no: number
    timestamp_ms: number
    event_type: string
    severity: string
    student_id: string | null
    summary_text: string
    entry_hash: string
    prev_hash: string
  }>
  return rows
    .map((r) => ({
      seqNo: r.seq_no,
      timestampMs: r.timestamp_ms,
      eventType: r.event_type,
      severity: (r.severity === 'critical' ? 'critical' : r.severity === 'warning' ? 'warning' : 'normal') as
        | 'normal'
        | 'warning'
        | 'critical',
      studentId: r.student_id,
      summaryText: r.summary_text,
      entryHash: r.entry_hash,
      prevHash: r.prev_hash
    }))
    .reverse()
}

function safeViolations(row: StoredFormResponseRow | undefined): Array<{ code: string; message: string }> {
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

/* ---------- 7.4.2: .ztresults → Snapshot ให้หน้า Dashboard ใช้แบบ offline ---------- */

export function snapshotFromZtresults(parsed: {
  manifest: ZtresultsContainer['manifest']
  form: DynamicFormDefinition
  responses: ZtresultsStudentRecord[]
  auditTail: ZtresultsContainer['auditTail']
}): FormResponsesSnapshot {
  const form = parsed.form
  const questions = canonicalQuestionItems(form)
  const maxByItem = new Map(
    questions.map((q) => [q.item.itemId, isFormItemQuestion(q.item) ? q.item.points : 0] as const)
  )

  const students: FormResponsesSnapshot['students'] = parsed.responses.map((rec) => {
    const responsesMap = new Map(rec.items.map((it) => [it.itemId, it] as const))
    const items: FormItemAnswerView[] = questions
      .filter((q) => isFormItemQuestion(q.item))
      .map((q) => {
        const stored = responsesMap.get(q.item.itemId)
        return {
          itemId: q.item.itemId,
          inputType: (q.item as { inputType: FormItemAnswerView['inputType'] }).inputType,
          displayValue: stored !== undefined ? answerToDisplay(q.item, rowLike(q.item.itemId, stored)) : '',
          value: stored?.value ?? { kind: 'none' as const },
          artifacts: (stored?.artifacts ?? []).map((a) => ({
            artifactId: a.artifactId,
            fileName: a.fileName,
            sizeBytes: a.sizeBytes,
            sha256: a.sha256
          })),
          status: (stored?.status ?? 'invalid') as FormItemAnswerView['status'],
          earnedPoints: stored?.earnedPoints ?? 0,
          manualPoints: stored?.manualPoints ?? null,
          maxPoints: maxByItem.get(q.item.itemId) ?? 0,
          violations: (stored?.violations ?? []) as Array<{ code: string; message: string }>,
          journey: stored !== undefined
            ? { itemId: q.item.itemId, timeSpentMs: stored.timeSpentMs, submittedAtMs: stored.submittedAtMs ?? 0 }
            : null,
          revision: stored?.revision ?? 0,
          updatedAtMs: stored?.submittedAtMs ?? 0,
          correctDisplay: correctAnswerDisplay(q.item)
        }
      })
    const manualByItem: Record<string, number> = {}
    for (const view of items) {
      if (view.manualPoints !== null) manualByItem[view.itemId] = view.manualPoints
    }
    const totals = summarizeGrading(
      items.map((v) => ({
        itemId: v.itemId,
        status: v.status,
        earnedPoints: v.earnedPoints,
        maxPoints: v.maxPoints,
        violations: v.violations
      })),
      manualByItem
    )
    return {
      studentId: rec.studentId,
      studentName: rec.studentName,
      studentSeed: rec.studentSeed,
      joinedAtMs: rec.startedAtMs ?? parsed.manifest.createdAtMs,
      submittedAtMs: rec.submittedAtMs,
      finishReason: rec.finishReason,
      security: { status: 'NORMAL' as const, suspicionScore: 0, criticalEvents: 0, proctorNote: '' },
      totals,
      items
    }
  })

  const percents = students.map((s) => s.totals.percent)
  const sorted = [...percents].sort((a, b) => a - b)
  const mean = percents.length > 0 ? percents.reduce((a, b) => a + b, 0) / percents.length : 0

  const itemStats: FormItemStatsView[] = questions.map((q, idx) => {
    if (!isFormItemQuestion(q.item)) {
      return { itemId: q.item.itemId, inputType: q.item.inputType, index: idx + 1, maxPoints: 0, responsesCount: 0, correctCount: 0, correctRate: 0, flaggedHard: false }
    }
    let responses = 0
    let correct = 0
    for (const sv of students) {
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

  return {
    kind: 'archive',
    roomId: parsed.manifest.roomId,
    roomName: parsed.manifest.roomName,
    formTitle: parsed.manifest.formTitle,
    form,
    startedAtMs: null,
    endedAtMs: parsed.manifest.endedAtMs,
    students,
    itemStats,
    distribution: [0, 25, 50, 75].map((edge, index, edges) => {
      const next = edges[index + 1] ?? 100
      return {
        bucketLow: edge,
        bucketHigh: next,
        count: students.filter((s) => s.totals.percent >= edge && s.totals.percent < next).length
      }
    }),
    summary: {
      mean: Math.round(mean * 10) / 10,
      median: medianOf(sorted),
      min: sorted.length > 0 ? sorted[0]! : 0,
      max: sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
      studentCount: students.length,
      needsManualCount: students.reduce((acc, s) => acc + s.totals.needsManualCount, 0)
    },
    regradeHistory: []
  }
}

function medianOf(sorted: number[]): number {
  if (sorted.length === 0) return 0
  return sorted.length % 2 === 1
    ? (sorted[(sorted.length - 1) / 2] as number)
    : ((sorted[sorted.length / 2 - 1] as number) + (sorted[sorted.length / 2] as number)) / 2
}

function rowLike(itemId: string, stored: ZtresultsStudentRecord['items'][number]): Parameters<typeof answerToDisplay>[1] {
  return {
    roomId: '',
    studentId: '',
    itemId,
    status: stored.status as FormItemAnswerView['status'],
    earnedPoints: stored.earnedPoints,
    manualPoints: stored.manualPoints,
    violationsJson: JSON.stringify(stored.violations),
    value: stored.value,
    artifacts: stored.artifacts,
    journey: { itemId, timeSpentMs: stored.timeSpentMs, submittedAtMs: stored.submittedAtMs ?? 0 },
    submittedAtMs: stored.submittedAtMs,
    revision: stored.revision,
    updatedAtMs: stored.submittedAtMs ?? 0
  }
}


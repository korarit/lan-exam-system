import {
  encryptAes256Gcm,
  decryptAes256Gcm,
  computeHmac,
  verifyHmacTimingSafe,
  type EncryptedPayload
} from '@main/crypto/primitives'
import type { HostDatabase } from '@main/storage/db'
import {
  VirtualEntrySchema,
  type VirtualEntry
} from '../shared/code-schema'

/* ============================================================
 * Phase 10 (10.1) — CodeWorkspaceStore (SQLite + AES-256-GCM + rowHmac)
 * - code_draft_snapshots: autosave ล่าสุดของโปรเจกต์นักเรียน (ทับค่าเดิม)
 * - code_submissions: งานที่กดส่งแล้ว + สถานะการตรวจ/คะแนน (plaintext)
 * - code_grading_reports: ผลตรวจราย test case (JSON ไม่มีโค้ดนักเรียน)
 * คีย์ = PBKDF2(crypto_salt ของห้อง) แบบเดียวกับ FormResponseStore
 * ============================================================ */

export type CodeSubmissionStatus = 'queued' | 'grading' | 'graded' | 'blocked' | 'error'

export interface CodeSubmissionRecord {
  roomId: string
  studentId: string
  packageId: string
  status: CodeSubmissionStatus
  earnedPoints: number
  manualPoints: number | null
  passedCount: number
  totalCount: number
  fileCount: number
  blockedReason: string | null
  gradedAtMs: number | null
  entries: VirtualEntry[]
  submittedAtMs: number
  updatedAtMs: number
}

export interface CodeDraftRecord {
  roomId: string
  studentId: string
  packageId: string
  entries: VirtualEntry[]
  entriesCount: number
  projectBytes: number
  updatedAtMs: number
}

export interface CodeGradingReportRow {
  roomId: string
  studentId: string
  packageId: string
  passedCount: number
  totalCount: number
  earnedPoints: number
  totalPoints: number
  reportJson: string
  gradedAtMs: number
}

export class CodeWorkspaceStore {
  constructor(
    private readonly db: HostDatabase,
    private readonly getStorageKey: (roomId: string) => Buffer
  ) {}

  /* ---------- autosave drafts ---------- */

  upsertDraft(input: {
    roomId: string
    studentId: string
    packageId: string
    entries: VirtualEntry[]
    projectBytes: number
    updatedAtMs: number
  }): void {
    const key = this.getStorageKey(input.roomId)
    const plain = JSON.stringify(input.entries)
    const payload = encryptAes256Gcm(plain, key)
    const hmac = computeHmac(
      key,
      hmacParts('draft', input.roomId, input.studentId, input.packageId, payload)
    ).toString('base64')
    this.db.db
      .prepare(
        `INSERT INTO code_draft_snapshots
           (session_id, student_id, package_id, entries_count, project_bytes,
            ciphertext, iv, tag, hmac, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, student_id, package_id) DO UPDATE SET
           entries_count = excluded.entries_count,
           project_bytes = excluded.project_bytes,
           ciphertext = excluded.ciphertext,
           iv = excluded.iv,
           tag = excluded.tag,
           hmac = excluded.hmac,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        input.roomId,
        input.studentId,
        input.packageId,
        input.entries.length,
        input.projectBytes,
        payload.ciphertext,
        payload.iv,
        payload.tag,
        hmac,
        input.updatedAtMs
      )
  }

  getDraft(roomId: string, studentId: string, packageId: string): CodeDraftRecord | null {
    const row = this.db.db
      .prepare(
        `SELECT student_id, package_id, entries_count, project_bytes,
                ciphertext, iv, tag, hmac, updated_at_ms
         FROM code_draft_snapshots
         WHERE session_id = ? AND student_id = ? AND package_id = ?`
      )
      .get(roomId, studentId, packageId) as
      | {
          student_id: string
          package_id: string
          entries_count: number
          project_bytes: number
          ciphertext: string
          iv: string
          tag: string
          hmac: string
          updated_at_ms: number
        }
      | undefined
    if (!row) return null
    const key = this.getStorageKey(roomId)
    const payload: EncryptedPayload = { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }
    if (
      !verifyHmacTimingSafe(
        key,
        hmacParts('draft', roomId, row.student_id, row.package_id, payload),
        Buffer.from(row.hmac, 'base64')
      )
    ) {
      throw new Error('CODE_DRAFT_TAMPERED')
    }
    const entries = VirtualEntrySchema.array().parse(
      JSON.parse(decryptAes256Gcm(payload, key).toString('utf8')) as unknown
    )
    return {
      roomId,
      studentId: row.student_id,
      packageId: row.package_id,
      entries,
      entriesCount: row.entries_count,
      projectBytes: row.project_bytes,
      updatedAtMs: row.updated_at_ms
    }
  }

  /* ---------- submissions ---------- */

  upsertSubmission(input: {
    roomId: string
    studentId: string
    packageId: string
    status: CodeSubmissionStatus
    earnedPoints: number
    manualPoints?: number | null
    passedCount: number
    totalCount: number
    fileCount: number
    blockedReason?: string | null
    gradedAtMs?: number | null
    entries: VirtualEntry[]
    submittedAtMs: number
    updatedAtMs: number
  }): void {
    const key = this.getStorageKey(input.roomId)
    const plain = JSON.stringify(input.entries)
    const payload = encryptAes256Gcm(plain, key)
    const hmac = computeHmac(
      key,
      hmacParts('submission', input.roomId, input.studentId, input.packageId, payload)
    ).toString('base64')
    this.db.db
      .prepare(
        `INSERT INTO code_submissions
           (session_id, student_id, package_id, status, earned_points, manual_points,
            passed_count, total_count, file_count, blocked_reason, graded_at_ms,
            ciphertext, iv, tag, hmac, submitted_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, student_id, package_id) DO UPDATE SET
           status = excluded.status,
           earned_points = excluded.earned_points,
           manual_points = excluded.manual_points,
           passed_count = excluded.passed_count,
           total_count = excluded.total_count,
           file_count = excluded.file_count,
           blocked_reason = excluded.blocked_reason,
           graded_at_ms = excluded.graded_at_ms,
           ciphertext = excluded.ciphertext,
           iv = excluded.iv,
           tag = excluded.tag,
           hmac = excluded.hmac,
           submitted_at_ms = excluded.submitted_at_ms,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        input.roomId,
        input.studentId,
        input.packageId,
        input.status,
        input.earnedPoints,
        input.manualPoints ?? null,
        input.passedCount,
        input.totalCount,
        input.fileCount,
        input.blockedReason ?? null,
        input.gradedAtMs ?? null,
        payload.ciphertext,
        payload.iv,
        payload.tag,
        hmac,
        input.submittedAtMs,
        input.updatedAtMs
      )
  }

  setSubmissionStatus(input: {
    roomId: string
    studentId: string
    packageId: string
    status: CodeSubmissionStatus
    updatedAtMs: number
  }): void {
    this.db.db
      .prepare(
        `UPDATE code_submissions SET status = ?, updated_at_ms = ?
         WHERE session_id = ? AND student_id = ? AND package_id = ?`
      )
      .run(input.status, input.updatedAtMs, input.roomId, input.studentId, input.packageId)
  }

  setManualPoints(input: {
    roomId: string
    studentId: string
    packageId: string
    manualPoints: number | null
    updatedAtMs: number
  }): void {
    this.db.db
      .prepare(
        `UPDATE code_submissions SET manual_points = ?, updated_at_ms = ?
         WHERE session_id = ? AND student_id = ? AND package_id = ?`
      )
      .run(input.manualPoints, input.updatedAtMs, input.roomId, input.studentId, input.packageId)
  }

  getSubmission(roomId: string, studentId: string, packageId: string): CodeSubmissionRecord | null {
    const row = this.db.db
      .prepare(
        `SELECT student_id, package_id, status, earned_points, manual_points,
                passed_count, total_count, file_count, blocked_reason, graded_at_ms,
                ciphertext, iv, tag, hmac, submitted_at_ms, updated_at_ms
         FROM code_submissions
         WHERE session_id = ? AND student_id = ? AND package_id = ?`
      )
      .get(roomId, studentId, packageId) as SubmissionRow | undefined
    if (!row) return null
    return this.decodeSubmission(roomId, row)
  }

  listSubmissions(roomId: string): CodeSubmissionRecord[] {
    const rows = this.db.db
      .prepare(
        `SELECT student_id, package_id, status, earned_points, manual_points,
                passed_count, total_count, file_count, blocked_reason, graded_at_ms,
                ciphertext, iv, tag, hmac, submitted_at_ms, updated_at_ms
         FROM code_submissions
         WHERE session_id = ? ORDER BY student_id, package_id`
      )
      .all(roomId) as SubmissionRow[]
    return rows.map((row) => this.decodeSubmission(roomId, row))
  }

  hasSubmissions(roomId: string): boolean {
    const row = this.db.db
      .prepare('SELECT COUNT(*) AS c FROM code_submissions WHERE session_id = ?')
      .get(roomId) as { c: number } | undefined
    return (row?.c ?? 0) > 0
  }

  /* ---------- grading reports ---------- */

  upsertGradingReport(input: {
    roomId: string
    studentId: string
    packageId: string
    passedCount: number
    totalCount: number
    earnedPoints: number
    totalPoints: number
    reportJson: string
    gradedAtMs: number
  }): void {
    this.db.db
      .prepare(
        `INSERT INTO code_grading_reports
           (session_id, student_id, package_id, passed_count, total_count,
            earned_points, total_points, report_json, graded_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, student_id, package_id) DO UPDATE SET
           passed_count = excluded.passed_count,
           total_count = excluded.total_count,
           earned_points = excluded.earned_points,
           total_points = excluded.total_points,
           report_json = excluded.report_json,
           graded_at_ms = excluded.graded_at_ms`
      )
      .run(
        input.roomId,
        input.studentId,
        input.packageId,
        input.passedCount,
        input.totalCount,
        input.earnedPoints,
        input.totalPoints,
        input.reportJson,
        input.gradedAtMs
      )
  }

  getGradingReport(roomId: string, studentId: string, packageId: string): CodeGradingReportRow | null {
    const row = this.db.db
      .prepare(
        `SELECT student_id, package_id, passed_count, total_count, earned_points,
                total_points, report_json, graded_at_ms
         FROM code_grading_reports
         WHERE session_id = ? AND student_id = ? AND package_id = ?`
      )
      .get(roomId, studentId, packageId) as
      | {
          student_id: string
          package_id: string
          passed_count: number
          total_count: number
          earned_points: number
          total_points: number
          report_json: string
          graded_at_ms: number
        }
      | undefined
    if (!row) return null
    return {
      roomId,
      studentId: row.student_id,
      packageId: row.package_id,
      passedCount: row.passed_count,
      totalCount: row.total_count,
      earnedPoints: row.earned_points,
      totalPoints: row.total_points,
      reportJson: row.report_json,
      gradedAtMs: row.graded_at_ms
    }
  }

  appendRegradeHistory(roomId: string, packageSha256: string, summaryJson: string): void {
    this.db.db
      .prepare(
        `INSERT INTO code_regrade_history (session_id, run_at_ms, trigger_source, package_sha256, summary_json)
         VALUES (?, ?, 'teacher-ui', ?, ?)`
      )
      .run(roomId, Date.now(), packageSha256, summaryJson)
  }

  /* ---------- teacher comments (รายไฟล์ใน Inspector) ---------- */

  upsertComment(input: {
    roomId: string
    studentId: string
    packageId: string
    path: string
    comment: string
    updatedAtMs: number
  }): void {
    if (input.comment.trim() === '') {
      this.db.db
        .prepare(
          `DELETE FROM code_comments WHERE session_id = ? AND student_id = ? AND package_id = ? AND path = ?`
        )
        .run(input.roomId, input.studentId, input.packageId, input.path)
      return
    }
    this.db.db
      .prepare(
        `INSERT INTO code_comments (session_id, student_id, package_id, path, comment, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, student_id, package_id, path) DO UPDATE SET
           comment = excluded.comment,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(input.roomId, input.studentId, input.packageId, input.path, input.comment.slice(0, 5000), input.updatedAtMs)
  }

  listComments(
    roomId: string,
    studentId: string,
    packageId: string
  ): Array<{ path: string; comment: string; updatedAtMs: number }> {
    return this.db.db
      .prepare(
        `SELECT path, comment, updated_at_ms AS updatedAtMs FROM code_comments
         WHERE session_id = ? AND student_id = ? AND package_id = ? ORDER BY path`
      )
      .all(roomId, studentId, packageId) as Array<{ path: string; comment: string; updatedAtMs: number }>
  }

  /* ---------- internals ---------- */

  private decodeSubmission(roomId: string, row: SubmissionRow): CodeSubmissionRecord {
    const key = this.getStorageKey(roomId)
    const payload: EncryptedPayload = { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }
    if (
      !verifyHmacTimingSafe(
        key,
        hmacParts('submission', roomId, row.student_id, row.package_id, payload),
        Buffer.from(row.hmac, 'base64')
      )
    ) {
      throw new Error('CODE_SUBMISSION_TAMPERED')
    }
    const entries = VirtualEntrySchema.array().parse(
      JSON.parse(decryptAes256Gcm(payload, key).toString('utf8')) as unknown
    )
    return {
      roomId,
      studentId: row.student_id,
      packageId: row.package_id,
      status: row.status,
      earnedPoints: row.earned_points,
      manualPoints: row.manual_points,
      passedCount: row.passed_count,
      totalCount: row.total_count,
      fileCount: row.file_count,
      blockedReason: row.blocked_reason,
      gradedAtMs: row.graded_at_ms,
      entries,
      submittedAtMs: row.submitted_at_ms,
      updatedAtMs: row.updated_at_ms
    }
  }
}

interface SubmissionRow {
  student_id: string
  package_id: string
  status: CodeSubmissionStatus
  earned_points: number
  manual_points: number | null
  passed_count: number
  total_count: number
  file_count: number
  blocked_reason: string | null
  graded_at_ms: number | null
  ciphertext: string
  iv: string
  tag: string
  hmac: string
  submitted_at_ms: number
  updated_at_ms: number
}

function hmacParts(
  kind: string,
  roomId: string,
  studentId: string,
  packageId: string,
  payload: EncryptedPayload
): string {
  return [kind, roomId, studentId, packageId, payload.ciphertext, payload.iv, payload.tag].join('\u0000')
}

import {
  encryptAes256Gcm,
  decryptAes256Gcm,
  computeHmac,
  verifyHmacTimingSafe,
  type EncryptedPayload
} from '@main/crypto/primitives'
import type { HostDatabase } from '@main/storage/db'
import type {
  StoredAnswerValue,
  StoredArtifactDescriptor,
  FormItemGradeStatus,
  FormJourneyRecord
} from '../shared/form-answer-schema'
import { StoredAnswerValueSchema, StoredArtifactDescriptorSchema } from '../shared/form-answer-schema'

/* ============================================================
 * Phase 7 — FormResponseStore (SQLite + AES-256-GCM + rowHmac)
 * เก็บคำตอบรายข้อของโมดูล dynamic-form แบบ at-rest encrypted
 * ค่าคำตอบ (StoredAnswerValue) อยู่ใน ciphertext เท่านั้น
 * สถานะการตรวจ/คะแนนทอลค่าอ่านตรง ๆ เพื่อให้ Dashboard/Export เร็ว
 * ทุกแถวผูก HMAC(room_key, ...) — แก้ไฟล์ .sqlite โดยตรง = จับได้
 * ============================================================ */

export interface UpsertResponseInput {
  roomId: string
  studentId: string
  itemId: string
  status: FormItemGradeStatus
  earnedPoints: number
  manualPoints?: number
  violationsJson: string
  value: StoredAnswerValue
  artifacts: StoredArtifactDescriptor[]
  journey: FormJourneyRecord | null
  submittedAtMs: number | null
  updatedAtMs: number
}

export interface StoredFormResponseRow {
  roomId: string
  studentId: string
  itemId: string
  status: FormItemGradeStatus
  earnedPoints: number
  manualPoints: number | null
  violationsJson: string
  value: StoredAnswerValue
  artifacts: StoredArtifactDescriptor[]
  journey: FormJourneyRecord | null
  submittedAtMs: number | null
  revision: number
  updatedAtMs: number
}

export class FormResponseTamperedError extends Error {
  constructor() {
    super('FORM_RESPONSE_TAMPERED')
  }
}

interface RowShape {
  student_id: string
  item_id: string
  status: string
  earned_points: number
  manual_points: number | null
  violations_json: string
  ciphertext: string
  iv: string
  tag: string
  hmac: string
  time_spent_ms: number
  submitted_at_ms: number | null
  revision: number
  updated_at_ms: number
}

export class FormResponseStore {
  constructor(
    private readonly db: HostDatabase,
    /** คีย์ 32 ไบต์ต่อห้อง (ผูกกับ crypto_salt ของ exam_sessions) */
    private readonly getStorageKey: (roomId: string) => Buffer
  ) {}

  /** ครูให้คะแนนข้ออัตนัยเอง: เปลี่ยนสถานะเป็น manual-graded โดยคำตอบดิบคงเดิม */
  upsertManualGradeStatus(input: {
    roomId: string
    studentId: string
    itemId: string
    manualPoints: number
    updatedAtMs: number
  }): void {
    const rows = this.listResponsesForStudent(input.roomId, input.studentId)
    const row = rows.find((r) => r.itemId === input.itemId)
    if (row === undefined) return
    this.upsert({
      roomId: input.roomId,
      studentId: input.studentId,
      itemId: input.itemId,
      status: 'manual-graded',
      earnedPoints: Math.round(input.manualPoints * 100) / 100,
      manualPoints: Math.round(input.manualPoints * 100) / 100,
      violationsJson: row.violationsJson,
      value: row.value,
      artifacts: row.artifacts,
      journey: row.journey,
      submittedAtMs: row.submittedAtMs,
      updatedAtMs: input.updatedAtMs
    })
  }

  /** ครูให้คะแนนข้ออัตนัยเอง (รับตัวเลขจากหน้า Grading) */
  setManualGrade(input: {
    roomId: string
    studentId: string
    itemId: string
    manualPoints: number | null
    updatedAtMs: number
  }): void {
    this.db.db
      .prepare(
        `UPDATE form_responses
         SET manual_points = ?, updated_at_ms = ?
         WHERE session_id = ? AND student_id = ? AND item_id = ?`
      )
      .run(input.manualPoints, input.updatedAtMs, input.roomId, input.studentId, input.itemId)
  }

  /* ---------- ผู้ใช้แก้ข้อมูล (Export / Dashboard / Regrade) ---------- */

  listResponses(roomId: string): StoredFormResponseRow[] {
    const rows = this.db.db
      .prepare(
        `SELECT student_id, item_id, status, earned_points, manual_points, violations_json, ciphertext, iv, tag, hmac,
                time_spent_ms, submitted_at_ms, revision, updated_at_ms
         FROM form_responses WHERE session_id = ? ORDER BY student_id, item_id`
      )
      .all(roomId) as RowShape[]
    const key = this.getStorageKey(roomId)
    return rows.map((row) => this.decodeRow(key, row, roomId))
  }

  listResponsesForStudent(roomId: string, studentId: string): StoredFormResponseRow[] {
    const rows = this.db.db
      .prepare(
        `SELECT student_id, item_id, status, earned_points, manual_points, violations_json, ciphertext, iv, tag, hmac,
                time_spent_ms, submitted_at_ms, revision, updated_at_ms
         FROM form_responses
         WHERE session_id = ? AND student_id = ? ORDER BY item_id`
      )
      .all(roomId, studentId) as RowShape[]
    const key = this.getStorageKey(roomId)
    return rows.map((row) => this.decodeRow(key, row, roomId))
  }

  listArtifactMeta(roomId: string): StoredArtifactMetaRow[] {
    const rows = this.db.db
      .prepare(
        `SELECT student_id, item_id, artifact_id, file_name, mime_type, size_bytes, sha256, file_path, iv, tag, row_hmac
         FROM uploaded_artifacts WHERE session_id = ? ORDER BY student_id, item_id, artifact_id`
      )
      .all(roomId) as StoredArtifactMetaRow[]
    return rows
  }

  listArtifactMetaForStudent(roomId: string, studentId: string): StoredArtifactMetaRow[] {
    const rows = this.db.db
      .prepare(
        `SELECT student_id, item_id, artifact_id, file_name, mime_type, size_bytes, sha256, file_path, iv, tag, row_hmac
         FROM uploaded_artifacts WHERE session_id = ? AND student_id = ? ORDER BY item_id, artifact_id`
      )
      .all(roomId, studentId) as StoredArtifactMetaRow[]
    return rows
  }

  /* ---------- upsert (เรียกหลัง validate+grade เท่านั้น) ---------- */

  upsert(input: UpsertResponseInput): void {
    const key = this.getStorageKey(input.roomId)
    const encrypted = this.encryptRow(key, input)
    this.db.db
      .prepare(
        `INSERT INTO form_responses
           (session_id, student_id, item_id, status, earned_points, manual_points, violations_json,
            ciphertext, iv, tag, hmac, time_spent_ms, submitted_at_ms, revision, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(session_id, student_id, item_id) DO UPDATE SET
           status = excluded.status,
           earned_points = excluded.earned_points,
           manual_points = excluded.manual_points,
           violations_json = excluded.violations_json,
           ciphertext = excluded.ciphertext,
           iv = excluded.iv,
           tag = excluded.tag,
           hmac = excluded.hmac,
           time_spent_ms = excluded.time_spent_ms,
           submitted_at_ms = excluded.submitted_at_ms,
           revision = form_responses.revision + 1,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        input.roomId,
        input.studentId,
        input.itemId,
        input.status,
        input.earnedPoints,
        input.manualPoints ?? null,
        input.violationsJson,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        encrypted.hmac,
        input.journey?.timeSpentMs ?? 0,
        input.submittedAtMs,
        input.updatedAtMs
      )
  }

  /* ---------- encryption pieces ---------- */

  private encryptRow(key: Buffer, input: UpsertResponseInput): { ciphertext: string; iv: string; tag: string; hmac: string } {
    const plain = JSON.stringify({
      value: input.value,
      artifacts: input.artifacts,
      journey: input.journey
    })
    const payload = encryptAes256Gcm(plain, key)
    return {
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      tag: payload.tag,
      hmac: computeHmac(key, this.hmacParts(input.roomId, input.studentId, input.itemId, payload)).toString('base64')
    }
  }

  private decodeRow(key: Buffer, row: RowShape, roomId: string): StoredFormResponseRow {
    const payload: EncryptedPayload = { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }
    if (
      !verifyHmacTimingSafe(key, this.hmacParts(roomId, row.student_id, row.item_id, payload), Buffer.from(row.hmac, 'base64'))
    ) {
      throw new FormResponseTamperedError()
    }
    const raw = decryptAes256Gcm(payload, key).toString('utf8')
    const parsed = JSON.parse(raw) as { value: unknown; artifacts: unknown; journey: unknown }
    const value = StoredAnswerValueSchema.parse(parsed.value) as StoredAnswerValue
    const artifacts = ((parsed.artifacts ?? []) as unknown[]).map(
      (a) => StoredArtifactDescriptorSchema.parse(a) as StoredArtifactDescriptor
    )
    return {
      roomId,
      studentId: row.student_id,
      itemId: row.item_id,
      status: row.status as FormItemGradeStatus,
      earnedPoints: row.earned_points,
      manualPoints: row.manual_points,
      violationsJson: row.violations_json,
      value,
      artifacts,
      journey: (parsed.journey ?? null) as FormJourneyRecord | null,
      submittedAtMs: row.submitted_at_ms,
      revision: row.revision,
      updatedAtMs: row.updated_at_ms
    }
  }

  private hmacParts(roomId: string, studentId: string, itemId: string, payload: EncryptedPayload): string {
    return [roomId, studentId, itemId, payload.ciphertext, payload.iv, payload.tag].join('\u0000')
  }
}

export interface StoredArtifactMetaRow {
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
}

/* ---------- regrade history (7.2.3) ---------- */

export interface RegradeHistoryRecord {
  roomId: string
  runAtMs: number
  triggerSource: string
  formSha256: string
  summaryJson: string
}

export function appendRegradeHistory(db: HostDatabase, record: RegradeHistoryRecord): void {
  db.db
    .prepare(
      `INSERT INTO form_regrade_history (session_id, run_at_ms, trigger_source, form_sha256, summary_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(record.roomId, record.runAtMs, record.triggerSource, record.formSha256, record.summaryJson)
}

export function listRegradeHistory(db: HostDatabase, roomId: string): Array<{ run_at_ms: number; summary_json: string }> {
  return db.db
    .prepare(`SELECT run_at_ms, summary_json FROM form_regrade_history WHERE session_id = ? ORDER BY run_at_ms DESC LIMIT 50`)
    .all(roomId) as Array<{ run_at_ms: number; summary_json: string }>
}

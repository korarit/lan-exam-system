import type { Answer } from '@shared/exam-schema'
import {
  encryptAes256Gcm,
  decryptAes256Gcm,
  computeHmac,
  verifyHmacTimingSafe,
  type EncryptedPayload
} from '../crypto/primitives'
import type { HostDatabase } from '../storage/db'

/* ============================================================
 * ResultStore — Encrypted Result Store (Host-authoritative)
 * ทุกคำตอบ/ฉบับร่างถูกเข้ารหัส AES-256-GCM ด้วย roomStorageKey
 * และแนบ rowHmac กันการเปิดไฟล์ SQLite มาแก้ทีหลังโดยไม่มีคีย์
 * ============================================================ */

export interface SaveSubmissionInput {
  sessionId: string
  studentId: string
  questionId: string
  seqNo: number
  answer: Answer
  serverReceivedAtMs: number
}

export interface SaveDraftInput {
  sessionId: string
  studentId: string
  questionId: string
  draft: Answer
  updatedAtMs: number
}

export interface StoredSubmission {
  questionId: string
  seqNo: number
  answer: Answer
  serverReceivedAtMs: number
}

export class SubmissionTamperedError extends Error {
  constructor() {
    super('SUBMISSION_TAMPERED')
  }
}

function hmacBytes(storageKey: Buffer, parts: string[]): Buffer {
  return computeHmac(storageKey, parts.join('\u0000'))
}

export class ResultStore {
  constructor(
    private readonly db: HostDatabase,
    private readonly storageKey: Buffer
  ) {
    if (storageKey.length !== 32) throw new Error('STORAGE_KEY_MUST_BE_32_BYTES')
  }

  /* ---------- คำตอบที่ส่งแล้ว (submissions) ---------- */

  saveSubmission(input: SaveSubmissionInput): void {
    const encrypted = this.encryptValue({
      answer: input.answer,
      questionId: input.questionId,
      serverReceivedAtMs: input.serverReceivedAtMs
    })
    const hmac = hmacBytes(this.storageKey, [
      input.studentId,
      input.questionId,
      encrypted.ciphertext,
      String(input.serverReceivedAtMs)
    ]).toString('base64')
    this.db.db
      .prepare(
        `INSERT OR REPLACE INTO submissions
         (session_id, student_id, question_id, seq_no, ciphertext, iv, tag, hmac, received_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sessionId,
        input.studentId,
        input.questionId,
        input.seqNo,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        hmac,
        input.serverReceivedAtMs
      )
  }

  /** ดึงคำตอบทุกรายการของนักเรียนหนึ่งคน (เรียงตามเวลาที่เครื่องแม่ได้รับ) */
  listSubmissions(sessionId: string, studentId: string): StoredSubmission[] {
    const rows = this.db.db
      .prepare(
        `SELECT question_id, seq_no, ciphertext, iv, tag, hmac, received_at_ms
         FROM submissions
         WHERE session_id = ? AND student_id = ?
         ORDER BY question_id, seq_no`
      )
      .all(sessionId, studentId) as Array<{
      question_id: string
      seq_no: number
      ciphertext: string
      iv: string
      tag: string
      hmac: string
      received_at_ms: number
    }>
    return rows.map((row) => {
      if (
        !verifyHmacTimingSafe(
          this.storageKey,
          [studentId, row.question_id, row.ciphertext, String(row.received_at_ms)].join('\u0000'),
          Buffer.from(row.hmac, 'base64')
        )
      ) {
        throw new SubmissionTamperedError()
      }
      const value = this.decryptValue<StoredSubmission>(
        { iv: row.iv, tag: row.tag, ciphertext: row.ciphertext }
      )
      return { questionId: value.questionId, seqNo: row.seq_no, answer: value.answer, serverReceivedAtMs: value.serverReceivedAtMs }
    })
  }

  /* ---------- ฉบับร่าง (draft_submissions) ---------- */

  saveDraft(input: SaveDraftInput): void {
    const encrypted = this.encryptValue({
      answer: input.draft,
      questionId: input.questionId,
      serverReceivedAtMs: input.updatedAtMs
    })
    const hmac = hmacBytes(this.storageKey, [
      input.studentId,
      input.questionId,
      encrypted.ciphertext,
      String(input.updatedAtMs)
    ]).toString('base64')
    this.db.db
      .prepare(
        `INSERT OR REPLACE INTO draft_submissions
         (session_id, student_id, question_id, ciphertext, iv, tag, hmac, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sessionId,
        input.studentId,
        input.questionId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        hmac,
        input.updatedAtMs
      )
  }

  loadDraft(sessionId: string, studentId: string, questionId: string): Answer | null {
    const row = this.db.db
      .prepare(
        `SELECT ciphertext, iv, tag, hmac, updated_at_ms
         FROM draft_submissions
         WHERE session_id = ? AND student_id = ? AND question_id = ?`
      )
      .get(sessionId, studentId, questionId) as
      | { ciphertext: string; iv: string; tag: string; hmac: string; updated_at_ms: number }
      | undefined
    if (!row) return null
    if (
      !verifyHmacTimingSafe(
        this.storageKey,
        [studentId, questionId, row.ciphertext, String(row.updated_at_ms)].join('\u0000'),
        Buffer.from(row.hmac, 'base64')
      )
    ) {
      throw new SubmissionTamperedError()
    }
    const value = this.decryptValue<{ answer: Answer }>({
      iv: row.iv,
      tag: row.tag,
      ciphertext: row.ciphertext
    })
    return value.answer
  }

  /* ---------- encryption helpers ---------- */

  private encryptValue(value: unknown): EncryptedPayload {
    return encryptAes256Gcm(JSON.stringify(value), this.storageKey)
  }

  private decryptValue<T>(payload: EncryptedPayload): T {
    const raw = decryptAes256Gcm(payload, this.storageKey).toString('utf8')
    return JSON.parse(raw) as T
  }
}

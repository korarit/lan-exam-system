import type { ResolvedParameters, ZtformContainer, DynamicFormDefinition } from '../shared/form-schema'
import { isFormItemQuestion } from '../shared/form-schema'
import type { StoredArtifactDescriptor } from '../shared/form-answer-schema'
import { FormArtifactUploadSchema, FormItemSubmissionSchema } from '../shared/form-answer-schema'
import { validateServerAnswer, type AnswerViolation } from './form-validator'
import { FileVault, type SavedArtifactRecord } from './file-vault'
import { FormResponseStore, appendRegradeHistory } from './form-response-store'
import { gradeFormItem, type ItemGradeOutcome } from './form-grader'
import { stripAnswerKeyForStudent } from '../shared/student-view'
import { sha256Hex } from '@main/crypto/primitives'
import type { HostDatabase } from '@main/storage/db'

/* ============================================================
 * Phase 7 — Embedded Form Backend Orchestrator (เครื่องแม่)
 * ท่อการผลิตเดียว: รับคำตอบ (TLS) → Server-side validate (7.1.1)
 * → ไฟล์แนบเข้า Encrypted File Vault (7.1.2) → Instant Auto-Grading
 * (7.2.2) → SQLite เข้ารหัส + rowHmac → Dashboard / Export / Re-grade
 * คีย์ทุกชั้น = PBKDF2(crypto_salt ของห้อง) แบบเดียวกับ ResultStore
 * ============================================================ */

export interface FormRoomContext {
  roomId: string
  roomName: string
  container: ZtformContainer
  /** ค่าตัวแปรสุ่มรายคน (เช่น { a: 12, b: 5 }) ต่อข้อ — เครื่องแม่คำนวณเองเสมอ */
  resolvedParametersByStudent: Map<string, ResolvedParameters>
  startedAtMs: number | null
  endedAtMs: number | null
}

export interface IngestArtifactChunkInput {
  roomId: string
  studentId: string
  descriptor: unknown
  chunkIndex: number
  chunkTotal: number
  contentBase64: string
}

export interface IngestArtifactResult {
  stored: boolean
  artifact?: StoredArtifactDescriptor
  reason?: string
}

export interface IngestItemSubmissionInput {
  roomId: string
  studentId: string
  studentSeed: string
  submission: unknown
  serverTimestampMs: number
}

export interface IngestSubmissionResult {
  accepted: boolean
  itemId: string
  outcome?: ItemGradeOutcome
  reason?: string
}

export interface RegradeSummary {
  students: number
  changedItems: number
  totalDeltaPoints: number
}

const MAX_CHUNK_BASE64 = 2 * 1024 * 1024
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024

export class FormHostService {
  private readonly store: FormResponseStore
  private readonly vault: FileVault
  private readonly rooms = new Map<string, FormRoomContext>()
  private readonly artifactBuffers = new Map<string, string[]>()

  constructor(
    private readonly db: HostDatabase,
    getStorageKey: (roomId: string) => Buffer,
    vaultRootPath: string
  ) {
    this.store = new FormResponseStore(db, getStorageKey)
    this.vault = new FileVault(vaultRootPath, getStorageKey)
  }

  /* ---------- ฅ.โหลดฟอร์มของห้อง ---------- */

  setRoomForm(roomId: string, roomName: string, container: ZtformContainer, startedAtMs: number | null = null): void {
    this.rooms.set(roomId, {
      roomId,
      roomName,
      container,
      resolvedParametersByStudent: new Map(),
      startedAtMs,
      endedAtMs: null
    })
  }

  getRoomForm(roomId: string): FormRoomContext | null {
    return this.rooms.get(roomId) ?? null
  }

  registerStudentSeed(roomId: string, studentId: string, studentSeed: string): void {
    const room = this.rooms.get(roomId)
    if (!room) return
    const resolved = stripAnswerKeyForStudent(room.container.form, studentSeed).resolvedParameters
    room.resolvedParametersByStudent.set(studentId, resolved)
  }

  /* ---------- 7.1.2 ไฟล์แนบ: chunk ประกอบ → vault เข้ารหัส ---------- */

  ingestArtifactChunk(input: IngestArtifactChunkInput): IngestArtifactResult {
    const room = this.rooms.get(input.roomId)
    if (!room) return { stored: false, reason: 'ROOM_FORM_NOT_LOADED' }
    const check = FormArtifactUploadSchema.safeParse(input.descriptor)
    if (!check.success) return { stored: false, reason: 'ARTIFACT_DESCRIPTOR_INVALID' }
    const descriptor = check.data
    const itemId = descriptor.itemId
    if (input.chunkIndex < 0 || input.chunkTotal < 1 || input.chunkIndex >= input.chunkTotal) {
      return { stored: false, reason: 'CHUNK_INDEX_INVALID' }
    }
    if (input.contentBase64.length > MAX_CHUNK_BASE64) {
      return { stored: false, reason: 'CHUNK_TOO_LARGE' }
    }

    const bufferKey = `${input.roomId}\u0000${input.studentId}\u0000${itemId}\u0000${descriptor.artifactId}`
    let parts = this.artifactBuffers.get(bufferKey)
    if (parts === undefined) {
      parts = new Array<string>(input.chunkTotal).fill('') as string[]
      this.artifactBuffers.set(bufferKey, parts)
    }
    parts[input.chunkIndex] = input.contentBase64
    if (input.chunkIndex !== input.chunkTotal - 1) {
      return { stored: false, reason: 'CHUNKING' }
    }
    this.artifactBuffers.delete(bufferKey)
    if (parts.some((p) => p === undefined)) return { stored: false, reason: 'CHUNK_MISSING' }

    let content: Buffer
    try {
      content = Buffer.from(parts.join(''), 'base64')
    } catch {
      return { stored: false, reason: 'CHUNK_DECODE_FAILED' }
    }

    let saved: SavedArtifactRecord
    try {
      saved = this.vault.saveArtifact({
        roomId: input.roomId,
        studentId: input.studentId,
        itemId,
        artifactId: descriptor.artifactId,
        fileName: descriptor.fileName,
        mimeType: descriptor.mimeType,
        content,
        expectedSha256: descriptor.sha256,
        maxFileSizeBytes: this.maxFileSizeFor(room.container.form, itemId)
      })
    } catch (err) {
      return { stored: false, reason: err instanceof Error ? err.message.slice(0, 120) : 'VAULT_SAVE_FAILED' }
    }
    try {
      this.db.db
        .prepare(
          `INSERT OR REPLACE INTO uploaded_artifacts
             (session_id, student_id, item_id, artifact_id, file_name, mime_type, size_bytes, sha256,
              file_path, iv, tag, row_hmac, received_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.roomId,
          input.studentId,
          itemId,
          saved.artifactId,
          saved.fileName,
          saved.mimeType.length > 0 ? saved.mimeType : 'application/octet-stream',
          saved.sizeBytes,
          saved.sha256,
          saved.filePath,
          saved.payload.iv,
          saved.payload.tag,
          saved.rowHmac,
          saved.serverReceivedAtMs
        )
    } catch {
      void saved
    }
    const registered: StoredArtifactDescriptor = {
      artifactId: descriptor.artifactId,
      fileName: descriptor.fileName,
      mimeType: saved.mimeType.length > 0 ? saved.mimeType : descriptor.mimeType,
      sizeBytes: saved.sizeBytes,
      sha256: saved.sha256
    }
    return { stored: true, artifact: registered }
  }

  private maxFileSizeFor(form: DynamicFormDefinition, itemId: string): number {
    const item = form.items.find((i) => i.itemId === itemId)
    if (item && isFormItemQuestion(item) && item.validation.maxFileSizeBytes !== undefined) {
      return item.validation.maxFileSizeBytes
    }
    return DEFAULT_MAX_FILE_BYTES
  }

  /* ---------- 7.1.1 + 7.2.2 รับคำตอบรายข้อ: validate → grade → save ---------- */

  ingestItemSubmission(input: IngestItemSubmissionInput): IngestSubmissionResult {
    const room = this.rooms.get(input.roomId)
    if (!room) return { accepted: false, itemId: '', reason: 'ROOM_FORM_NOT_LOADED' }
    const check = FormItemSubmissionSchema.safeParse(input.submission)
    if (!check.success) {
      return { accepted: false, itemId: '', reason: `SUBMISSION_SCHEMA_INVALID` }
    }
    const submission = check.data
    const form = room.container.form
    const item = form.items.find((i) => i.itemId === submission.itemId)
    if (item === undefined || !isFormItemQuestion(item)) {
      return { accepted: false, itemId: submission.itemId, reason: 'UNKNOWN_ITEM' }
    }

    const artifactsByStudentItem = this.store
      .listArtifactMetaForStudent(input.roomId, input.studentId)
      .filter((m) => m.item_id === submission.itemId)
    const artifactMap = new Map<string, StoredArtifactDescriptor>(
      artifactsByStudentItem.map((m) => [
        m.artifact_id,
        {
          artifactId: m.artifact_id,
          fileName: m.file_name,
          mimeType: m.mime_type,
          sizeBytes: m.size_bytes,
          sha256: m.sha256
        } as StoredArtifactDescriptor
      ])
    )
    const violations = validateServerAnswer({
      item,
      value: submission.value,
      artifacts: Object.fromEntries(artifactMap)
    })
    const outcome = gradeFormItem({
      item,
      value: submission.value,
      artifacts: [...artifactMap.values()],
      violations,
      ...(room.resolvedParametersByStudent.get(input.studentId)?.[submission.itemId] !== undefined
        ? { resolvedParameters: room.resolvedParametersByStudent.get(input.studentId)![submission.itemId]! }
        : {})
    })
    const nowMs = input.serverTimestampMs > 0 ? input.serverTimestampMs : Date.now()
    this.store.upsert({
      roomId: input.roomId,
      studentId: input.studentId,
      itemId: submission.itemId,
      status: outcome.status,
      earnedPoints: outcome.earnedPoints,
      violationsJson: JSON.stringify(outcome.violations),
      value: submission.value,
      artifacts: [...artifactMap.values()],
      journey: {
        itemId: submission.itemId,
        timeSpentMs: submission.timeSpentMs,
        submittedAtMs: submission.clientSubmittedAtMs
      },
      submittedAtMs: nowMs,
      updatedAtMs: nowMs
    })
    return {
      accepted: violations.length === 0,
      itemId: submission.itemId,
      outcome,
      ...(violations.length > 0 ? { reason: 'VALIDATION_FAILED' as const } : {})
    }
  }

  /** ครูให้คะแนนข้ออัตนัยเพิ่ม (ชนะคะแนนอัตโนมัติของข้อนั้น) */
  manualGradeItem(input: { roomId: string; studentId: string; itemId: string; points: number | null }): { ok: boolean; reason?: string } {
    const room = this.rooms.get(input.roomId)
    if (!room) return { ok: false, reason: 'ROOM_FORM_NOT_LOADED' }
    const item = room.container.form.items.find((i) => i.itemId === input.itemId)
    if (item === undefined || !isFormItemQuestion(item)) return { ok: false, reason: 'UNKNOWN_ITEM' }
    if (input.points !== null && (input.points < 0 || input.points > item.points)) {
      return { ok: false, reason: 'POINTS_OUT_OF_RANGE' }
    }
    this.store.upsertManualGradeStatus({
      roomId: input.roomId,
      studentId: input.studentId,
      itemId: input.itemId,
      manualPoints: input.points ?? 0,
      updatedAtMs: Date.now()
    })
    return { ok: true }
  }

  /* ---------- 7.2.3 Re-grade All (แก้เฉลยแล้วตรวจใหม่ทั้งห้อง) ---------- */

  regradeAllSubmissions(roomId: string, updatedForm: DynamicFormDefinition, triggerSource = 'teacher-ui'): RegradeSummary {
    const summary = runRegradeAllForRoom(roomId, updatedForm, this.store, {
      resolvedParametersFor: (studentId) => {
        const room = this.rooms.get(roomId)
        return room?.resolvedParametersByStudent.get(studentId)
      }
    })
    try {
      appendRegradeHistory(this.db, {
        roomId,
        runAtMs: Date.now(),
        triggerSource,
        formSha256: sha256Hex(JSON.stringify(updatedForm)),
        summaryJson: JSON.stringify(summary)
      })
    } catch {
      void triggerSource
    }
    return summary
  }

  getStore(): FormResponseStore {
    return this.store
  }

  getVault(): FileVault {
    return this.vault
  }
}

/* ---------- Re-grade core (แยกให้ทดสอบได้โดยไม่ต้องต่อระบบเครือข่าย) ---------- */

export function runRegradeAllForRoom(
  roomId: string,
  updatedForm: DynamicFormDefinition,
  store: FormResponseStore,
  hooks: {
    resolvedParametersFor?: (studentId: string) => ResolvedParameters | undefined
  } = {}
): RegradeSummary {
  const rows = store.listResponses(roomId)
  const itemsById = new Map(updatedForm.items.map((item) => [item.itemId, item] as const))
  const byStudent = new Map<string, typeof rows>()
  for (const row of rows) {
    const bucket = byStudent.get(row.studentId) ?? []
    bucket.push(row)
    byStudent.set(row.studentId, bucket)
  }
  let students = 0
  let changedItems = 0
  let totalDelta = 0
  for (const [studentId, studentRows] of byStudent) {
    students += 1
    const params = hooks.resolvedParametersFor?.(studentId)
    for (const row of studentRows) {
      const item = itemsById.get(row.itemId)
      if (item === undefined || !isFormItemQuestion(item)) continue
      const artifactEntries = Object.fromEntries(
        row.artifacts.map((a) => [a.artifactId, a])
      ) as Record<string, StoredArtifactDescriptor>
      const violations: AnswerViolation[] = validateServerAnswer({ item, value: row.value, artifacts: artifactEntries })
      const normalizedResolved = params?.[item.itemId]
      const outcome = gradeFormItem({
        item,
        value: row.value,
        artifacts: row.artifacts,
        violations,
        ...(normalizedResolved !== undefined ? { resolvedParameters: normalizedResolved } : {})
      })
      // ข้อที่ครูให้คะแนนเองแล้ว (manual-graded) ต้องไม่ถูกทับด้วยการตรวจอัตโนมัติ
      if (row.status === 'manual-graded') continue
      if (outcome.status !== row.status || Math.abs(outcome.earnedPoints - row.earnedPoints) > 0.001) {
        totalDelta += outcome.earnedPoints - row.earnedPoints
        changedItems += 1
      }
      store.upsert({
        roomId,
        studentId,
        itemId: row.itemId,
        status: outcome.status,
        earnedPoints: outcome.earnedPoints,
        violationsJson: JSON.stringify(outcome.violations),
        value: row.value,
        artifacts: row.artifacts,
        journey: row.journey,
        submittedAtMs: row.submittedAtMs,
        updatedAtMs: Date.now()
      })
    }
  }
  return { students, changedItems, totalDeltaPoints: Math.round(totalDelta * 100) / 100 }
}

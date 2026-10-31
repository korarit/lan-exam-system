import { randomUUID } from 'node:crypto'
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
import type { StudentFormView } from '../shared/form-schema'

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
  /**
   * VULN-59: seed ต่อ (room, student) ต้องสุ่มและเก็บฝั่ง host เท่านั้น
   * เดิมใช้ studentId เป็น seed → ทำนาย shuffle/parameter ได้
   */
  private readonly studentSeeds = new Map<string, string>()
  /**
   * VULN-61: เปิดข้อทีละข้อ (default) — ไม่ดันข้อสอบทั้งชุดไปเครื่องนักเรียน
   * key = roomId\0studentId, value = จำนวนข้อที่เปิดแล้ว
   */
  private readonly revealedQuestions = new Map<string, number>()
  /** ลำดับข้อจริงหลัง shuffle ต่อคน (ใช้กันการยิงซ้ำเพื่อเปิดข้อเพิ่ม) */
  private readonly questionOrderByStudent = new Map<string, string[]>()

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

  private revealKey(roomId: string, studentId: string): string {
    return `${roomId}\u0000${studentId}`
  }

  /** จำนวนข้อที่เปิดให้นักเรียนเห็นแล้ว (default 1 = ทีละข้อ) */
  getRevealedQuestions(roomId: string, studentId: string): number {
    return this.revealedQuestions.get(this.revealKey(roomId, studentId)) ?? 1
  }

  /** เปิดข้อถัดไปหลังส่งข้อปัจจุบัน (VULN-61) */
  revealMore(roomId: string, studentId: string, count = 1): number {
    const room = this.rooms.get(roomId)
    if (!room) return 0
    const total = room.container.form.items.filter(isFormItemQuestion).length
    const current = this.getRevealedQuestions(roomId, studentId)
    const next = Math.max(0, Math.min(total, current + Math.max(0, count)))
    this.revealedQuestions.set(this.revealKey(roomId, studentId), next)
    return next
  }

  private totalQuestions(room: FormRoomContext): number {
    return room.container.form.items.filter(isFormItemQuestion).length
  }

  /** VULN-61: ข้อนี้ถูกเปิดให้นักเรียนเห็นแล้วหรือยัง (ถ้ายังไม่มี order = ไม่บังคับ) */
  private isItemRevealed(roomId: string, studentId: string, itemId: string): boolean {
    const order = this.questionOrderByStudent.get(this.revealKey(roomId, studentId))
    if (!order) return true
    const revealed = this.getRevealedQuestions(roomId, studentId)
    return order.slice(0, revealed).includes(itemId)
  }

  /**
   * เปิดข้อถัดไปเมื่อส่ง "ข้อสุดท้ายที่เปิดอยู่" เท่านั้น
   * (ส่งซ้ำข้อเก่าไม่ทำให้เห็นข้อใหม่เพิ่ม)
   */
  private advanceRevealOnSubmission(roomId: string, studentId: string, submittedItemIds: readonly string[]): void {
    const key = this.revealKey(roomId, studentId)
    const order = this.questionOrderByStudent.get(key)
    if (!order || order.length === 0) return
    const revealed = this.getRevealedQuestions(roomId, studentId)
    const frontier = order[revealed - 1]
    if (frontier !== undefined && submittedItemIds.includes(frontier)) {
      this.revealMore(roomId, studentId, 1)
    }
  }

  /** seed แบบสุ่มต่อห้อง/คน — คงที่ตลอด session เพื่อให้ reconnect ได้ลำดับเดิม */
  seedFor(roomId: string, studentId: string): string {
    const key = `${roomId}\u0000${studentId}`
    const existing = this.studentSeeds.get(key)
    if (existing !== undefined) return existing
    const seed = randomUUID()
    this.studentSeeds.set(key, seed)
    return seed
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
    // VULN-61: ห้ามตอบข้อที่ยังไม่ถูกเปิด (client ดัดแปลงเดา itemId ไม่ได้)
    if (!this.isItemRevealed(input.roomId, input.studentId, submission.itemId)) {
      return { accepted: false, itemId: submission.itemId, reason: 'ITEM_NOT_REVEALED' }
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

  /**
   * ทางเข้าจากท่อ LAN (ModuleTransportHost): ตรวจสถานะห้องสอบก่อนรับทุกครั้ง
   * (Host-authoritative — รับเฉพาะตอนห้อง status === 'running')
   * action = { type:'dynamic-form.submit-item', submission } | { items:[...] }
   * autosave = { items:[...] } หรือ submission เดี่ยว (เก็บแบบเดียวกับ submit —
   * คำตอบฟอร์มตรวจอัตโนมัติทุกครั้งที่ ingest อยู่แล้ว)
   */
  ingestViaTransport(input: {
    roomId: string
    studentId: string
    kind: 'action' | 'autosave'
    payloadJson: string
    serverTimestampMs: number
  }): { ok: boolean; progressText?: string; reason?: string; stateJson?: string } {
    const room = this.rooms.get(input.roomId)
    if (!room) return { ok: false, reason: 'ROOM_FORM_NOT_LOADED' }
    try {
      const row = this.db.db
        .prepare('SELECT status AS status FROM exam_sessions WHERE id = ?')
        .get(input.roomId) as { status: string } | undefined
      if (!row || row.status !== 'running') {
        return { ok: false, reason: 'EXAM_NOT_RUNNING' }
      }
    } catch {
      return { ok: false, reason: 'EXAM_STATE_UNKNOWN' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(input.payloadJson) as unknown
    } catch {
      return { ok: false, reason: 'PAYLOAD_NOT_JSON' }
    }
    const submissions = extractFormSubmissions(parsed)
    if (!submissions) return { ok: false, reason: 'SUBMISSION_INVALID' }
    // seed ต่อคน (shuffle/params ต้องตรงกับ view ที่ดันไปตอนเริ่มสอบ)
    const seed = this.seedFor(input.roomId, input.studentId)
    this.registerStudentSeed(input.roomId, input.studentId, seed)
    // VULN-61: สร้าง order/เปิดชุดแรกก่อนรับคำตอบ เพื่อบังคับ item ที่ยังไม่เปิด
    this.studentViewFor(input.roomId, input.studentId)
    let accepted = 0
    const acceptedItemIds: string[] = []
    for (const submission of submissions) {
      const res = this.ingestItemSubmission({
        roomId: input.roomId,
        studentId: input.studentId,
        studentSeed: seed,
        submission,
        serverTimestampMs: input.serverTimestampMs
      })
      if (res.accepted) {
        accepted += 1
        const itemId = (submission as { itemId?: unknown }).itemId
        if (typeof itemId === 'string') acceptedItemIds.push(itemId)
      }
    }
    if (accepted === 0) return { ok: false, reason: 'ALL_ITEMS_REJECTED' }
    let stateJson: string | undefined
    if (input.kind === 'action') {
      // VULN-61: เปิดข้อถัดไปเฉพาะเมื่อส่งข้อที่เปิดอยู่ล่าสุดสำเร็จ
      if (!this.questionOrderByStudent.has(this.revealKey(input.roomId, input.studentId))) {
        this.studentViewFor(input.roomId, input.studentId)
      }
      this.advanceRevealOnSubmission(input.roomId, input.studentId, acceptedItemIds)
      const view = this.studentViewFor(input.roomId, input.studentId)
      if (view) stateJson = JSON.stringify(view)
    }
    return {
      ok: true,
      progressText: input.kind === 'autosave' ? 'form-autosave-ingested' : 'form-item-ingested',
      ...(stateJson !== undefined ? { stateJson } : {})
    }
  }

  /**
   * มุมมองฟอร์มที่ตัดเฉลยแล้วรายคน (stripped view) — ดันผ่าน MODULE_STATE_PUSH
   * ตอนเริ่มสอบ นักเรียนแต่ละคนได้ลำดับข้อ/ตัวเลือกของตัวเอง
   */
  studentViewFor(roomId: string, studentId: string): StudentFormView | null {
    const room = this.rooms.get(roomId)
    if (!room) return null
    const seed = this.seedFor(roomId, studentId)
    const { view, resolvedParameters } = stripAnswerKeyForStudent(room.container.form, seed)
    room.resolvedParametersByStudent.set(studentId, resolvedParameters)

    // VULN-61: ส่งเฉพาะข้อที่เปิดแล้ว — ไม่ให้ข้อสอบทั้งชุดอยู่ในเครื่องนักเรียนตั้งแต่ต้น
    const total = this.totalQuestions(room)
    const revealed = total === 0 ? 0 : Math.max(1, Math.min(total, this.getRevealedQuestions(roomId, studentId)))
    let seen = 0
    const visibleItems: typeof view.items = []
    const order: string[] = []
    for (const item of view.items) {
      // StudentFormViewItem ไม่มี answerKey — เช็คชนิดด้วย inputType
      const isQuestion = item.inputType !== 'section_header' && item.inputType !== 'media_stimulus'
      if (isQuestion) {
        order.push(item.itemId)
        if (seen >= revealed) break
        seen += 1
      }
      visibleItems.push(item)
    }
    this.questionOrderByStudent.set(this.revealKey(roomId, studentId), order)
    return { ...view, items: visibleItems, totalQuestions: total, revealedQuestions: seen }
  }

  /** จบสอบ: ปั๊ม endedAtMs ของห้อง (คำตอบรายข้อบันทึกครบแล้วตอน ingest) */
  finalizeStudentSession(roomId: string): void {
    const room = this.rooms.get(roomId)
    if (!room) return
    if (room.endedAtMs !== null) return
    room.endedAtMs = Date.now()
  }
}

/* ---------- Re-grade core (แยกให้ทดสอบได้โดยไม่ต้องต่อระบบเครือข่าย) ---------- */

/** แกะ action/autosave payload จากท่อ LAN เป็นรายการ submission รายข้อ */
export function extractFormSubmissions(payload: unknown): unknown[] | null {
  if (typeof payload !== 'object' || payload === null) return null
  const obj = payload as Record<string, unknown>
  // { type:'dynamic-form.submit-item', submission } — ท่าหลักจาก StudentExamWorkspace
  if (typeof obj.type === 'string' && obj.submission !== undefined) {
    return [obj.submission]
  }
  // { items:[...] } — ส่งหลายข้อรวดเดียว (final flush ตอนหมดเวลา)
  if (Array.isArray(obj.items)) {
    return obj.items.length > 0 ? obj.items : null
  }
  // submission เดี่ยว { itemId, value, ... }
  if (typeof obj.itemId === 'string') {
    return [payload]
  }
  return null
}

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

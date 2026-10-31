import { pbkdf2Sync } from 'node:crypto'
import {
  ExamDefinitionSchema,
  type Answer,
  type ClientQuestionPayload,
  type ExamDefinition,
  type SubmitAnswerPayload,
  type AutoSaveDraftPayload,
  type FinalDraftFlushPayload,
  type NavigateToPayload
} from '@shared/exam-schema'
import { NetMsgType, type DocsUrlLogPayload } from '@shared/protocol-schema'
import { buildDefaultPolicy, type DetectionEvent, type DetectionPolicyBody, type DomainEnforcement } from '@shared/policy-schema'
import { generateRandomBytes } from '../crypto/primitives'
import { signPolicy } from '../guard/policy-signing'
import type { HostDatabase } from '../storage/db'
import type { HostRoomManager } from '../network/host-room'
import type { SecureConnection } from '../network/secure-connection'
import { QuestionDispatcher } from './dispatcher'
import { ResultStore } from './result-store'
import { RecoveryManager } from './recovery'
import { DisconnectWatch } from './disconnect-watch'
import { gradeAnswer, type GradeResult } from './auto-grader'

/* ============================================================
 * CoreSessionManager — กนาหลักของการควบคุมการสอบ (Host-Authoritative)
 * - ตั้งเวลาสอบทั้งห้องจากนาฬิกาเครื่องแม่ + EXAM_TIME_UP + auto collect
 * - เดิน QuestionDispatcher (ทีละข้อ), RecoveryManager (draft/recovery)
 * - บันทึกผลทั้งหมดผ่าน ResultStore (AES-256-GCM + rowHmac)
 * ============================================================ */

export type ExamAnomalySender = (source: string | null, reason: string) => void

export interface ExamHostEventSender {
  (channel: string, payload: unknown): void
}

export interface CoreSessionManagerOptions {
  db: HostDatabase
  /** คืนห้องที่เปิดอยู่ (ผูกกับ HostRoomManager ใน main) */
  getRoom: () => HostRoomManager | null
  /** ส่ง event เข้า renderer ฝั่งเครื่องแม่ (host summary, ฯลฯ) */
  sendHostEvent: ExamHostEventSender
  /** รายงาน anomaly เชิงการแอบอ้าง cursor / ข้อสอบ (เข้า audit ใน Phase 3b) */
  onAnomaly?: ExamAnomalySender
  gracePeriodMs?: number
  /**
   * หลุดต่อเนื่องเกินกี่ ms แล้วสั่ง freeze อัตโนมัติ (null/0 = ไม่ freeze)
   * default 30s — ครูยังปลด freeze เองได้หลังตรวจ
   */
  disconnectFreezeMs?: number | null
  /** Phase 3a-plus: โดเมนที่ครูอนุมัติแล้วของห้อง (ฝังเป็น allowedDomains ใน policy) */
  getAllowedDomains?: () => string[]
  /** Phase 3a-plus: พฤติกรรมเมื่อนักเรียนใช้โดเมนนอกเหนือรายการ (warn/block) */
  getDomainEnforcement?: () => DomainEnforcement
  /** Phase 5 (Mode 2): URL เอกสารเริ่มต้นจากการเตรียมเอกสาร (ส่งต่อด้วย EXAM_STARTED) */
  getDocsStartUrl?: () => string | null
  /** Phase 5: ประวัติโดเมนอนุญาตที่นักเรียนใช้จริง → hash chain (ลง 'normal' ไม่มีผล triage) */
  onDocsUrlLog?: (studentId: string, payload: DocsUrlLogPayload) => void
  /** Phase 3b: ท่อข้อมูลตรวจจับ → Audit hash chain + Triage engine บนเครื่องแม่ */
  onDetectionBatch?: (studentId: string, events: DetectionEvent[]) => void
  /** Phase 3b: เริ่มการสอบ → เขียน Genesis block + ผูก audit key ของห้อง */
  onExamStarted?: (roomId: string, policy: DetectionPolicyBody) => void
  /** Phase 3b: จบการสอบ → ปิด chain ด้วย EXAM_ENDED */
  onExamEnded?: (roomId: string, reason: string) => void
  /** Phase 3c: ข้อความจากนักเรียนที่บริการอื่นจัดการ (เช่น RING_SEGMENT_LIST) — คืน true เมื่อจัดการแล้ว */
  onStudentNetMessage?: (studentId: string, type: string, payload: unknown) => boolean
  /** Phase 3c (UDP): พอร์ต UDP รับสตรีมหน้าจอของเครื่องแม่ (null = ปิด UDP ใช้ TCP fallback) */
  getScreenUdpPort?: () => number | null
  /** Phase 3c (UDP): แจ้งว่า SCREEN_SESSION ถูกส่งไปนักเรียนคนนี้ (จับคู่กุญแจ UDP ฝั่งเครื่องแม่) */
  onScreenSessionSent?: (studentId: string, screenBufferKey: string, udpScreenPort: number | null) => void
}

export type ExamState = 'idle' | 'running' | 'collecting' | 'finished'

export interface StudentSummary {
  studentId: string
  answeredCount: number
  maxReachedCursor: number
  totalQuestions: number
  awardedPoints: number
  pendingCount: number
  finished: boolean
  finishReason?: string
}

export class CoreSessionManager {
  private exam: ExamDefinition | null = null
  private dispatcher: QuestionDispatcher | null = null
  private resultStore: ResultStore | null = null
  private recovery: RecoveryManager | null = null
  private roomSecretSeed: string | null = null
  private state: ExamState = 'idle'
  private examEndsAtMs = 0
  private timer: NodeJS.Timeout | null = null
  private collectingDone = false
  private readonly gracePeriodMs: number
  private readonly disconnectWatch: DisconnectWatch

  /** คะแนน auto-grade ต่อนักเรียน (เข้ารายงานสรุปฝั่งครู — ข้อ essay ให้ครูตรวจเอง) */
  private readonly grades = new Map<string, Map<string, GradeResult>>()
  private readonly seqPerQuestion = new Map<string, number>()
  private readonly finishReasons = new Map<string, string>()
  /** นโยบายตรวจจับของห้องนี้ (สร้างตอนเริ่มสอบ — เซ็นต่อนักเรียนด้วย session key ของแต่ละคน) */
  private detectionPolicy: DetectionPolicyBody | null = null
  /** Phase 3c: คีย์เข้ารหัส ring buffer หน้าจอต่อรอบการสอบ (อยู่ในหน่วยความจำเครื่องแม่เท่านั้น) */
  private screenBufferKey: Buffer | null = null

  constructor(private readonly opts: CoreSessionManagerOptions) {
    this.gracePeriodMs = opts.gracePeriodMs ?? 3000
    this.disconnectWatch = new DisconnectWatch({
      freezeAfterMs: opts.disconnectFreezeMs === undefined ? 30_000 : opts.disconnectFreezeMs,
      onExpired: ({ studentId, offlineForMs }) =>
        this.handleDisconnectExpired(studentId, offlineForMs)
    })
  }

  get examState(): ExamState {
    return this.state
  }

  get examInfo(): { title: string; questionCount: number; durationSeconds: number } | null {
    if (!this.exam) return null
    return {
      title: this.exam.title,
      questionCount: this.exam.questions.length,
      durationSeconds: this.exam.durationSeconds
    }
  }

  get dispatcherInstance(): QuestionDispatcher | null {
    return this.dispatcher
  }

  /* ============================================================
   * โหลด / ตรวจแพ็กเกจข้อสอบ
   * ============================================================ */

  /** ตรวจ + โหลดแพ็กเกจ (จะ throw ตรง ๆ ถ้า schema ไม่ผ่าน — ผู้เรียกแปลง error) */
  loadExam(raw: unknown): ExamDefinition {
    const parsed = ExamDefinitionSchema.parse(raw)
    if (this.state === 'running' || this.state === 'collecting') {
      throw new Error('EXAM_IN_PROGRESS')
    }
    this.exam = parsed
    this.state = 'idle'
    return parsed
  }

  clearExam(): void {
    if (this.state === 'running' || this.state === 'collecting') {
      throw new Error('EXAM_IN_PROGRESS')
    }
    this.exam = null
    this.dispatcher = null
    this.grades.clear()
  }

  /* ============================================================
   * เริ่ม/จบการสอบ
   * ============================================================ */

  async startExam(): Promise<void> {
    const exam = this.exam
    const room = this.opts.getRoom()
    if (!exam) throw new Error('EXAM_NOT_LOADED')
    if (!room?.room) throw new Error('ROOM_NOT_OPEN')
    if (this.state === 'running' || this.state === 'collecting') {
      throw new Error('EXAM_IN_PROGRESS')
    }
    const onlineCount = (room.students ?? []).filter((s) => s.online).length
    if (onlineCount === 0) throw new Error('NO_ONLINE_STUDENTS')
    const roomId = room.room.roomId
    const startedAtMs = Date.now()

    // นโยบายตรวจจับของห้อง (Phase 3a): เวอร์ชันใหม่ทุกรอบการสอบ อิงโหมดห้อง
    const policyBody = buildDefaultPolicy(room.examMode ?? 'closed')
    policyBody.issuedAtMs = startedAtMs
    // Phase 3a-plus: โดเมนที่ครู record + อนุมัติผ่าน Doc Preview → allowedDomains (default-deny)
    if (this.opts.getAllowedDomains) {
      policyBody.allowedDomains = this.opts.getAllowedDomains()
    }
    if (this.opts.getDomainEnforcement) {
      policyBody.domainEnforcement = this.opts.getDomainEnforcement()
    }
    this.detectionPolicy = policyBody

    // Room secret seed ใหม่ต่อการเริ่มสอบแต่ละรอบ (สุ่มข้อ/ตัวเลือก/พารามิเตอร์ทั้งห้องใหม่)
    this.roomSecretSeed = generateRandomBytes(32).toString('hex')
    this.opts.db.db
      .prepare(
        `UPDATE exam_sessions SET status = 'running', started_at_ms = ?, ended_at_ms = NULL, crypto_salt = ? WHERE id = ?`
      )
      .run(startedAtMs, this.roomSecretSeed, roomId)
    // ล้าง freeze ค้างจากรอบก่อน — เริ่มสอบรอบใหม่ทุกคนต้องส่งคำตอบได้
    this.opts.db.db
      .prepare(`UPDATE students SET status = 'joined' WHERE session_id = ? AND status = 'frozen'`)
      .run(roomId)

    const storageKey = pbkdf2Sync(this.roomSecretSeed, roomId, 10_000, 32, 'sha256')
    this.resultStore = new ResultStore(this.opts.db, storageKey)
    this.recovery = new RecoveryManager({ resultStore: this.resultStore, sessionId: roomId })

    this.dispatcher = new QuestionDispatcher(
      exam,
      {
        isOpen: () => this.state === 'running' && (this.examEndsAtMs === 0 || Date.now() <= this.examEndsAtMs + this.gracePeriodMs),
        now: () => Date.now()
      },
      (anomaly) =>
        this.opts.onAnomaly?.(anomaly.studentId, `${anomaly.reason} (${anomaly.detail})`)
    )

    this.grades.clear()
    this.seqPerQuestion.clear()
    this.finishReasons.clear()
    this.collectingDone = false
    this.disconnectWatch.clear()
    this.examEndsAtMs = startedAtMs + exam.durationSeconds * 1000
    this.state = 'running'

    const tlsServer = room.tlsServerInstance
    tlsServer?.setExamEndsAtMs(this.examEndsAtMs)
    tlsServer?.attachExamMessageHandler((studentId, connection, type, payload) =>
      this.handleExamMessage(studentId, connection, type, payload)
    )
    room.setExamStatus('in-progress')
    this.opts.onExamStarted?.(roomId, policyBody)

    // Phase 3c: คีย์ ring buffer ใหม่ต่อรอบสอบ (คิวภาพย่อ 2000ms เมื่อห้องเกิน 50 คน)
    this.screenBufferKey = generateRandomBytes(32)
    for (const student of room.students) {
      this.sendScreenSessionToStudent(student.studentId)
    }

    // ประกาศเริ่ม + ส่งข้อแรกให้ทุกคนที่ออนไลน์อยู่แล้ว
    for (const student of room.students) {
      try {
        this.ensureStudentRegistered(student.studentId)
      } catch {
        // ข้ามถ้าผู้เรียนถูก register ไปแล้ว
      }
      tlsServer?.sendToStudent(student.studentId, NetMsgType.examStarted, {
        examTitle: exam.title,
        questionCount: exam.questions.length,
        remainingSeconds: Math.ceil((this.examEndsAtMs - Date.now()) / 1000),
        examMode: room.examMode ?? 'closed',
        docsUrl: this.opts.getDocsStartUrl?.() ?? null
      })
      this.sendPolicyToStudent(student.studentId)
      const payload = this.dispatcher!.getPayload(student.studentId, 0)
      if (payload) {
        tlsServer?.sendToStudent(student.studentId, NetMsgType.questionPayload, payload)
      }
    }

    // เริ่มนาฬิกาถอยหลังกลางของเครื่องแม่ (Host-authoritative timer)
    this.timer = setInterval(() => this.tickClock(), 500)
    this.opts.sendHostEvent('host:exam-state-changed', this.getExamHostState())
  }

  getExamHostState(): Record<string, unknown> {
    const room = this.opts.getRoom()
    return {
      state: this.state,
      title: this.exam?.title ?? null,
      questionCount: this.dispatcher?.questionCount ?? 0,
      examEndsAtMs: this.examEndsAtMs,
      serverNowMs: Date.now(),
      room: room?.room?.roomName ?? null
    }
  }

  private tickClock(): void {
    if (this.state !== 'running') return
    if (this.examEndsAtMs > 0 && Date.now() > this.examEndsAtMs + this.gracePeriodMs) {
      this.currentTimeUp('time-up')
    }
  }

  /** สิ้นสุดตามโปรแกรม: หมดเวลา หรือครูกดจบเอง */
  async endExam(reason: 'time-up' | 'ended-by-host'): Promise<void> {
    if (this.state === 'idle' || this.state === 'finished') return
    this.currentTimeUp(reason)
  }

  private currentTimeUp(reason: 'time-up' | 'ended-by-host'): void {
    if (this.state === 'finished' || this.state === 'collecting') {
      this.finalizeCollection(reason)
      return
    }
    this.state = 'collecting'
    const room = this.opts.getRoom()
    const tlsServer = room?.tlsServerInstance
    this.opts.onExamEnded?.(room?.room?.roomId ?? '', reason)
    for (const student of room?.students ?? []) {
      tlsServer?.sendToStudent(student.studentId, NetMsgType.timeUp, {})
    }
    // grace period สั้น ๆ ให้ FINAL_DRAFT_FLUSH เดินทางมาถึง
    setTimeout(() => this.finalizeCollection(reason), this.gracePeriodMs)
  }

  private finalizeCollection(reason: 'time-up' | 'ended-by-host'): void {
    if (this.collectingDone) return
    this.collectingDone = true
    const room = this.opts.getRoom()
    const tlsServer = room?.tlsServerInstance
    for (const student of room?.students ?? []) {
      this.autoCollectCurrentDraft(student.studentId)
      this.finishReasons.set(student.studentId, reason)
      tlsServer?.sendToStudent(student.studentId, NetMsgType.examCompleted, { reason })
    }
    this.state = 'finished'
    this.disconnectWatch.clear()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (room?.room) {
      this.opts.db.db
        .prepare(`UPDATE exam_sessions SET status = 'ended', ended_at_ms = ? WHERE id = ?`)
        .run(Date.now(), room.room.roomId)
      room.setExamStatus('ended')
    }
    // Phase 3c: zeroize คีย์ ring buffer เมื่อจบการสอบ
    if (this.screenBufferKey) {
      this.screenBufferKey.fill(0)
      this.screenBufferKey = null
    }
    this.opts.sendHostEvent('host:exam-completed', { reason })
    this.pushSummaries()
  }

  /** สรุปคะแนนเบื้องต้นต่อคนสำหรับหน้าจอครู (auto-grade ปรนัย/เติมคำสั้น — essay รอครูตรวจ) */
  getHostSummaries(): Array<{
    studentId: string
    studentName: string
    answeredCount: number
    maxReachedCursor: number
    totalQuestions: number
    awardedPoints: number
    online: boolean
    finished: boolean
    finishReason?: string
  }> {
    const room = this.opts.getRoom()
    const names = new Map((room?.students ?? []).map((s) => [s.studentId, s.studentName]))
    return (room?.students ?? []).map((student) => {
      const summary = this.getSummary(student.studentId)
      const entry: {
        studentId: string
        studentName: string
        answeredCount: number
        maxReachedCursor: number
        totalQuestions: number
        awardedPoints: number
        online: boolean
        finished: boolean
        finishReason?: string
      } = {
        studentId: student.studentId,
        studentName: names.get(student.studentId) ?? student.studentId,
        answeredCount: summary.answeredCount,
        maxReachedCursor: summary.maxReachedCursor,
        totalQuestions: summary.totalQuestions,
        awardedPoints: summary.awardedPoints,
        online: student.online,
        finished: summary.finished
      }
      if (summary.finishReason !== undefined) entry.finishReason = summary.finishReason
      return entry
    })
  }

  /** push คะแนนเบื้องต้นต่อคนให้หน้าจอครู (auto-grade ปรนัย/เติมคำสั้น — essay รอครูตรวจ) */
  pushSummaries(): void {
    this.opts.sendHostEvent('host:exam-summaries', { summaries: this.getHostSummaries() })
  }

  private autoCollectCurrentDraft(studentId: string): void {
    if (!this.recovery || !this.dispatcher || !this.resultStore) return
    const extracted = this.recovery.extractCurrentDraftForSubmission(
      studentId,
      this.dispatcher
    )
    if (!extracted) return
    const room = this.opts.getRoom()
    this.applySubmission(studentId, extracted.questionId, extracted.answer, Date.now())
    void room
  }

  private applySubmission(
    studentId: string,
    questionId: string,
    answer: Answer,
    serverReceivedAtMs: number
  ): void {
    if (!this.resultStore || !this.dispatcher) return
    const room = this.opts.getRoom()
    const sessionId = room?.room?.roomId
    if (!sessionId) return
    const seqNo = (this.seqPerQuestion.get(`${studentId}:${questionId}`) ?? 0) + 1
    this.seqPerQuestion.set(`${studentId}:${questionId}`, seqNo)
    this.resultStore.saveSubmission({
      sessionId,
      studentId,
      questionId,
      seqNo,
      answer,
      serverReceivedAtMs
    })
    // auto-grade ให้คะแนนทันที (mcq/short-answer); essay ให้ครูตรวจเอง
    const question = this.dispatcher.exam.questions.find((q) => q.questionId === questionId)
    if (question) {
      const translatedChoiceId =
        answer.type === 'mcq'
          ? (this.dispatcher.translateChoiceIndex(studentId, questionId, answer.choiceIndex) ?? undefined)
          : undefined
      const params = this.dispatcher.getResolvedParams(studentId, questionId)
      const grade = gradeAnswer(question, answer, params, translatedChoiceId)
      const perStudent = this.grades.get(studentId) ?? new Map<string, GradeResult>()
      perStudent.set(questionId, grade)
      this.grades.set(studentId, perStudent)
    }
    // ยังลบฉบับร่างที่กลายเป็นคำตอบสมบูรณ์แล้วไม่ได้ (sqlite draft ทับได้อย่างเดียว) — ปล่อยยึดตรวจ
  }

  getSummaries(): StudentSummary[] {
    const room = this.opts.getRoom()
    return (room?.students ?? []).map((s) => this.getSummary(s.studentId))
  }
  getSummary(studentId: string): StudentSummary {
    const perStudent = this.grades.get(studentId) ?? new Map<string, GradeResult>()
    let awarded = 0
    let pending = 0
    for (const grade of perStudent.values()) awarded += grade.awardedPoints
    for (const grade of perStudent.values()) if (grade.status === 'pending-manual') pending += 1
    const reason = this.finishReasons.get(studentId)
    const summary: StudentSummary = {
      studentId,
      answeredCount: perStudent.size,
      maxReachedCursor: this.dispatcher?.getMaxReachedCursor(studentId) ?? 0,
      totalQuestions: this.dispatcher?.questionCount ?? 0,
      awardedPoints: awarded,
      pendingCount: pending,
      finished: this.state === 'finished'
    }
    if (reason !== undefined) summary.finishReason = reason
    return summary
  }

  /* ============================================================
   * Reconnect: ส่ง STATE_RECOVERY ทันที (' เมื่อ handshake/RESUME สำเร็จ')
   * ============================================================ */

  handleStudentEstablished(studentId: string): void {
    const room = this.opts.getRoom()
    const tlsServer = room?.tlsServerInstance
    if (!tlsServer) return
    if (this.state !== 'running' && this.state !== 'collecting') {
      // ยังไม่เริ่มสอบ / จบแล้ว — ถ้าจบแล้วให้บอกลับว่าสิ้นสุดแล้ว
      if (this.state === 'finished') {
        tlsServer.sendToStudent(
          studentId,
          NetMsgType.examCompleted,
        { reason: this.finishReasons.get(studentId) ?? 'ended-by-host' }
        )
      }
      return
    }
    try {
      this.ensureStudentRegistered(studentId)
    } catch {
      // มีอยู่แล้ว
    }
    const remaining = Math.max(
      0,
      Math.ceil(((this.examEndsAtMs || Date.now()) - Date.now()) / 1000)
    )
    const recoveryPayload = this.recovery!.buildStateRecovery(
      studentId,
      this.dispatcher!,
      this.exam!.title,
      remaining
    )
    if (!recoveryPayload) {
      // จอยใหม่กลางการสอบ: เริ่มที่ข้อ 0
      const payload = this.dispatcher!.getPayload(studentId, 0)
      tlsServer.sendToStudent(studentId, NetMsgType.questionPayload, payload)
      return
    }
    this.sendPolicyToStudent(studentId)
    // Phase 3c: นักเรียนที่ reconnect กลางการสอบต้องได้คีย์ ring buffer กลับทันที
    if (this.screenBufferKey) {
      this.sendScreenSessionToStudent(studentId)
    }
    // Phase 5: แนบโหมดห้อง — renderer กู้เลย์เอาต์ (split เอกสาร / floating hud)
    const modePayload = room.examMode ? { examMode: room.examMode } : {}
    tlsServer.sendToStudent(studentId, NetMsgType.stateRecovery, { ...recoveryPayload, ...modePayload })
  }

  /**
   * แจ้งการเปลี่ยนสถานะออนไลน์/ออฟไลน์ของนักเรียน (เรียกจาก main ทุกครั้งที่รายชื่อเปลี่ยน)
   * - ระหว่างสอบ: หลุดเกิน disconnectFreezeMs → FREEZE_EXAM อัตโนมัติ
   * - กลับมา: log ระยะเวลาที่หายไป (ไม่ปลด freeze เอง — ครูเท่านั้น)
   */
  handleStudentConnectionChange(studentId: string, online: boolean): void {
    if (this.state !== 'running' && this.state !== 'collecting') {
      if (online) this.disconnectWatch.markOnline(studentId)
      return
    }
    if (online) {
      const previous = this.disconnectWatch.markOnline(studentId)
      if (previous && previous.offlineForMs > 0) {
        this.opts.onAnomaly?.(
          studentId,
          `STUDENT_RECONNECTED_AFTER_${previous.offlineForMs}ms`
        )
      }
      return
    }
    this.disconnectWatch.markOffline(studentId)
  }

  private handleDisconnectExpired(studentId: string, offlineForMs: number): void {
    if (this.state !== 'running' && this.state !== 'collecting') return
    const room = this.opts.getRoom()
    const roomId = room?.room?.roomId
    // freeze ต้องบังคับใช้ฝั่ง host ด้วย ไม่ใช่แค่ส่งข้อความให้ client แสดง
    if (roomId) {
      this.opts.db.db
        .prepare(
          `UPDATE students SET status = 'frozen' WHERE session_id = ? AND student_id = ? AND status IN ('joined', 'taking')`
        )
        .run(roomId, studentId)
    }
    room?.tlsServerInstance?.sendToStudent(studentId, NetMsgType.freezeExam, {
      frozen: true,
      reason: `ขาดการเชื่อมต่อระหว่างสอบ ${Math.round(offlineForMs / 1000)} วินาที`
    })
    this.opts.onAnomaly?.(studentId, `AUTO_FREEZE_DISCONNECTED_${offlineForMs}ms`)
  }

  /** สถานะ freeze ฝั่ง host (แหล่งความจริงคือตาราง students ไม่ใช่ client) */
  private isStudentFrozen(studentId: string): boolean {
    const roomId = this.opts.getRoom()?.room?.roomId
    if (!roomId) return false
    try {
      const row = this.opts.db.db
        .prepare(`SELECT status FROM students WHERE session_id = ? AND student_id = ?`)
        .get(roomId, studentId) as { status?: string } | undefined
      return row?.status === 'frozen'
    } catch {
      return false
    }
  }

  /** Phase 3c: ส่ง SCREEN_SESSION (คีย์ ring buffer + พอร์ต UDP ถ้ามี) + จับคู่กุญแจฝั่งเครื่องแม่ */
  private sendScreenSessionToStudent(studentId: string): void {
    const room = this.opts.getRoom()
    const tlsServer = room?.tlsServerInstance
    if (!tlsServer || !this.screenBufferKey) return
    const udpScreenPort = this.opts.getScreenUdpPort?.() ?? null
    const thumbnailIntervalMs = (room.students.length ?? 0) > 50 ? 2000 : 1000
    const screenBufferKey = this.screenBufferKey.toString('base64')
    tlsServer.sendToStudent(studentId, NetMsgType.screenSession, {
      screenBufferKey,
      thumbnailIntervalMs,
      ...(udpScreenPort !== null ? { udpScreenPort } : {})
    })
    this.opts.onScreenSessionSent?.(studentId, screenBufferKey, udpScreenPort)
  }

  /** ส่งนโยบายตรวจจับ (เซ็นด้วย session key รายบุคคล) — เรียกตอนเริ่มสอบ/ reconnect */
  private sendPolicyToStudent(studentId: string): void {
    const room = this.opts.getRoom()
    const tlsServer = room?.tlsServerInstance
    if (!tlsServer || !this.detectionPolicy) return
    const sessionKey = tlsServer.getStudentSessionKey(studentId)
    if (!sessionKey) return
    tlsServer.sendToStudent(studentId, NetMsgType.policyUpdate, {
      policy: signPolicy(this.detectionPolicy, sessionKey)
    })
  }

  /**
   * Phase 3a-plus: อนุมัติโดเมนเพิ่มกลางสอบ → โหลดรายการล่าสุดจาก allowlist
   * เพิ่มเวอร์ชัน → เซ็นใหม่รายคน → POLICY_UPDATE ไปทุกเครื่องออนไลน์ทันที
   * คืนจำนวนเครื่องที่ส่งถึง (0 = ไม่มีการส่ง เช่น ยังไม่เริ่มสอบ)
   */
  pushPolicyUpdate(): number {
    if (!this.detectionPolicy) return 0
    const room = this.opts.getRoom()
    const tlsServer = room?.tlsServerInstance
    if (!tlsServer) return 0
    if (this.opts.getAllowedDomains) {
      this.detectionPolicy.allowedDomains = this.opts.getAllowedDomains()
    }
    this.detectionPolicy.version += 1
    this.detectionPolicy.issuedAtMs = Date.now()
    let pushed = 0
    for (const student of room?.students ?? []) {
      if (!student.online) continue
      this.sendPolicyToStudent(student.studentId)
      pushed += 1
    }
    return pushed
  }

  /** เหตุการณ์ตรวจจับจากเครื่องนักเรียน (Phase 3a) — push ให้หน้าจอครู + ลง audit (Phase 3b) */
  private handleGuardEvents(studentId: string, events: DetectionEvent[]): void {
    this.opts.sendHostEvent('host:guard-events', { studentId, events })
    // Phase 3b: ลง hash chain + triage engine บนเครื่องแม่
    this.opts.onDetectionBatch?.(studentId, events)
    const critical = events.filter((e) => e.severity === 'critical')
    if (critical.length > 0) {
      this.opts.onAnomaly?.(
        studentId,
        `GUARD_EVENTS_${events.map((e) => e.code).join('_').slice(0, 180)}`
      )
    }
  }

  private ensureStudentRegistered(studentId: string): void {
    if (!this.dispatcher || !this.roomSecretSeed) return
    if (this.dispatcher.getCursor(studentId) !== null) return
    this.dispatcher.registerStudent(studentId, this.roomSecretSeed)
  }

  /* ============================================================
   * ข้อความ exam จากนักเรียน (ผ่าน tls-server hook)
   * HMAC ถูกตรวจโดย SecureConnection (envelope HMAC) แล้ว
   * ============================================================ */

  private handleExamMessage(
    studentId: string,
    _connection: SecureConnection,
    type: string,
    payload: unknown
  ): void {
    const room = this.opts.getRoom()
    const tlsServer = room?.tlsServerInstance
    if (!tlsServer) return
    // Phase 3c: ข้อความหน้าจอ (RING_SEGMENT_LIST) ให้บริการเฉพาะจัดการ
    if (this.opts.onStudentNetMessage?.(studentId, type, payload)) return
    switch (type) {
      case NetMsgType.submitAnswer:
        this.handleSubmitAnswer(studentId, payload as SubmitAnswerPayload)
        return
      case NetMsgType.autosaveDraft:
        this.handleAutosaveDraft(studentId, payload as AutoSaveDraftPayload)
        return
      case NetMsgType.finalDraftFlush:
        this.handleFinalDraftFlush(studentId, payload as FinalDraftFlushPayload)
        return
      case NetMsgType.navigateTo:
        this.handleNavigate(studentId, payload as NavigateToPayload)
        return
      case NetMsgType.guardEvent:
        this.handleGuardEvents(studentId, (payload as { events: DetectionEvent[] }).events)
        return
      case NetMsgType.docsUrlLog:
        // Phase 5: ประวัติโดเมนอนุญาต → hash chain ระดับ 'normal' (ไม่มีผล triage)
        this.opts.onDocsUrlLog?.(studentId, payload as DocsUrlLogPayload)
        return
      default:
        // ข้อความที่ไม่รู้จัก = anomaly ฝั่งเครื่องแม่
        this.opts.onAnomaly?.(studentId, `UNKNOWN_EXAM_MESSAGE_${type}`)
    }
  }

  private handleSubmitAnswer(studentId: string, submit: SubmitAnswerPayload): void {
    const room = this.opts.getRoom()
    const tlsServer = room?.tlsServerInstance
    if (!this.dispatcher || !tlsServer) return
    // Freeze ต้องบังคับที่ host: client ที่เพิกเฉย FREEZE_EXAM ยังส่งคำตอบไม่ได้
    if (this.isStudentFrozen(studentId)) {
      tlsServer.sendToStudent(studentId, NetMsgType.submitRejected, { reason: 'frozen' })
      this.opts.onAnomaly?.(studentId, 'SUBMIT_WHILE_FROZEN')
      return
    }
    const result = this.dispatcher.handleSubmitAnswer(studentId, submit)
    if (!result.accepted) {
      tlsServer.sendToStudent(studentId, NetMsgType.submitRejected, { reason: result.reason })
      return
    }
    const serverReceivedAtMs = Date.now()
    this.applySubmission(studentId, submit.questionId, submit.answer, serverReceivedAtMs)
    const nextCursor = this.dispatcher.getCursor(studentId)!
    const next = this.dispatcher.getPayload(studentId, nextCursor)
    if (next) {
      tlsServer.sendToStudent(studentId, NetMsgType.questionPayload, next)
    } else {
      // ทำครบทุกข้อ → ย้ายสถานะเป็นจบ (รายบุคคล)
      this.finishReasons.set(studentId, 'completed')
      tlsServer.sendToStudent(studentId, NetMsgType.examCompleted, { reason: 'completed' })
    }
    this.pushSummaries()
  }

  private handleAutosaveDraft(studentId: string, payload: AutoSaveDraftPayload): void {
    if (!this.recovery) return
    // ฉบับร่างของคนที่ถูก freeze ต้องไม่ถูก auto-collect เป็นคำตอบตอนหมดเวลา
    if (this.isStudentFrozen(studentId)) return
    this.recovery.saveDraft(studentId, payload, Date.now())
    this.opts.sendHostEvent('host:exam-draft-saved', {
      studentId,
      questionId: payload.questionId,
      serverNowMs: Date.now()
    })
  }

  /** FINAL_DRAFT_FLUSH ระหว่าง grace period: นับเป็นคำตอบสมบูรณ์ทันทีที่เครื่องแม่ได้รับ */
  private handleFinalDraftFlush(studentId: string, payload: FinalDraftFlushPayload): void {
    if (!this.dispatcher || this.state !== 'collecting') return
    if (this.isStudentFrozen(studentId)) return
    // ยอมรับเฉพาะถ้า questionId ตรงกับ cursor ปัจจุบัน (จริง/เครื่องแม่เชื่อ Dispatcher)
    if (payload.cursorIndex === this.dispatcher.getCursor(studentId)) {
      this.applySubmission(studentId, payload.questionId, payload.answer, Date.now())
      // เลื่อน cursor ย่อยเพื่อไม่ให้ autoCollect จับซ้ำ
      this.recovery?.saveDraft(
        studentId,
        { questionId: payload.questionId, cursorIndex: payload.cursorIndex, draft: payload.answer },
        0
      )
    } else {
      this.opts.onAnomaly?.(studentId, `FINAL_FLUSH_WRONG_CURSOR_${payload.cursorIndex}`)
    }
  }

  private handleNavigate(studentId: string, request: NavigateToPayload): void {
    const room = this.opts.getRoom()
    const tlsServer = room?.tlsServerInstance
    if (!this.dispatcher || !tlsServer) return
    if (this.isStudentFrozen(studentId)) return
    const result = this.dispatcher.navigateBack(studentId, request)
    if (!result.ok || result.payload === null) {
      this.opts.onAnomaly?.(studentId, `NAVIGATE_REJECTED_${request.cursorIndex}`)
      return
    }
    tlsServer.sendToStudent(studentId, NetMsgType.questionPayload, result.payload)
  }

  /** payload ของข้อปัจจุบันของนักเรียนหนึ่งคน (0=ข้อแรก / null=ทำครบแล้ว) */
  getCurrentPayload(studentId: string): ClientQuestionPayload | null {
    if (!this.dispatcher) return null
    const cursor = this.dispatcher.getCursor(studentId)
    if (cursor === null) return null
    return this.dispatcher.getPayload(studentId, cursor)
  }
}

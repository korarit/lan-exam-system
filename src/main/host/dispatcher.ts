import {
  ExamQuestionSchema,
  type ClientQuestionPayload,
  type ExamDefinition,
  type ExamQuestion
} from '@shared/exam-schema'
import { StudentShuffler, deriveStudentSeed } from './shuffler'
import type { Answer, SubmitAnswerPayload, NavigateToPayload } from '@shared/exam-schema'

/* ============================================================
 * QuestionDispatcher (Host-Authoritative, 1-by-1 Strict Stepping)
 * - เครื่องแม่เก็บ currentQuestionCursor รายคน
 * - ส่งเฉพาะข้อปัจจุบัน (ClientQuestionPayload ปลอดเฉลยเสมอ)
 * - ลำดับข้อ/ตัวเลือก/พารามิเตอร์ สุ่มต่อคนด้วย Seeded PRNG
 * ============================================================ */

export interface DispatcherClock {
  /** เวลาที่เครื่องแม่ยังเปิดสอบรับคำตอบ (with grace period) */
  isOpen: () => boolean
  now: () => number
}

export type SubmitResult =
  | { ok: true; next: ClientQuestionPayload | null; timeSpentMs: number; serverReceivedAtMs: number }
  | { ok: false; reason: 'cursor-mismatch' | 'time-expired' | 'bad-question' | 'not-started' }

export type NavigateResult =
  | { ok: true; payload: ClientQuestionPayload | null }
  | { ok: false; reason: 'cursor-mismatch' | 'bad-question' }

interface StudentDispatchState {
  seed: string
  questionOrder: string[]
  /** questionId → ลำดับ choiceId ที่สุ่มของคนนี้ */
  choiceOrders: Map<string, string[]>
  /** questionId → ค่าพารามิเตอร์ที่สุ่มของคนนี้ (ใช้ตรวจเฉลย) */
  resolvedParams: Map<string, Record<string, number>>
  cursor: number
  maxReachedCursor: number
}

export interface DispatcherAnomaly {
  studentId: string
  reason: string
  detail: string
}

export class QuestionDispatcher {
  private readonly questionsById = new Map<string, ExamQuestion>()
  readonly questions: ExamQuestion[]
  private readonly students = new Map<string, StudentDispatchState>()

  constructor(
    readonly exam: ExamDefinition,
    private readonly clock: DispatcherClock,
    private readonly onAnomaly?: (anomaly: DispatcherAnomaly) => void
  ) {
    this.questions = exam.questions
    for (const question of exam.questions) {
      const parsed = ExamQuestionSchema.parse(question)
      if (this.questionsById.has(question.questionId)) {
        throw new Error(`DUPLICATE_QUESTION_ID:${question.questionId}`)
      }
      this.questionsById.set(question.questionId, parsed)
    }
  }

  get questionCount(): number {
    return this.questions.length
  }

  getCursor(studentId: string): number | null {
    return this.students.get(studentId)?.cursor ?? null
  }

  getMaxReachedCursor(studentId: string): number | null {
    return this.students.get(studentId)?.maxReachedCursor ?? null
  }

  /**
   * ลงทะบียน seed ของนักเรียน (studentSeed = HMAC(roomSecretSeed, studentId))
   * คำนวณลำดับ deterministic — หลุดแล้วต่อใหม่ได้ลำดับเดิมเป๊ะ 100%
   */
  registerStudent(studentId: string, roomSecretSeed: string): void {
    const existing = this.students.get(studentId)
    if (existing) {
      throw new Error(`STUDENT_ALREADY_REGISTERED:${studentId}`)
    }
    const seed = deriveStudentSeed(roomSecretSeed, studentId)
    const shuffler = new StudentShuffler(seed)
    const questionOrder = shuffler.computeQuestionOrder(
      this.questions.map((q) => q.questionId)
    )
    const choiceOrders = new Map<string, string[]>()
    const resolvedParams = new Map<string, Record<string, number>>()
    for (const question of this.questions) {
      if (question.type === 'mcq') {
        choiceOrders.set(
          question.questionId,
          shuffler.computeChoiceOrder(question.questionId, question.choices.map((c) => c.choiceId))
        )
      }
      if (question.parameters && Object.keys(question.parameters).length > 0) {
        const { prompt: _prompt, values } = shuffler.renderPrompt(
          question.questionId,
          question.promptTemplate,
          question.parameters
        )
        resolvedParams.set(question.questionId, values)
      }
    }
    this.students.set(studentId, {
      seed,
      questionOrder,
      choiceOrders,
      resolvedParams,
      cursor: 0,
      maxReachedCursor: 0
    })
  }

  dropStudent(studentId: string): void {
    this.students.delete(studentId)
  }

  /* ---------- Zero-leakage payload ---------- */

  /** payload ของข้อตำแหน่ง cursorIndex ของนักเรียนคนนั้น (null = ทำครบแล้ว) */
  getPayload(studentId: string, cursorIndex: number): ClientQuestionPayload | null {
    const state = this.students.get(studentId)
    if (!state) throw new Error(`STUDENT_NOT_REGISTERED:${studentId}`)
    if (cursorIndex < 0 || cursorIndex >= state.questionOrder.length) return null
    const questionId = state.questionOrder[cursorIndex]!
    const question = this.questionsById.get(questionId)
    if (!question) throw new Error(`QUESTION_MISSING:${questionId}`)
    let prompt = question.promptTemplate
    if (question.parameters && Object.keys(question.parameters).length > 0) {
      const shuffler = new StudentShuffler(state.seed)
      prompt = shuffler.renderPrompt(questionId, question.promptTemplate, question.parameters).prompt
    }
    const payload: ClientQuestionPayload = {
      moduleId: this.exam.moduleId,
      questionId,
      cursorIndex,
      questionCount: state.questionOrder.length,
      type: question.type,
      prompt,
      points: question.points,
      allowBackNavigation: question.allowBackNavigation
    }
    if (question.type === 'mcq') {
      const order = state.choiceOrders.get(questionId)
      if (!order) throw new Error(`CHOICE_ORDER_MISSING:${questionId}`)
      const byId = new Map(question.choices.map((c) => [c.choiceId, c]))
      payload.choices = order.map((id) => ({ text: byId.get(id)!.text }))
    }
    return payload
  }

  /* ---------- การส่งคำตอบ + ขอข้อถัดไป ---------- */

  /**
   * ตรวจ cursor + เวลา → บันทึก → เลื่อน cursor → คืนข้อถัดไป
   * ผู้เรียก (Session Manager) รับผิดชอบบันทึกคำตอบลง ResultStore รวมถึง HMAC ฝั่งข้อความ
   */
  handleSubmitAnswer(
    studentId: string,
    submit: SubmitAnswerPayload
  ): { accepted: true; answer: SubmitAnswerPayload } | { accepted: false; reason: 'cursor-mismatch' | 'bad-question' | 'time-expired' | 'not-started' } {
    if (!this.clock.isOpen()) {
      return { accepted: false, reason: 'time-expired' }
    }
    const state = this.students.get(studentId)
    if (!state) {
      return { accepted: false, reason: 'not-started' }
    }
    if (submit.cursorIndex !== state.cursor) {
      // โหมดย้อนกลับ: อนุญาตให้ส่งข้อเก่าเฉพาะข้อที่ (a) allowBackNavigation และ (b) เปิดดูมาแล้ว
      const backQuestion = this.questionsById.get(state.questionOrder[submit.cursorIndex] ?? '')
      if (
        submit.cursorIndex >= 0 &&
        submit.cursorIndex < state.questionOrder.length &&
        submit.cursorIndex <= state.maxReachedCursor &&
        backQuestion?.allowBackNavigation
      ) {
        state.cursor = Math.max(state.cursor, submit.cursorIndex + 1)
        state.maxReachedCursor = Math.max(state.maxReachedCursor, state.cursor)
        const questionAfterNav = this.questionsById.get(submit.questionId)
        if (submit.questionId !== state.questionOrder[submit.cursorIndex] || !questionAfterNav) {
          return { accepted: false, reason: 'bad-question' }
        }
        return { accepted: true, answer: submit }
      }
      this.onAnomaly?.({
        studentId,
        reason: 'SUBMIT_CURSOR_MISMATCH',
        detail: `expected=${state.cursor}, got=${submit.cursorIndex}`
      })
      return { accepted: false, reason: 'cursor-mismatch' }
    }
    const questionId = state.questionOrder[state.cursor]
    if (questionId !== submit.questionId) {
      // ถือเป็นพฤติกรรมน่าสงสัย: อ้าง questionId ที่ไม่ตรงกับลำดับที่สุ่ม
      this.onAnomaly?.({
        studentId,
        reason: 'SUBMIT_UNKNOWN_QUESTION',
        detail: `expected=${questionId}, got=${submit.questionId}`
      })
      return { accepted: false, reason: 'bad-question' }
    }
    const question = this.questionsById.get(questionId)
    if (!question) {
      return { accepted: false, reason: 'bad-question' }
    }
    if (question.type === 'mcq') {
      const order = state.choiceOrders.get(questionId)
      if (submit.answer.type === 'mcq' && order) {
        if (submit.answer.choiceIndex < 0 || submit.answer.choiceIndex >= order.length) {
          this.onAnomaly?.({
            studentId,
            reason: 'SUBMIT_CHOICE_INDEX_OUT_OF_RANGE',
            detail: `index=${submit.answer.choiceIndex}`
          })
          return { accepted: false, reason: 'bad-question' }
        }
      }
    }
    state.cursor += 1
    state.maxReachedCursor = Math.max(state.maxReachedCursor, state.cursor)
    return { accepted: true, answer: submit }
  }

  /** choiceIndex ของคนนี้ → choiceId ต้นฉบับ (ใช้ก่อนเทียบเฉลย) */
  translateChoiceIndex(studentId: string, questionId: string, choiceIndex: number): string | null {
    const state = this.students.get(studentId)
    if (!state) return null
    return state.choiceOrders.get(questionId)?.[choiceIndex] ?? null
  }

  getResolvedParams(studentId: string, questionId: string): Record<string, number> {
    return this.students.get(studentId)?.resolvedParams.get(questionId) ?? {}
  }

  /*
   * ย้อนกลับ (โหมด allowBackNavigation: true)
   * - เปิดได้เฉพาะข้อที่ index <= maxReachedCursor (ไม่ให้ดูล่วงหน้า)
   * - ระวัง allowBackNavigation ของข้อเองเป็นสิ่งที่ข้อนั้นกำหนด — จำกัดด้วย maxReachedCursor เสมอ
   */
  navigateBack(studentId: string, request: NavigateToPayload): NavigateResult {
    const state = this.students.get(studentId)
    if (!state) {
      return { ok: false, reason: 'cursor-mismatch' }
    }
    if (request.cursorIndex > state.maxReachedCursor || request.cursorIndex < 0) {
      // พยายามเปิดข้อล่วงหน้า → บันทึก anomaly ทันที
      this.onAnomaly?.({
        studentId,
        reason: 'NAVIGATE_AHEAD_OF_PROGRESS',
        detail: `maxReached=${state.maxReachedCursor}, requested=${request.cursorIndex}`
      })
      return { ok: false, reason: 'cursor-mismatch' }
    }
    if (state.questionOrder[request.cursorIndex] === undefined) {
      return { ok: false, reason: 'bad-question' }
    }
    const payload = this.getPayload(studentId, request.cursorIndex)
    return { ok: true, payload }
  }
}

/**
 * คำตอบ mcq ที่นักเรียนส่ง — แปลงตัวเลือกกลับมาที่เป็น choiceId ต้นฉบับให้ grader
 */
export function resolveStudentChoice(
  dispatcher: QuestionDispatcher,
  studentId: string,
  payload: SubmitAnswerPayload
): Answer & { resolvedChoiceId?: string } {
  if (payload.answer.type === 'mcq') {
    const translated = dispatcher.translateChoiceIndex(
      studentId,
      payload.questionId,
      payload.answer.choiceIndex
    )
    if (translated === null) {
      return { ...payload.answer }
    }
    return { ...payload.answer, resolvedChoiceId: translated }
  }
  return payload.answer
}

import type {
  Answer,
  AutoSaveDraftPayload,
  ClientQuestionPayload,
  StateRecoveryPayload
} from '@shared/exam-schema'
import type { QuestionDispatcher } from './dispatcher'
import type { ResultStore } from './result-store'

/* ============================================================
 * RecoveryManager (Autosave Draft + Crash Recovery)
 * - ฉบับร่างถูกแก้บนเครื่องแม่เท่านั้น (ResultStore เข้ารหัส at-rest)
 * - Reconnect: คืน STATE_RECOVERY = ข้อปัจจุบัน + draft ล่าสุด + เวลาจริง
 * - เมื่อหมดเวลา: ดึง draft ข้อที่กำลังทำค้าง บันทึกเป็นคำตอบที่ส่งแล้ว
 * ============================================================ */

export interface RecoveryManagerOptions {
  resultStore: ResultStore
  sessionId: string
}

export class RecoveryManager {
  constructor(private readonly opts: RecoveryManagerOptions) {}

  /** บันทึกฉบับร่างรายข้อ (ทับค่าเดิม — เรียกทุก ~5s เมื่อมีการเปลี่ยนแปลง) */
  saveDraft(studentId: string, payload: AutoSaveDraftPayload, serverReceivedAtMs: number): void {
    // จับ draft คืนเป็น Answer (payload ตรงตามประกาศ)
    this.opts.resultStore.saveDraft({
      sessionId: this.opts.sessionId,
      studentId,
      questionId: payload.questionId,
      draft: payload.draft,
      updatedAtMs: serverReceivedAtMs
    })
  }

  loadDraft(studentId: string, questionId: string): Answer | null {
    return this.opts.resultStore.loadDraft(this.opts.sessionId, studentId, questionId)
  }

  /**
   * STATE_RECOVERY_PAYLOAD หลัง reconnect:
   * - ข้อปัจจุบันจาก cursor + latest draft ของข้อนั้น
   * - remainingSeconds ต้องมาจากนาฬิกาเครื่องแม่เสมอ (ผู้เรียกคำนวณ)
   */
  buildStateRecovery(
    studentId: string,
    dispatcher: QuestionDispatcher,
    examTitle: string,
    remainingSeconds: number
  ): StateRecoveryPayload | null {
    const cursor = dispatcher.getCursor(studentId)
    if (cursor === null) return null
    const question: ClientQuestionPayload | null = dispatcher.getPayload(studentId, cursor)
    // ทำครบทุกข้อแล้ว: draft ว่าง + question null
    const draft = question ? this.loadDraft(studentId, question.questionId) : null
    return {
      examTitle,
      questionCount: dispatcher.questionCount,
      remainingSeconds,
      cursorIndex: cursor,
      question,
      draft
    }
  }

  /**
   * Auto-collect ตอนหมดเวลา: นำ draft ล่าสุดของข้อปัจจุบันมาบันทึกเป็นคำตอบที่ส่งแล้ว
   * คืน draft ที่เก็บได้ (ผู้เรียกใช้ไปบันทึก submission + grade ต่อ)
   */
  extractCurrentDraftForSubmission(
    studentId: string,
    dispatcher: QuestionDispatcher
  ): { questionId: string; answer: Answer } | null {
    const cursor = dispatcher.getCursor(studentId)
    if (cursor === null) return null
    const question = dispatcher.getPayload(studentId, cursor)
    if (!question) return null
    const draft = this.loadDraft(studentId, question.questionId)
    if (!draft) return null
    return { questionId: question.questionId, answer: draft }
  }
}

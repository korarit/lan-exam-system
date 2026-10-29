import { create } from 'zustand'
import type { Answer, ClientQuestionPayload } from '@shared/exam-schema'
import type { ExamMode } from '@shared/types/exam'

export type StudentExamPhase = 'idle' | 'waiting' | 'active' | 'timeup' | 'completed'

export interface StudentExamState {
  phase: StudentExamPhase
  examTitle: string | null
  question: ClientQuestionPayload | null
  draft: Answer | null
  remainingSeconds: number
  lastDraftSavedAtMs: number | null
  /** ทำแล้วกี่ข้อ (นับจาก maxReached ทีละครั้งที่ submit สำเร็จ) */
  answeredCount: number
  submitRejectedReason: string | null
  finishReason: string | null
  /** ตัวอักษรขยาย กรณี(Normal = 1) */
  fontScale: number
  /** Phase 5: โหมดของห้องนี้ (split เอกสาร / floating HUD) */
  examMode: ExamMode | null
  /** Phase 2 (ท่อกลาง modules): state เริ่มต้นรายโมดูลที่ host ผลักมา (key = moduleId, value = stripped view JSON) */
  moduleStates: Record<string, unknown>
  /** ack ล่าสุดของงาน module ที่ส่งไป (โชว์ใน IDE) */
  lastModuleAck: { moduleId: string; kind: string; ok: boolean; progressText?: string; reason?: string; atMs: number } | null
  identity: { studentId: string; studentName: string } | null

  setIdentity: (identity: { studentId: string; studentName: string }) => void
  onExamStarted: (payload: { examTitle: string; questionCount: number; remainingSeconds: number; examMode?: ExamMode | undefined }) => void
  onQuestion: (payload: ClientQuestionPayload) => void
  onRecovery: (payload: {
    examTitle: string
    questionCount: number
    remainingSeconds: number
    cursorIndex: number
    question: ClientQuestionPayload | null
    draft: Answer | null
    examMode?: ExamMode | undefined
  }) => void
  onTick: (payload: { remainingSeconds: number }) => void
  onLocalDraftSaved: () => void
  onSubmitRejected: (payload: { reason: string }) => void
  onTimeUp: () => void
  onCompleted: (payload: { reason: string }) => void
  onModuleState: (payload: { moduleId: string; stateJson: string }) => void
  onModuleAck: (payload: { moduleId: string; kind: string; ok: boolean; progressText?: string | undefined; reason?: string | undefined }) => void
  reset: () => void
  setFontScale: (scale: number) => void
}

const initial = {
  phase: 'idle' as const,
  examTitle: null,
  question: null,
  draft: null,
  remainingSeconds: 0,
  lastDraftSavedAtMs: null,
  answeredCount: 0,
  submitRejectedReason: null,
  finishReason: null,
  fontScale: 1,
  examMode: null,
  moduleStates: {},
  lastModuleAck: null,
  identity: null
}

export const useStudentExamStore = create<StudentExamState>((set) => ({
  ...initial,
  setIdentity: (identity) => set({ identity }),
  onExamStarted: (payload) =>
    set({
      phase: 'active',
      examTitle: payload.examTitle,
      remainingSeconds: payload.remainingSeconds,
      examMode: payload.examMode ?? null,
      question: null,
      draft: null,
      answeredCount: 0,
      submitRejectedReason: null,
      finishReason: null,
      lastDraftSavedAtMs: null
    }),
  onQuestion: (payload) =>
    set({
      phase: 'active',
      question: payload,
      draft: null,
      submitRejectedReason: null
    }),
  onRecovery: (payload) =>
    set({
      phase: 'active',
      examTitle: payload.examTitle,
      question: payload.question,
      draft: payload.draft,
      remainingSeconds: payload.remainingSeconds,
      examMode: payload.examMode ?? null,
      answeredCount: payload.cursorIndex
    }),
  onTick: (payload) => set({ remainingSeconds: payload.remainingSeconds }),
  onLocalDraftSaved: () => set({ lastDraftSavedAtMs: Date.now() }),
  onSubmitRejected: (payload) => set({ submitRejectedReason: payload.reason }),
  onTimeUp: () => set({ phase: 'timeup' }),
  onCompleted: (payload) => set({ phase: 'completed', finishReason: payload.reason }),
  onModuleState: (payload) => {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(payload.stateJson) as unknown
    } catch {
      return
    }
    set((s) => ({ moduleStates: { ...s.moduleStates, [payload.moduleId]: parsed } }))
  },
  onModuleAck: (payload) =>
    set({
      lastModuleAck: {
        moduleId: payload.moduleId,
        kind: payload.kind,
        ok: payload.ok,
        ...(payload.progressText !== undefined ? { progressText: payload.progressText } : {}),
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        atMs: Date.now()
      }
    }),
  reset: () => set({ ...initial }),
  setFontScale: (scale) => set({ fontScale: Math.min(1.6, Math.max(0.8, scale)) })
}))

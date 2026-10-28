import { z } from 'zod'

/* ============================================================
 * Exam Package (ฝั่งเครื่องแม่เท่านั้น — ห้ามส่งฟิลด์เฉลยไป Client)
 * ============================================================ */

export const QuestionChoiceSchema = z
  .object({
    choiceId: z.string().min(1).max(64),
    text: z.string().min(1).max(500)
  })
  .strict()
export type QuestionChoice = z.infer<typeof QuestionChoiceSchema>

export const QuestionParameterSpecSchema = z
  .object({
    min: z.number().int(),
    max: z.number().int(),
    step: z.number().int().default(1)
  })
  .strict()
export type QuestionParameterSpec = z.infer<typeof QuestionParameterSpecSchema>

const BaseQuestionSchema = z.object({
  questionId: z.string().min(1).max(64),
  /** รองรับตัวแปร เช่น "จงหาค่าของ {{a}} + {{b}}" */
  promptTemplate: z.string().min(1).max(2000),
  points: z.number().positive(),
  /** ค่าตั้งต้น: ส่งแล้วไปข้อถัดไป ไม่ย้อนกลับ */
  allowBackNavigation: z.boolean().default(false),
  parameters: z.record(z.string(), QuestionParameterSpecSchema).optional()
})

export const McqQuestionSchema = BaseQuestionSchema.extend({
  type: z.literal('mcq'),
  choices: z.array(QuestionChoiceSchema).min(2),
  /** เก็บไว้ที่เครื่องแม่เท่านั้น ห้ามส่งไป Client เด็ดขาด! */
  correctChoiceId: z.string().min(1).max(64)
}).strict()

export const ShortAnswerQuestionSchema = BaseQuestionSchema.extend({
  type: z.literal('short-answer'),
  /** เฉลยตรง (trim แล้วเทียบ) — ใช้คู่กับ caseSensitive */
  correctAnswer: z.string().max(200).optional(),
  /** ID ตัวเลือกที่ถูก (จะถูกแม็ปกลับเป็นดัชนีตอนตรวจ) */
  correctAnswerExpression: z.string().min(1).max(80).optional(),
  caseSensitive: z.boolean().default(false)
}).strict()

export const EssayQuestionSchema = BaseQuestionSchema.extend({
  type: z.literal('essay')
}).strict()

export const ExamQuestionSchema = z.discriminatedUnion('type', [
  McqQuestionSchema,
  ShortAnswerQuestionSchema,
  EssayQuestionSchema
])
export type ExamQuestion = z.infer<typeof ExamQuestionSchema>
export type McqQuestion = z.infer<typeof McqQuestionSchema>
export type ShortAnswerQuestion = z.infer<typeof ShortAnswerQuestionSchema>
export type EssayQuestion = z.infer<typeof EssayQuestionSchema>

/** ไฟล์แพ็กเกจข้อสอบของ Core Stepping Runner (รองรับทุกโหมดความปลอดภัย) */
export const ExamDefinitionSchema = z
  .object({
    moduleId: z.literal('stepping-runner'),
    title: z.string().min(1).max(120),
    durationSeconds: z.number().int().min(30).max(8 * 60 * 60),
    questions: z.array(ExamQuestionSchema).min(1).max(200)
  })
  .strict()
export type ExamDefinition = z.infer<typeof ExamDefinitionSchema>

/* ============================================================
 * Client Question Payload (สิ่งเดียวที่เครื่องนักเรียนได้รับต่อข้อ)
 * - ไม่มี correctChoiceId / correctAnswer / ข้ออื่น ๆ โดยเด็ดขาด
 * - ตัวเลือกถูกสลับต่อคนแล้ว → student ตอบด้วยดัชนีในรายการที่เห็น
 * ============================================================ */

export const ClientChoiceSchema = z
  .object({ text: z.string().min(1).max(500) })
  .strict()
export type ClientChoice = z.infer<typeof ClientChoiceSchema>

export const ClientQuestionPayloadSchema = z
  .object({
    moduleId: z.literal('stepping-runner'),
    questionId: z.string().min(1).max(64),
    /** ลำดับรวม (0..N-1) ตามลำดับของนักเรียนคนนั้น */
    cursorIndex: z.number().int().nonnegative(),
    questionCount: z.number().int().positive(),
    type: z.enum(['mcq', 'short-answer', 'essay']),
    /** โจทย์ที่แทนค่าพารามิเตอร์ตาม seed รายคนแล้ว */
    prompt: z.string().min(1).max(4000),
    points: z.number().positive(),
    allowBackNavigation: z.boolean(),
    choices: z.array(ClientChoiceSchema).optional()
  })
  .strict()
export type ClientQuestionPayload = z.infer<typeof ClientQuestionPayloadSchema>

/* ============================================================
 * Student Answer (รูปแบบที่นักเรียนส่งกลับ / อยู่ใน draft / recovery)
 * ============================================================ */

export const AnswerSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('mcq'), choiceIndex: z.number().int().nonnegative().max(9) })
    .strict(),
  z
    .object({
      type: z.literal('text'),
      content: z.string().min(0).max(10_000)
    })
    .strict()
])
export type Answer = z.infer<typeof AnswerSchema>

/* ============================================================
 * Exam network payloads (over TLS + SecureConnection envelope HMAC)
 * ============================================================ */

/** Student → Host: ส่งคำตอบข้อปัจจุบันพร้อมขอข้อถัดไป (HMAC ครอบโดย envelope) */
export const SubmitAnswerPayloadSchema = z
  .object({
    questionId: z.string().min(1).max(64),
    cursorIndex: z.number().int().nonnegative(),
    answer: AnswerSchema,
    /** เวลาที่นักเรียนใช้ในข้อนี้ (ข้อมูลประกอบเท่านั้น — เวลาอ้างอิงที่เครื่องแม่) */
    timeSpentMs: z.number().int().nonnegative().max(24 * 3600 * 1000)
  })
  .strict()
export type SubmitAnswerPayload = z.infer<typeof SubmitAnswerPayloadSchema>

/** Student → Host: บันทึกฉบับร่างระหว่างพิมพ์ (ยังไม่ยืนยันส่ง) */
export const AutoSaveDraftPayloadSchema = z
  .object({
    questionId: z.string().min(1).max(64),
    cursorIndex: z.number().int().nonnegative(),
    draft: AnswerSchema
  })
  .strict()
export type AutoSaveDraftPayload = z.infer<typeof AutoSaveDraftPayloadSchema>

/** Student → Host: ยื่น Final draft ภายใน grace period หลังหมดเวลา */
export const FinalDraftFlushPayloadSchema = z
  .object({
    questionId: z.string().min(1).max(64),
    cursorIndex: z.number().int().nonnegative(),
    answer: AnswerSchema,
    timeSpentMs: z.number().int().nonnegative().max(24 * 3600 * 1000)
  })
  .strict()
export type FinalDraftFlushPayload = z.infer<typeof FinalDraftFlushPayloadSchema>

/** Student → Host: ขอเปิดข้อเก่า (เฉพาะโหมด allowBackNavigation) */
export const NavigateToPayloadSchema = z
  .object({
    cursorIndex: z.number().int().nonnegative()
  })
  .strict()
export type NavigateToPayload = z.infer<typeof NavigateToPayloadSchema>

/** Host → Student: เริ่มสอบ (ค่าเวลาจากเครื่องแม่เสมอ) */
export const ExamStartedPayloadSchema = z
  .object({
    examTitle: z.string().min(1).max(120),
    questionCount: z.number().int().positive(),
    remainingSeconds: z.number().int().nonnegative()
  })
  .strict()
export type ExamStartedPayload = z.infer<typeof ExamStartedPayloadSchema>

/** Host → Student: กู้คืนหลังหลุด/ค้าง (draft ล่าสุด + เวลาจริงจากเครื่องแม่) */
export const StateRecoveryPayloadSchema = z
  .object({
    examTitle: z.string().min(1).max(120),
    questionCount: z.number().int().positive(),
    remainingSeconds: z.number().int().nonnegative(),
    cursorIndex: z.number().int().nonnegative(),
    question: ClientQuestionPayloadSchema.nullable(),
    draft: AnswerSchema.nullable()
  })
  .strict()
export type StateRecoveryPayload = z.infer<typeof StateRecoveryPayloadSchema>

/** Host → Student: เวลาหมด — ล็อกจอทันที แล้วยื่น final draft ภายใน grace period */
export const ExamTimeUpPayloadSchema = z.object({}).strict()

/** Host → Student: ปรนัย/ข้อถูกปฏิเสธ (cursor ผิด / หมดเวลา / คำตอบไม่ถูกต้อง) */
export const SubmitRejectedPayloadSchema = z
  .object({ reason: z.enum(['cursor-mismatch', 'time-expired', 'bad-question', 'not-started']) })
  .strict()
export type SubmitRejectedPayload = z.infer<typeof SubmitRejectedPayloadSchema>

/** Host → Student: ทำครบทุกข้อหรือถูกเก็บอัตโนมัติ */
export const ExamCompletedPayloadSchema = z
  .object({ reason: z.enum(['completed', 'time-up', 'ended-by-host']) })
  .strict()
export type ExamCompletedPayload = z.infer<typeof ExamCompletedPayloadSchema>

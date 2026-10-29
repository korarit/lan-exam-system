import { z } from 'zod'

/* ============================================================
 * Phase 7 — Wire format ของคำตอบ Dynamic Form
 * (SUBMIT_FORM_ITEM / AUTOSAVE_FORM_ITEM / FINAL_COLLECTION)
 * โครงร่าง "ค่าคำตอบหลังจัดเก็บ" (StoredAnswerValue) ใช้ได้ทั้ง
 * - เครือข่าย TLS เรียงตาม ItemId
 * - SQLite FormResponseStore (เป็น JSON เข้ารหัส AES-256-GCM)
 * - AutoGrader ฝั่งเครื่องแม่
 * ไฟล์แนบของข้อ file_upload เก็บเป็น descriptor ที่ชี้เข้า
 * Local Encrypted File Vault เท่านั้น (เนื้อไฟล์ไม่ฝังใน JSON คำตอบ)
 * ============================================================ */

export const ArtifactIdSchema = z
  .string()
  .regex(/^[a-z0-9]{1,64}$/, 'ARTIFACT_ID_MUST_BE_SLUG')
export type ArtifactId = z.infer<typeof ArtifactIdSchema>

/** ตัวชี้ไฟล์แนบที่เครื่องแม่เข้ารหัส centralized ไว้แล้ว */
export const StoredArtifactDescriptorSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    fileName: z.string().min(1).max(260),
    mimeType: z.string().max(120).default('application/octet-stream'),
    sizeBytes: z.number().int().nonnegative(),
    /** SHA-256 ของไฟล์ตั้งแต่ฝั่งนักเรียน (เครื่องแม่คอมมิตไว้แล้ว) */
    sha256: z.string().length(64),
  })
  .strict()
export type StoredArtifactDescriptor = z.infer<typeof StoredArtifactDescriptorSchema>

export const StoredAnswerValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('choice'), choiceId: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('multi'), choiceIds: z.array(z.string().min(1).max(64)).min(0).max(20) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().min(0).max(20_000) }).strict(),
  z.object({ kind: z.literal('date'), value: z.string().min(1).max(80) }).strict(),
  z.object({ kind: z.literal('numeric'), numeric: z.number() }).strict(),
  z.object({
    kind: z.literal('rows'),
    rowAnswers: z.record(z.string().min(1).max(64), z.union([z.string().min(1).max(64), z.array(z.string().min(1).max(64))]))
  }).strict(),
  z.object({ kind: z.literal('scale'), value: z.number() }).strict(),
  z.object({ kind: z.literal('code'), text: z.string().min(0).max(20_000) }).strict(),
  z.object({ kind: z.literal('files'), artifactIds: z.array(ArtifactIdSchema).min(0).max(20) }).strict()
])
export type StoredAnswerValue = z.infer<typeof StoredAnswerValueSchema>

/** คำตอบรายข้อ 1 ชิ้น (สิ่งที่นักเรียน 1 คนกรอกได้ต่อข้อ 1 ข้อ) */
export const FormItemSubmissionSchema = z
  .object({
    itemId: z.string().min(1).max(64),
    value: StoredAnswerValueSchema,
    /** เวลาที่ใช้ทำข้อนี้ (ข้อมูลประกอบ — เวลาอ้างอิงเป็นเครื่องแม่เสมอ) */
    timeSpentMs: z.number().int().nonnegative().max(24 * 3600 * 1000).default(0),
    /** เวลาที่เครื่องนักเรียนไล่ไป ห้ามเป็นตัวตัดสิน — บันทึกลง audit เสมอ */
    clientSubmittedAtMs: z.number().int().nonnegative().default(0)
  })
  .strict()
export type FormItemSubmission = z.infer<typeof FormItemSubmissionSchema>

/** เปิด descriptors เป็นชุดที่ไม่ซ้ำ itemId/artifactId */
export const FormArtifactUploadSchema = z
  .object({
    itemId: z.string().min(1).max(64),
    artifactId: ArtifactIdSchema,
    fileName: z.string().min(1).max(260),
    mimeType: z.string().max(120).default('application/octet-stream'),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().length(64)
  })
  .strict()
export type FormArtifactUpload = z.infer<typeof FormArtifactUploadSchema>

/** รวมคำตอบทั้งชุดของนักเรียน 1 คน (ตอนเก็บงานครั้งสุดท้าย / regrade ใช้ชุดนี้หืนค่าเดิม) */
export const FormSubmissionPayloadSchema = z
  .object({
    studentId: z.string().min(1).max(40),
    /** Seed ของนักเรียนคนนั้น (ใช้ dereference ลำดับข้อ/ช้อยส์กลับ canonical ตอน Export) */
    studentSeed: z.string().min(1).max(400),
    items: z.array(FormItemSubmissionSchema).min(1).max(200),
    artifacts: z.array(FormArtifactUploadSchema).max(60),
    reason: z.enum(['submitted', 'time-up']).default('submitted')
  })
  .strict()
export type FormSubmissionPayload = z.infer<typeof FormSubmissionPayloadSchema>

/** สถานะการตรวจต่อข้อ (ใน DB + UI) */
export const FormItemGradeStatusSchema = z.enum([
  'auto-graded',
  'needs-manual',
  'manual-graded',
  'invalid',
  'ungraded'
])
export type FormItemGradeStatus = z.infer<typeof FormItemGradeStatusSchema>

export const FormJourneyRecordSchema = z
  .object({
    itemId: z.string().min(1).max(64),
    timeSpentMs: z.number().int().nonnegative(),
    submittedAtMs: z.number().int().nonnegative()
  })
  .strict()
export type FormJourneyRecord = z.infer<typeof FormJourneyRecordSchema>

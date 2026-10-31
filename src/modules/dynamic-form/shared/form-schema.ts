import { z } from 'zod'
import type { QuestionParameterSpec } from '@shared/exam-schema'

/* ============================================================
 * Phase 6 — Dynamic Form Module: Shared Schema
 * 12 ชนิด Input + 2 บล็อกคั่น (section_header / media_stimulus)
 * กติกา Host-authoritative: ฟิลด์ answerKey เป็นของเครื่องแม่เท่านั้น
 * ห้ามส่งไปยังเครื่องนักเรียนด้วยรูปแบบใด ๆ (ตัดด้วย stripAnswerKeyForStudent)
 * ============================================================ */

export const DYNAMIC_FORM_INPUT_TYPES = [
  'mcq_single',
  'checkbox_multi',
  'dropdown',
  'short_text',
  'long_text',
  'numeric_param',
  'mcq_grid',
  'checkbox_grid',
  'linear_scale',
  'date_time',
  'code_snippet',
  'file_upload'
] as const
export type DynamicFormInputType = (typeof DYNAMIC_FORM_INPUT_TYPES)[number]

export const DYNAMIC_FORM_BLOCK_TYPES = ['section_header', 'media_stimulus'] as const
export type FormBlockType = (typeof DYNAMIC_FORM_BLOCK_TYPES)[number]

export const INPUT_TYPE_LABELS: Record<DynamicFormInputType, string> = {
  mcq_single: 'เลือกเดียว (Multiple Choice)',
  checkbox_multi: 'เลือกได้หลายข้อ (Checkboxes)',
  dropdown: 'ดรอปดาวน์',
  short_text: 'คำตอบสั้น',
  long_text: 'คำตอบยาว / เรียงความ',
  numeric_param: 'ตัวเลข / พารามิเตอร์',
  mcq_grid: 'ตารางเลือกเดียว (Grid)',
  checkbox_grid: 'ตารางเลือกหลายข้อ (Grid)',
  linear_scale: 'สเกลระดับคะแนน',
  date_time: 'วันที่ / เวลา',
  code_snippet: 'กล่องพิมพ์โค้ด',
  file_upload: 'แนบไฟล์งาน'
}

/* ---------- Assets (ฝังในไฟล์ .ztform แบบ Content-Addressed) ---------- */

export const FormAssetSchema = z.object({
  mimeType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/, 'INVALID_MIME').max(100),
  dataBase64: z.string().max(6_000_000)
})
export type FormAsset = z.infer<typeof FormAssetSchema>

export type FormAssetMap = Record<string, FormAsset>

/* ---------- กฎ Validation ต่อข้อ (FormValidationRuleSchema) ---------- */

export const FormValidationRuleSchema = z
  .object({
    required: z.boolean().default(true),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    minSelect: z.number().int().nonnegative().optional(),
    maxSelect: z.number().int().nonnegative().optional(),
    minWords: z.number().int().nonnegative().optional(),
    maxWords: z.number().int().nonnegative().optional(),
    decimalPlaces: z.number().int().min(0).max(6).optional(),
    regexPattern: z.string().max(500).optional(),
    customErrorMessage: z.string().max(200).optional(),
    allowedExtensions: z.array(z.string().regex(/^(\.[\w]+)|(none)$/).max(12)).max(20).optional(),
    maxFileSizeBytes: z.number().int().positive().max(64 * 1024 * 1024).optional()
  })

export type FormValidationRule = z.infer<typeof FormValidationRuleSchema>

/* ---------- เฉลย + เกณฑ์คะแนน (AnswerKeySchema) ---------- */

export const GridRowSchema = z.object({
  rowId: z.string().min(1).max(64),
  label: z.string().min(1).max(300)
})
export const GridColumnSchema = z.object({
  columnId: z.string().min(1).max(64),
  label: z.string().min(1).max(300)
})
export type GridRow = z.infer<typeof GridRowSchema>
export type GridColumn = z.infer<typeof GridColumnSchema>

export const RubricCriterionSchema = z.object({
  criterionId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  maxPoints: z.number().positive().max(10000)
})
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>

export const AnswerKeySchema = z.discriminatedUnion('gradingType', [
  z.object({
    gradingType: z.literal('exact_choice'),
    correctChoiceId: z.string().min(1).max(64),
    /** น้ำหนักของแต่ละตัวเลือก (0..1 ของคะแนนเต็ม) — ไม่ระบุ = เฉพาะข้อถูกได้เต็ม */
    choiceWeights: z.record(z.string().min(1).max(64), z.number().min(0).max(1)).optional()
  }),
  z.object({
    gradingType: z.literal('multi_choice'),
    correctChoiceIds: z.array(z.string().min(1).max(64)).min(1).max(20),
    scoringMode: z.enum(['all-or-nothing', 'partial-with-penalty']),
    penaltyPerWrongRatio: z.number().min(0).max(1).default(0.5)
  }),
  z.object({
    gradingType: z.literal('short_text_match'),
    acceptedAnswers: z.array(z.string().min(1).max(500)).min(1).max(50),
    caseSensitive: z.boolean().default(false),
    trimWhitespace: z.boolean().default(true),
    useRegex: z.boolean().default(false)
  }),
  z.object({
    gradingType: z.literal('numeric_formula'),
    /** ค่าคงที่ เช่น "25.5" หรือสูตรใช้ตัวแปร เช่น "(a * b) / 2" */
    formulaOrValue: z.string().min(1).max(300),
    tolerance: z.number().nonnegative().max(1_000_000).default(0.01)
  }),
  z.object({
    gradingType: z.literal('grid_match'),
    /** mcq_grid: rowId -> columnId / checkbox_grid: rowId -> [columnId, ...] */
    rowAnswerMap: z.record(z.string().min(1).max(64), z.union([z.string().min(1).max(64), z.array(z.string().min(1).max(64))])).refine(
      (map) => Object.keys(map).length > 0
    ),
    pointsPerRow: z.number().positive().max(10000)
  }),
  z.object({
    gradingType: z.literal('manual_rubric'),
    rubricCriteria: z.array(RubricCriterionSchema).max(20).optional(),
    expectedKeywords: z.array(z.string().min(1).max(100)).max(50).optional(),
    teacherReferenceNote: z.string().max(4000).optional()
  }),
  z.object({
    gradingType: z.literal('ungraded')
  })
])

export type AnswerKey = z.infer<typeof AnswerKeySchema>

export const EMPTY_ANSWER_KEY: AnswerKey = { gradingType: 'ungraded' }
export const EMPTY_VALIDATION: FormValidationRule = { required: true }

/* ---------- Base ร่วมของทุกข้อ ---------- */

const QuestionParameterSpecLocal = z
  .object({
    min: z.number().int(),
    max: z.number().int(),
    step: z.number().int().default(1)
  })

const BaseFormQuestionSchema = z.object({
  itemId: z.string().min(1).max(64),
  prompt: z.string().max(4000).default(''),
  /** รูปประกอบโจทย์ (asset id = sha256 hex ใน asset map) */
  imageAssetId: z.string().length(64).optional(),
  points: z.number().positive().max(10000).default(1),
  shuffleChoices: z.boolean().default(false),
  /** ตัวแปรสุ่มในโจทย์ เช่น {{a}} (ใช้กับ prompt + สูตรเฉลย) */
  parameters: z.record(z.string().regex(/^[a-zA-Z][\w]{0,15}$/), QuestionParameterSpecLocal).optional(),
  validation: FormValidationRuleSchema.default(() => ({ required: true })),
  /** เฉลย/เกณฑ์คะแนนของข้อนี้ (ยังไม่ตั้ง = ungraded) ฝั่งเครื่องแม่เท่านั้น */
  answerKey: AnswerKeySchema
})

export const FormChoiceSchema = z.object({
  choiceId: z.string().min(1).max(64),
  text: z.string().min(1).max(500),
  imageAssetId: z.string().length(64).optional()
})
export type FormChoice = z.infer<typeof FormChoiceSchema>

/* ---------- ข้อทั้ง 12 ชนิด (discriminated ด้วย inputType) ---------- */

export const McqSingleItemSchema = BaseFormQuestionSchema.extend({
  inputType: z.literal('mcq_single'),
  choices: z.array(FormChoiceSchema).min(2).max(20)
})

export const CheckboxMultiItemSchema = BaseFormQuestionSchema.extend({
  inputType: z.literal('checkbox_multi'),
  choices: z.array(FormChoiceSchema).min(2).max(20)
})

export const DropdownItemSchema = BaseFormQuestionSchema.extend({
  inputType: z.literal('dropdown'),
  choices: z.array(FormChoiceSchema).min(2).max(20)
})

export const ShortTextItemSchema = BaseFormQuestionSchema.extend({
  inputType: z.literal('short_text')
})

export const LongTextItemSchema = BaseFormQuestionSchema.extend({
  inputType: z.literal('long_text')
})

export const NumericParamItemSchema = BaseFormQuestionSchema.extend({
  inputType: z.literal('numeric_param'),
  unit: z.string().max(30).default('')
})

export const McqGridItemSchema = BaseFormQuestionSchema.extend({
  inputType: z.literal('mcq_grid'),
  rows: z.array(GridRowSchema).min(1).max(12),
  columns: z.array(GridColumnSchema).min(2).max(12)
})

export const CheckboxGridItemSchema = BaseFormQuestionSchema.extend({
  inputType: z.literal('checkbox_grid'),
  rows: z.array(GridRowSchema).min(1).max(12),
  columns: z.array(GridColumnSchema).min(2).max(12)
})

export const LinearScaleItemSchema = BaseFormQuestionSchema.extend({
  inputType: z.literal('linear_scale'),
  scaleMin: z.number().int().min(0).max(99),
  scaleMax: z.number().int().min(1).max(100),
  leftLabel: z.string().max(120).optional(),
  rightLabel: z.string().max(120).optional()
})

export const DateTimeItemSchema = BaseFormQuestionSchema.extend({
  inputType: z.literal('date_time'),
  mode: z.enum(['date', 'time', 'datetime']).default('date')
})

export const CodeSnippetItemSchema = BaseFormQuestionSchema.extend({
  inputType: z.literal('code_snippet'),
  language: z.enum(['python', 'c', 'cpp', 'java', 'sql', 'js']).default('python'),
  starterCode: z.string().max(20_000).default('')
})

export const FileUploadItemSchema = BaseFormQuestionSchema.extend({
  inputType: z.literal('file_upload'),
  acceptMultiple: z.boolean().default(false)
})

/* ---------- บล็อกคั่น (ไม่ใช่ข้อสอบ — ไม่มีคะแนน/เฉลย) ---------- */

export const SectionHeaderBlockSchema = z.object({
  inputType: z.literal('section_header'),
  itemId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).default('')
})

export const MediaStimulusBlockSchema = z.object({
  inputType: z.literal('media_stimulus'),
  itemId: z.string().min(1).max(64),
  imageAssetId: z.string().length(64),
  caption: z.string().max(1000).default('')
})

export const FormItemSchema = z.discriminatedUnion('inputType', [
  McqSingleItemSchema,
  CheckboxMultiItemSchema,
  DropdownItemSchema,
  ShortTextItemSchema,
  LongTextItemSchema,
  NumericParamItemSchema,
  McqGridItemSchema,
  CheckboxGridItemSchema,
  LinearScaleItemSchema,
  DateTimeItemSchema,
  CodeSnippetItemSchema,
  FileUploadItemSchema,
  SectionHeaderBlockSchema,
  MediaStimulusBlockSchema
])
export type FormItem = z.infer<typeof FormItemSchema>
export type FormQuestion = Exclude<FormItem, z.infer<typeof SectionHeaderBlockSchema> | z.infer<typeof MediaStimulusBlockSchema>>
export type { QuestionParameterSpec }

export function isFormItemQuestion(item: FormItem): item is FormQuestion {
  return !(
    item.inputType === 'section_header' ||
    item.inputType === 'media_stimulus'
  )
}

/* ---------- ค่าตั้งของฟอร์ม + นิยามฟอร์มทั้งชุด ---------- */

export const FormSettingsSchema = z.object({
  durationMinutes: z.number().int().min(1).max(8 * 60).default(30),
  shuffleQuestionsPerStudent: z.boolean().default(false),
  navigationPolicy: z.enum(['strict-one-way', 'allow-visited-review']).default('strict-one-way'),
  showScoreImmediatelyAfterSubmit: z.boolean().default(false)
})
export type FormSettings = z.infer<typeof FormSettingsSchema>

export const DynamicFormDefinitionSchema = z.object({
  moduleId: z.literal('dynamic-form'),
  formId: z.uuid(),
  title: z.string().min(1).max(120),
  instructions: z.string().max(4000).default(''),
  settings: FormSettingsSchema.default(() => ({
    durationMinutes: 30,
    shuffleQuestionsPerStudent: false,
    navigationPolicy: 'strict-one-way',
    showScoreImmediatelyAfterSubmit: false
  } as const)),
  items: z.array(FormItemSchema).min(0).max(200)
})
export type DynamicFormDefinition = z.infer<typeof DynamicFormDefinitionSchema>

/* ---------- โครงไฟล์ .ztform (ฝั่ง Main เขียน/อ่าน ผ่าน module main) ---------- */

export const ZtformManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    formId: z.uuid(),
    title: z.string().min(1).max(120),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    totalQuestions: z.number().int().nonnegative(),
    totalPoints: z.number().nonnegative()
  })
  .strict()
export type ZtformManifest = z.infer<typeof ZtformManifestSchema>

export const ZtformContainerSchema = z
  .object({
    container: z.literal('ztform'),
    formatVersion: z.literal(1),
    integrityKey: z.string().length(64),
    integrityHmac: z.string().length(64),
    manifest: ZtformManifestSchema,
    form: DynamicFormDefinitionSchema,
    assets: z.record(z.string().length(64), FormAssetSchema)
  })
  .strict()
export type ZtformContainer = z.infer<typeof ZtformContainerSchema>

/** ซองเข้ารหัสด้วยรหัสผ่านครู (PBKDF2 100k → AES-256-GCM) ภายในเก็บ JSON ของ ZtformContainer */
export const ZtformEncryptedEnvelopeSchema = z
  .object({
    container: z.literal('ztform-encrypted'),
    formatVersion: z.literal(1),
    kdf: z.object({
      saltBase64: z.string().min(8).max(64),
      iterations: z.number().int().min(1).max(5_000_000),
      keyLengthBytes: z.number().int().refine((v) => v === 32)
    }),
    cipher: z.object({
      ivBase64: z.string().min(8).max(64),
      tagBase64: z.string().min(12).max(64),
      dataBase64: z.string().max(16_000_000)
    })
  })
  .strict()
export type ZtformEncryptedEnvelope = z.infer<typeof ZtformEncryptedEnvelopeSchema>

/* ---------- ผลลัพธ์ Strip เฉลย (สิ่งที่ส่งไปได้ที่เครื่องนักเรียน) ---------- */

/** Omit แบบไม่ทำลาย discriminated union */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** โจทย์บนมุมมองนักเรียน — รับประกันว่าไม่มี answerKey/points/parameters (เฉลย+คะแนน) */
export type StudentFormItem = DistributiveOmit<
  FormQuestion,
  'answerKey' | 'points' | 'parameters'
> & {
  /** โจทย์ที่แทนค่า {{param}} ตาม seed ของนักเรียนแล้ว */
  prompt: string
}

/** มุมมองนักเรียน: ข้อที่ตัดเฉลย + บล็อกคั่น/สื่อ (ส่งได้ทั้งหมด) */
export type StudentFormViewItem = StudentFormItem | FormItem

/** ค่าพารามิเตอร์ที่ resolve ตาม seed (ใช้ตรวจสูตรเฉลยฝั่งเครื่องแม่เท่านั้น) */
export type ResolvedParameters = Record<string /* itemId */, Record<string, number>>

export interface StudentFormView {
  moduleId: 'dynamic-form'
  formId: string
  title: string
  instructions: string
  settings: FormSettings
  items: StudentFormViewItem[]
  /** VULN-61: progressive disclosure — จำนวนข้อทั้งหมด vs ที่เปิดให้เห็นแล้ว */
  totalQuestions?: number
  revealedQuestions?: number
}

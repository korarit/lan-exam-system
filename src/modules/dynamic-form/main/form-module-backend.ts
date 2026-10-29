import type {
  ExamModuleId,
  ExamModuleMetadata,
  HostExamModuleBackend,
  StudentSessionContext,
  StudentActionResult
} from '@shared/module-contract'
import { DynamicFormDefinitionSchema, type DynamicFormDefinition } from '../shared/form-schema'
import { stripAnswerKeyForStudent } from '../shared/student-view'

/* ============================================================
 * Phase 6 — Embedded Backend ของโมดูล dynamic-form
 * (Dispatcher/Grader/Export เต็มรูปแบบจะต่อใน Phase 7 —
 *  ส่วนนี้ผูกสัญญา + ตัดเฉลยรายคนให้เรียบร้อยตั้งแต่ตอนนี้)
 * ============================================================ */

export const DYNAMIC_FORM_METADATA: ExamModuleMetadata = {
  moduleId: 'dynamic-form' as ExamModuleId,
  displayName: 'Dynamic Form Builder',
  description:
    'ข้อสอบฟอร์มแบบสร้างเอง 12 ชนิด Input สลับลำดับรายคน บันทึกเป็นไฟล์ .ztform พร้อมเฉลยและรูปภาพ',
  version: '1.0.0',
  fileExtension: '.ztform',
  supportedSecurityModes: ['closed', 'in-app-docs', 'external-tools']
}

export class DynamicFormModuleBackend implements HostExamModuleBackend<DynamicFormDefinition> {
  readonly metadata = DYNAMIC_FORM_METADATA

  validatePackage(rawPackage: unknown): DynamicFormDefinition {
    const parsed = DynamicFormDefinitionSchema.safeParse(rawPackage)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(`FORM_PACKAGE_INVALID: ${issue?.path.join('.') ?? ''} (โฮสต์ไม่รับแพ็กเกจฟอร์มที่ไม่ผ่าน Schema)`)
    }
    const form = parsed.data
    const hasQuestion = form.items.some(
      (item) => item.inputType !== 'section_header' && item.inputType !== 'media_stimulus'
    )
    if (!hasQuestion) throw new Error('FORM_PACKAGE_EMPTY')
    return form
  }

  /** เตรียม state รายคน: ตัดเฉลย 100% + สลับข้อ/ตัวเลือกตาม seed (Phase 7 จะดำเนิน cursor ต่อ) */
  async initializeStudentSession(ctx: StudentSessionContext<DynamicFormDefinition>): Promise<{
    view: ReturnType<typeof stripAnswerKeyForStudent>['view']
    resolvedParameters: ReturnType<typeof stripAnswerKeyForStudent>['resolvedParameters']
  }> {
    const form = this.validatePackage(ctx.examPackage)
    return stripAnswerKeyForStudent(form, ctx.studentSeed)
  }

  async handleStudentAction(): Promise<StudentActionResult<never>> {
    throw new Error('PHASE_7_DISPATCHER_PENDING')
  }

  async handleAutosaveDraft(): Promise<void> {
    // Phase 7 — เก็บฉบับร่างลง AES store
  }

  async finalizeStudentSession(): Promise<void> {
    // Phase 7 — เก็บคำตอบสุดท้าย + คิดคะแนนรวม
  }

  async exportResultsCsv(): Promise<Uint8Array> {
    throw new Error('PHASE_7_EXPORT_PENDING')
  }
}

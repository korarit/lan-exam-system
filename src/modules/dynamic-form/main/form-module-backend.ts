import type {
  HostExamModuleBackend,
  StudentSessionContext,
  StudentActionResult
} from '@shared/module-contract'
import { DynamicFormDefinitionSchema, type DynamicFormDefinition } from '../shared/form-schema'
import { DYNAMIC_FORM_METADATA } from '../shared/module-metadata'
import { stripAnswerKeyForStudent } from '../shared/student-view'

/* ============================================================
 * Phase 6+7 — Embedded Backend ของโมดูล dynamic-form
 * - ตัดเฉลยรายคน (stripAnswerKeyForStudent) ให้ฝั่งเครื่องนักเรียน
 * - ช่องทาง ingest จริง (validate / vault / auto-grading / re-grade /
 *   export CSV & .ztresults) อยู่ที่ FormHostService (form-host-service.ts)
 * และถูก wire ผ่าน ipc/form-response-handlers.ts แล้วทั้งหมด
 * ============================================================ */

export class DynamicFormModuleBackend implements HostExamModuleBackend<DynamicFormDefinition> {
  readonly metadata = DYNAMIC_FORM_METADATA

  /** ตัวจัดการคำตอบ/ไฟล์แนบ/คะแนนของห้อง (ผูกตอน register modules บนเครื่องแม่) */
  private ingestion: {
    handleStudentAction?: (roomId: string, studentId: string, action: unknown, serverTimestampMs: number) => Promise<unknown>
    handleAutosaveDraft?: (roomId: string, studentId: string, draftPayload: unknown, serverTimestampMs: number) => Promise<void>
    finalizeStudentSession?: (roomId: string, studentId: string, seed: string, reason: 'submitted' | 'time-up') => Promise<void>
    exportResultsCsv?: (roomId: string) => Promise<Uint8Array>
  } = {}

  /** ผูกบริการเครื่องแม่ (FormHostService) — เรียกครั้งเดียวตอน boot ของเครื่องแม่ */
  attachIngestionBridge(bridge: typeof this.ingestion): void {
    this.ingestion = bridge
  }

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

  /** เตรียม state รายคน: ตัดเฉลย 100% + สลับข้อ/ตัวเลือกตาม seed + resolve ตัวแปรรายคน */
  async initializeStudentSession(ctx: StudentSessionContext<DynamicFormDefinition>): Promise<{
    view: ReturnType<typeof stripAnswerKeyForStudent>['view']
    resolvedParameters: ReturnType<typeof stripAnswerKeyForStudent>['resolvedParameters']
  }> {
    const form = this.validatePackage(ctx.examPackage)
    return stripAnswerKeyForStudent(form, ctx.studentSeed)
  }

  /** คำตอบรายข้อ (SUBMIT_FORM_ITEM) → validator + instant auto-grade ของ FormHostService */
  async handleStudentAction(ctx: {
    roomId: string
    studentId: string
    action: unknown
    serverTimestampMs: number
  }): Promise<StudentActionResult<never>> {
    if (this.ingestion.handleStudentAction !== undefined) {
      await this.ingestion.handleStudentAction(ctx.roomId, ctx.studentId, ctx.action, ctx.serverTimestampMs)
    }
    return { progressText: 'item-ingested', isFinished: false }
  }

  /** ฉบับร่าง (AUTOSAVE_FORM_ITEM) — คำตอบสุดท้ายจะถูกตรวจอีกครั้งตอน submit */
  async handleAutosaveDraft(ctx: { roomId: string; studentId: string; draftPayload: unknown }): Promise<void> {
    if (this.ingestion.handleAutosaveDraft !== undefined) {
      await this.ingestion.handleAutosaveDraft(ctx.roomId, ctx.studentId, ctx.draftPayload, Date.now())
    }
  }

  /** เก็บงานจบชุด (submitted / time-up) */
  async finalizeStudentSession(ctx: { roomId: string; studentId: string; reason: 'submitted' | 'time-up' }): Promise<void> {
    if (this.ingestion.finalizeStudentSession !== undefined) {
      await this.ingestion.finalizeStudentSession(ctx.roomId, ctx.studentId, '', ctx.reason)
    }
  }

  /** Export ผลเป็น CSV (UTF-8 BOM + คอลัมน์ Q1..QN = CsvResponseExporter) */
  async exportResultsCsv(roomId: string): Promise<Uint8Array> {
    if (this.ingestion.exportResultsCsv === undefined) throw new Error('PHASE_7_EXPORT_BRIDGE_NOT_ATTACHED')
    return await this.ingestion.exportResultsCsv(roomId)
  }
}

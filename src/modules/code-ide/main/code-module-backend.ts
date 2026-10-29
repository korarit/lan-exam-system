import type {
  HostExamModuleBackend,
  StudentSessionContext,
  StudentActionResult
} from '@shared/module-contract'
import { CODE_IDE_METADATA } from '../shared/module-metadata'
import {
  CodeExamPackageSchema,
  type CodeExamPackage,
  type StudentCodePackageView
} from '../shared/code-schema'
import { stripCodePackageForStudent } from '../shared/student-view'

/* ============================================================
 * Phase 10 — CodeIdeModuleBackend (เต็มรูปแบบ แทน stub ของ Phase 8)
 * - validatePackage: ตรวจ .ztcode package ฝั่งเครื่องแม่
 * - initializeStudentSession: ตัดความลับ 100% (hidden entries/tests/เฉลย)
 *   + กระจาย DependencyBundle info + sampleTests ให้นักเรียน
 * - handleStudentAction / handleAutosaveDraft: รับโปรเจกต์ผ่าน
 *   CodeIdeHostService (validate → SQLite เข้ารหัส → sync ดิสก์ครู → คิวตรวจ)
 * - exportResultsCsv: คะแนนรวม + manual rubric (manual ชนะ auto)
 * หมายเหตุ: ช่อง ingest จริงอยู่ที่ CodeIdeHostService และถูก wire ผ่าน
 * IPC handlers ของเครื่องแม่ทั้งหมด (ดู main/ipc/code-ide-host-handlers.ts)
 * ============================================================ */

export class CodeIdeModuleBackend
  implements HostExamModuleBackend<CodeExamPackage, StudentCodePackageView, unknown>
{
  readonly metadata = CODE_IDE_METADATA

  /** บริการเครื่องแม่ (ผูกตอน boot — ดู main/index.ts ensureCodeIdeService) */
  private ingestion: {
    handleStudentAction?: (
      roomId: string,
      studentId: string,
      action: unknown,
      serverTimestampMs: number
    ) => Promise<unknown>
    handleAutosaveDraft?: (
      roomId: string,
      studentId: string,
      draftPayload: unknown,
      serverTimestampMs: number
    ) => Promise<void>
    finalizeStudentSession?: (
      roomId: string,
      studentId: string,
      reason: 'submitted' | 'time-up'
    ) => Promise<void>
    exportResultsCsv?: (roomId: string) => Promise<Uint8Array>
  } = {}

  /** ผูกบริการเครื่องแม่ — เรียกครั้งเดียวตอน boot ของเครื่องแม่ */
  attachIngestionBridge(bridge: typeof this.ingestion): void {
    this.ingestion = bridge
  }

  validatePackage(rawPackage: unknown): CodeExamPackage {
    const parsed = CodeExamPackageSchema.safeParse(rawPackage)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(`CODE_PACKAGE_INVALID: ${issue?.path.join('.') ?? ''} (โฮสต์ไม่รับแพ็กเกจ .ztcode ที่ไม่ผ่าน Schema)`)
    }
    if (parsed.data.entries.length === 0) throw new Error('CODE_PACKAGE_EMPTY')
    return parsed.data
  }

  /** เตรียม state รายคน: strip ความลับ + ส่ง starter + sample tests + policy */
  async initializeStudentSession(
    ctx: StudentSessionContext<CodeExamPackage>
  ): Promise<StudentCodePackageView> {
    const pkg = this.validatePackage(ctx.examPackage)
    return stripCodePackageForStudent(pkg)
  }

  /** นักเรียนกดส่งงาน ({ type:'code-ide.submit', entries }) → validator + คิวตรวจ */
  async handleStudentAction(ctx: {
    roomId: string
    studentId: string
    action: unknown
    serverTimestampMs: number
  }): Promise<StudentActionResult<StudentCodePackageView>> {
    if (this.ingestion.handleStudentAction !== undefined) {
      await this.ingestion.handleStudentAction(ctx.roomId, ctx.studentId, ctx.action, ctx.serverTimestampMs)
    }
    return { progressText: 'code-project-ingested', isFinished: false }
  }

  /** autosave ทุก 5 วินาที ({ entries }) — ฉบับร่างเข้ารหัส + sync ดิสก์ครู */
  async handleAutosaveDraft(ctx: {
    roomId: string
    studentId: string
    draftPayload: unknown
    serverTimestampMs: number
  }): Promise<void> {
    if (this.ingestion.handleAutosaveDraft !== undefined) {
      await this.ingestion.handleAutosaveDraft(ctx.roomId, ctx.studentId, ctx.draftPayload, ctx.serverTimestampMs)
    }
  }

  async finalizeStudentSession(ctx: {
    roomId: string
    studentId: string
    reason: 'submitted' | 'time-up'
  }): Promise<void> {
    if (this.ingestion.finalizeStudentSession !== undefined) {
      await this.ingestion.finalizeStudentSession(ctx.roomId, ctx.studentId, ctx.reason)
    }
  }

  async exportResultsCsv(roomId: string): Promise<Uint8Array> {
    if (this.ingestion.exportResultsCsv === undefined) throw new Error('PHASE_10_EXPORT_BRIDGE_NOT_ATTACHED')
    return await this.ingestion.exportResultsCsv(roomId)
  }
}

/** type-guard ให้ network/IPC layer แยก action ส่งงานออกจาก action อื่น */
export function extractSubmittedEntries(action: unknown): unknown | null {
  if (typeof action !== 'object' || action === null) return null
  const record = action as Record<string, unknown>
  if (record.type !== 'code-ide.submit') return null
  return record.entries ?? null
}

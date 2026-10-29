import type {
  HostExamModuleBackend,
  StudentSessionContext
} from '@shared/module-contract'
import { CODE_IDE_METADATA } from '../shared/module-metadata'
import {
  CodeExamPackageSchema,
  type CodeExamPackage,
  type StudentCodePackageView
} from '../shared/code-schema'
import { stripCodePackageForStudent } from '../shared/student-view'

/* ============================================================
 * Phase 8 — CodeIdeModuleBackend (stub)
 * Phase 8 ทำเฉพาะ UI + .ztcode file I/O; Runtime/Grader ตัวจริง
 * มาใน Phase 9 (External Runtime) และ Phase 10 (Hidden Grader)
 * Stub นี้ทำให้โมดูลเสียบเข้า ExamModuleRegistry ได้แล้วโดยไม่พัง core
 * ============================================================ */

export class CodeIdeModuleBackend
  implements HostExamModuleBackend<CodeExamPackage, StudentCodePackageView, unknown>
{
  readonly metadata = CODE_IDE_METADATA

  validatePackage(rawPackage: unknown): CodeExamPackage {
    return CodeExamPackageSchema.parse(rawPackage)
  }

  async initializeStudentSession(
    ctx: StudentSessionContext<CodeExamPackage>
  ): Promise<StudentCodePackageView> {
    void ctx
    return stripCodePackageForStudent(ctx.examPackage)
  }

  async handleStudentAction(): Promise<{ progressText: string; isFinished?: boolean }> {
    // Phase 10: autosave draft + ส่งงานจริง — ตอนนี้รับทราบเฉย ๆ
    return { progressText: 'รับงาน code-ide แล้ว (stub — รอ Phase 10 grader)', isFinished: false }
  }

  async handleAutosaveDraft(): Promise<void> {
    // Phase 10: เก็บ draft ลง SQLite — ตอนนี้นักเรียนมีไฟล์จริงในโฟลเดอร์ที่เลือกแล้ว
  }

  async finalizeStudentSession(): Promise<void> {
    // Phase 10: ปิด session + คิวตรวจ hidden tests
  }

  async exportResultsCsv(): Promise<Uint8Array> {
    // Phase 10: คะแนนจาก hidden grader — ตอนนี้ส่ง header เปล่า
    return new TextEncoder().encode('packageId,studentId,score,gradedAt\n')
  }
}

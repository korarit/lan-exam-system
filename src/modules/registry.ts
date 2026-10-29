import type { ExamModuleId, ExamModuleMetadata, RendererExamModuleUI } from '@shared/module-contract'
import type { HostExamModuleBackend } from '@shared/module-contract'

/* ============================================================
 * ExamModuleRegistry — ทะเบียนกลางของ Pluggable Exam Modules
 * ทุกโมดูลประกาศตัวเองที่นี่ (main และ renderer ใช้ metadata ตัวเดียวกัน)
 * ============================================================ */

export interface ExamModuleRegistration {
  readonly id: ExamModuleId
  readonly metadata: ExamModuleMetadata
  /** สร้าง Embedded Backend (ฝั่ง Main) */
  createBackend(): HostExamModuleBackend
  /** UI ฝั่ง Renderer (เผยแพร่แยกใน project ของ web — ไม่ import จากฝั่ง node) */
  rendererUi?: RendererExamModuleUI
}

const modules = new Map<ExamModuleId, ExamModuleRegistration>()

export function registerExamModule(registration: ExamModuleRegistration): void {
  modules.set(registration.id, registration)
}

export function getExamModule(id: ExamModuleId): ExamModuleRegistration | null {
  return modules.get(id) ?? null
}

export function listExamModules(): ExamModuleRegistration[] {
  return [...modules.values()]
}

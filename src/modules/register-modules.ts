import type { ExamModuleId } from '@shared/module-contract'
import { DynamicFormModuleBackend } from '@modules/dynamic-form/main/form-module-backend'
import { DYNAMIC_FORM_METADATA } from '@modules/dynamic-form/shared/module-metadata'
import { CodeIdeModuleBackend } from '@modules/code-ide/main/code-module-backend'
import { CODE_IDE_METADATA } from '@modules/code-ide/shared/module-metadata'
import { registerExamModule } from './registry'

/* ============================================================
 * ลงทะเบียนโมดูลในตัวทั้งหมด
 * - dynamic-form พร้อมใช้ตั้งแต่ Phase 6 (Backend + UI)
 * - code-ide ตั้งแต่ Phase 8 (UI + .ztcode) + Phase 9 (Runtime) +
 *   Phase 10 (Embedded Backend + Hidden Grader + Export)
 * หมายเหตุ: UI ฝั่ง Renderer อยู่ที่ src/modules/<module>/renderer/
 * (ห้าม import .tsx มาในโปรเจกต์ฝั่ง node — แยกชั้นกันตาม tsconfig)
 * ============================================================ */

registerExamModule({
  id: 'dynamic-form' satisfies ExamModuleId,
  metadata: DYNAMIC_FORM_METADATA,
  createBackend: () => new DynamicFormModuleBackend()
})

registerExamModule({
  id: 'code-ide' satisfies ExamModuleId,
  metadata: CODE_IDE_METADATA,
  createBackend: () => new CodeIdeModuleBackend()
})

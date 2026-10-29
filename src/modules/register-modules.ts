import type { ExamModuleId } from '@shared/module-contract'
import { DynamicFormModuleBackend, DYNAMIC_FORM_METADATA } from '@modules/dynamic-form/main/form-module-backend'
import { registerExamModule } from './registry'

/* ============================================================
 * ลงทะเบียนโมดูลในตัวทั้งหมด (dynamic-form พร้อมใช้ตั้งแต่ Phase 6)
 * หมายเหตุ: UI ฝั่ง Renderer อยู่ที่ src/modules/dynamic-form/renderer/
 * (ห้าม import .tsx มาในโปรเจกต์ฝั่ง node — แยกชั้นกันตาม tsconfig)
 * code-ide / external-url จะเพิ่มใน Phase 8+
 * ============================================================ */

registerExamModule({
  id: 'dynamic-form' satisfies ExamModuleId,
  metadata: DYNAMIC_FORM_METADATA,
  createBackend: () => new DynamicFormModuleBackend()
})

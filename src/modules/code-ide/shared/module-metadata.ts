import type { ExamModuleId, ExamModuleMetadata } from '@shared/module-contract'

/* เมตาดาต้าของโมดูล code-ide (Phase 8: UI + .ztcode — Runtime/Grader มา Phase 9/10) */

export const CODE_IDE_METADATA: ExamModuleMetadata = {
  moduleId: 'code-ide' as ExamModuleId,
  displayName: 'Code IDE (Project-Based)',
  description:
    'สอบเขียนโปรแกรมแบบโปรเจกต์หลายไฟล์/หลายโฟลเดอร์ (CLI / Frontend / Backend API / Database) พร้อมไลบรารีออฟไลน์ บันทึกเป็นไฟล์ .ztcode',
  version: '0.1.0',
  fileExtension: '.ztcode',
  supportedSecurityModes: ['closed', 'in-app-docs', 'external-tools']
}

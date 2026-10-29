import type { ExamModuleId, ExamModuleMetadata } from '@shared/module-contract'

/* เมตาดาต้าของโมดูล dynamic-form (ใช้ร่วมกันทั้งจากผู้ใช้ฝั่งหลักและ UI ฝั่งครู) */

export const DYNAMIC_FORM_METADATA: ExamModuleMetadata = {
  moduleId: 'dynamic-form' as ExamModuleId,
  displayName: 'Dynamic Form Builder',
  description:
    'ข้อสอบฟอร์มแบบสร้างเอง 12 ชนิด Input สลับลำดับรายคน บันทึกเป็นไฟล์ .ztform พร้อมเฉลยและรูปภาพ ตรวจอัตโนมัติทันที และส่งออกผลเป็น CSV/.ztresults',
  version: '1.0.0',
  fileExtension: '.ztform',
  supportedSecurityModes: ['closed', 'in-app-docs', 'external-tools']
}

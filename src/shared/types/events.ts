import { z } from 'zod'

/** ระดับความรุนแรงของเหตุการณ์ (ใช้ทั้ง audit log และ triage ใน Phase 3) */
export const SeveritySchema = z.enum(['normal', 'warning', 'critical'])
export type Severity = z.infer<typeof SeveritySchema>

/** ประเภทเหตุการณ์ที่ระบบตรวจจับรายงานได้ (ชุดเริ่มต้น Phase 0 — ขยายได้ใน Phase 3) */
export const AuditEventTypeSchema = z.enum([
  'role-selected',
  'app-launched',
  'kiosk-focus-lost',
  'kiosk-fullscreen-exit',
  'process-blacklisted',
  'network-unauthorized',
  'integrity-mismatch',
  'heartbeat-lost',
  'vm-detected',
  'synthetic-input',
  'screen-viewed'
])
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>

/** โครงเหตุการณ์ audit ที่ใช้ร่วมกันทั้งระบบ (ยังไม่ผูกกับ hash chain — Phase 3b) */
export interface AuditEvent {
  eventType: AuditEventType
  severity: Severity
  payloadJson: string
  occurredAtMs: number
}

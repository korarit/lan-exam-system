import { z } from 'zod'

/** โหมดการสอบที่ครูเลือกตอนสร้างห้อง (project-arc.md หัวข้อ 4) */
export const ExamModeSchema = z.enum(['closed', 'in-app-docs', 'external-tools'])
export type ExamMode = z.infer<typeof ExamModeSchema>

/** นโยบายการบังคับของห้อง: รายงานอย่างเดียว หรือบล็อกพร้อมรายงาน */
export const EnforcementModeSchema = z.enum(['report-only', 'block-and-report'])
export type EnforcementMode = z.infer<typeof EnforcementModeSchema>

/** สถานะของห้องสอบ (Phase 0 ยังไม่ใช้ แต่กำหนดโครงไว้ตั้งแต่ต้น) */
export const ExamSessionStatusSchema = z.enum(['lobby', 'running', 'frozen', 'ended'])
export type ExamSessionStatus = z.infer<typeof ExamSessionStatusSchema>

export interface ExamRoomSettings {
  roomId: string
  roomName: string
  mode: ExamMode
  enforcement: EnforcementMode
}

import { z } from 'zod'
import { SeveritySchema } from './types/events'
import type { Severity } from './types/events'

/* ============================================================
 * Phase 3b: Audit Hash Chain + Triage — ชนิดข้อมูลที่ใช้ร่วมกัน
 * (main: AuditLogger / TriageEngine, renderer: Dashboard)
 * ============================================================ */

export type TriageLevel = 'critical' | 'warning' | 'normal'

/** ผลการตรวจสอบของผู้คุมสอบต่อกลุ่มแจ้งเตือน */
export type AlertResolution = 'cleared' | 'confirmed'

export type AlertStatus = 'active' | 'cleared' | 'confirmed'

/** กลุ่มแจ้งเตือนหลังรวมเหตุการณ์ซ้ำ (EventCorrelator) */
export interface TriageAlertView {
  alertId: string
  studentId: string
  eventCode: string
  category: string
  severity: Severity
  /** คำอธิบายภาษาคนอ่านเข้าใจง่าย */
  summaryText: string
  /** คะแนนความน่าสงสัยที่ค้างอยู่ของกลุ่มนี้ */
  score: number
  occurrenceCount: number
  durationSeconds: number
  /** seqNo แรกใน audit chain ที่กลุ่มนี้เริ่มต้น */
  firstSeqNo: number
  lastSeenAtMs: number
  status: AlertStatus
}

export interface StudentTriageView {
  studentId: string
  activeSuspicionScore: number
  unacknowledgedCriticalCount: number
  unacknowledgedWarningCount: number
  triageLevel: TriageLevel
  disconnected: boolean
  frozen: boolean
  lastEventAtMs: number | null
  latestSummary: string | null
  alerts: TriageAlertView[]
}

export interface TriageCounts {
  total: number
  critical: number
  warning: number
  disconnected: number
  normal: number
}

/** push event 'host:triage-updated' + response ของ 'host:get-triage-overview' */
export interface TriageOverviewEvent {
  counts: TriageCounts
  students: StudentTriageView[]
  serverNowMs: number
}

/** ข้อมูลเครื่อง + สถานะที่ผู้คุมเห็นใน Evidence Timeline Drawer */
export interface StudentEvidenceInfo {
  studentId: string
  studentName: string
  online: boolean
  status: string
  focusState: string | null
  joinedAtMs: number | null
  lastSeenAtMs: number | null
  frozen: boolean
  vmSuspected: boolean
  remoteSuspected: boolean
}

export interface StudentEvidenceResponse {
  info: StudentEvidenceInfo | null
  entries: AuditEntryView[]
  chain: ChainVerification
}

export interface ResolveTriageResponse {
  ok: boolean
  affectedAlerts: number
}

/* ============================================================
 * Audit Log (Hash Chain)
 * ============================================================ */

export const AUDIT_HASH_PREFIX = 'ZTEXAM_AUDIT_V1'
export const AUDIT_HMAC_PREFIX = 'ZTEXAM_AUDIT_HMAC_V1'
export const GENESIS_PREV_HASH = '0'.repeat(64)

/** รหัสเหตุการณ์ที่เกิดจากการกดของผู้คุมสอบ (ลง chain เป็น studentId = 'HOST') */
export const PROCTOR_EVENT_CODES = {
  acknowledged: 'PROCTOR_ACKNOWLEDGED_ALERT',
  confirmed: 'PROCTOR_CONFIRMED_VIOLATION',
  warning: 'PROCTOR_WARNING_MESSAGE',
  froze: 'PROCTOR_FROZE_STUDENT',
  unfroze: 'PROCTOR_UNFROZE_STUDENT'
} as const

export const ROOM_CREATED_EVENT = 'ROOM_CREATED'
export const EXAM_ENDED_EVENT = 'EXAM_ENDED'
export const HOST_ANOMALY_EVENT = 'HOST_ANOMALY_DETECTED'

/** แถว audit log ที่อ่านกลับมาแสดงผล (payload แปลงเป็น object แล้ว) */
export interface AuditEntryView {
  seqNo: number
  roomId: string
  studentId: string
  serverTimestampMs: number
  clientTimestampMs: number | null
  eventCode: string
  category: string
  severity: Severity
  scoreDelta: number
  summaryText: string
  evidence: Record<string, unknown>
  prevHash: string
  entryHash: string
  hostHmac: string
}

export interface ChainVerification {
  valid: boolean
  totalEntries: number
  firstTamperedSeqNo?: number | undefined
  reason?: string | undefined
}

/* ---------- Zod schemas (ใช้ที่ขอบเขต IPC) ---------- */

export const TriageAlertViewSchema = z
  .object({
    alertId: z.string().min(1),
    studentId: z.string().min(1),
    eventCode: z.string().min(1),
    category: z.string(),
    severity: SeveritySchema,
    summaryText: z.string().max(400),
    score: z.number(),
    occurrenceCount: z.number().int().positive(),
    durationSeconds: z.number().nonnegative(),
    firstSeqNo: z.number().int().nonnegative(),
    lastSeenAtMs: z.number().int(),
    status: z.enum(['active', 'cleared', 'confirmed'])
  })
  .strict()

export const StudentTriageViewSchema = z
  .object({
    studentId: z.string().min(1),
    activeSuspicionScore: z.number(),
    unacknowledgedCriticalCount: z.number().int().nonnegative(),
    unacknowledgedWarningCount: z.number().int().nonnegative(),
    triageLevel: z.enum(['critical', 'warning', 'normal']),
    disconnected: z.boolean(),
    frozen: z.boolean(),
    lastEventAtMs: z.number().int().nullable(),
    latestSummary: z.string().max(400).nullable(),
    alerts: z.array(TriageAlertViewSchema)
  })
  .strict()

export const TriageCountsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    disconnected: z.number().int().nonnegative(),
    normal: z.number().int().nonnegative()
  })
  .strict()

export const TriageOverviewEventSchema = z
  .object({
    counts: TriageCountsSchema,
    students: z.array(StudentTriageViewSchema),
    serverNowMs: z.number().int()
  })
  .strict()

export const AuditEntryViewSchema = z
  .object({
    seqNo: z.number().int().nonnegative(),
    roomId: z.string(),
    studentId: z.string().min(1),
    serverTimestampMs: z.number().int(),
    clientTimestampMs: z.number().int().nullable(),
    eventCode: z.string().min(1),
    category: z.string(),
    severity: SeveritySchema,
    scoreDelta: z.number(),
    summaryText: z.string(),
    evidence: z.record(z.string(), z.unknown()),
    prevHash: z.string().length(64),
    entryHash: z.string().length(64),
    hostHmac: z.string()
  })
  .strict()

export const ChainVerificationSchema = z
  .object({
    valid: z.boolean(),
    totalEntries: z.number().int().nonnegative(),
    firstTamperedSeqNo: z.number().int().nonnegative().optional(),
    reason: z.string().max(200).optional()
  })
  .strict()

export const StudentEvidenceInfoSchema = z
  .object({
    studentId: z.string().min(1),
    studentName: z.string().min(1),
    online: z.boolean(),
    status: z.string(),
    focusState: z.string().nullable(),
    joinedAtMs: z.number().int().nullable(),
    lastSeenAtMs: z.number().int().nullable(),
    frozen: z.boolean(),
    vmSuspected: z.boolean(),
    remoteSuspected: z.boolean()
  })
  .strict()

export const StudentEvidenceResponseSchema = z
  .object({
    info: StudentEvidenceInfoSchema.nullable(),
    entries: z.array(AuditEntryViewSchema),
    chain: ChainVerificationSchema
  })
  .strict()

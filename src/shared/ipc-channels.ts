import { z } from 'zod'
import type { ZodType } from 'zod'
import { AppRoleSchema } from './types/role'
import { ExamModeSchema, EnforcementModeSchema } from './types/exam'
import {
  StudentConnectionStateSchema,
  UdpBeaconSchema,
  FocusStateSchema,
  type DiscoveredRoom,
  type HostStudentStatus,
  type StudentConnectionStatus
} from './protocol-schema'
import {
  ExamStartedPayloadSchema,
  ExamCompletedPayloadSchema,
  ExamTimeUpPayloadSchema,
  StateRecoveryPayloadSchema,
  SubmitAnswerPayloadSchema,
  SubmitRejectedPayloadSchema,
  AutoSaveDraftPayloadSchema,
  ClientQuestionPayloadSchema,
  type ExamStartedPayload,
  type ExamCompletedPayload,
  type StateRecoveryPayload,
  type SubmitRejectedPayload,
  type ClientQuestionPayload
} from './exam-schema'
import { DetectionEventSchema, type DetectionEvent } from './policy-schema'
export type { DetectionEvent } from './policy-schema'
import {
  ProctorWarningPayloadSchema,
  FreezeStatePayloadSchema
} from './protocol-schema'
import {
  TriageOverviewEventSchema,
  StudentEvidenceResponseSchema,
  type TriageOverviewEvent,
  type StudentEvidenceResponse,
  type ResolveTriageResponse
} from './triage'
export type {
  TriageLevel,
  AlertResolution,
  TriageAlertView,
  StudentTriageView,
  TriageCounts,
  TriageOverviewEvent,
  StudentEvidenceInfo,
  StudentEvidenceResponse,
  AuditEntryView,
  ChainVerification,
  ResolveTriageResponse
} from './triage'

/* ---------- Payload types ---------- */

export interface SelectRoleRequest {
  role: 'host' | 'student'
}
export interface SelectRoleResponse {
  ok: boolean
  role: 'host' | 'student'
}
export interface AppInfo {
  appVersion: string
  platform: string
  profileId: string
  role: 'unselected' | 'host' | 'student'
  isDev: boolean
}
export interface RoleChangedEvent {
  role: 'unselected' | 'host' | 'student'
}

/* ---------- Network payloads (Phase 1) ---------- */

export interface CreateRoomRequest {
  roomName: string
  mode: 'closed' | 'in-app-docs' | 'external-tools'
  enforcement: 'report-only' | 'block-and-report'
}
export interface HostRoomInfo {
  roomId: string
  roomName: string
  roomPin: string
  tcpPort: number
  certFingerprint: string
  certFpShort: string
  mode: 'closed' | 'in-app-docs' | 'external-tools'
}
export interface GetRoomResponse {
  room: HostRoomInfo | null
}
export interface JoinRoomRequest {
  hostIp: string
  hostPort: number
  roomId: string
  roomPin: string
  studentId: string
  studentName: string
}
export interface JoinRoomResponse {
  ok: boolean
  sessionToken?: string | undefined
  reason?: string | undefined
}
export interface RoomsUpdatedEvent {
  rooms: DiscoveredRoom[]
}
export interface StudentsUpdatedEvent {
  students: HostStudentStatus[]
}

/* ---------- Exam payloads (Phase 2) ---------- */

export interface LoadExamRequest {
  /** เนื้อหา JSON ของไฟล์ .ztexam.json ที่ฝั่ง renderer อ่านให้ main ผ่าน dialog */
  examJson: string
}
export interface LoadExamResponse {
  ok: boolean
  title: string
  questionCount: number
  durationSeconds: number
}
export interface ExamStartResponse {
  ok: boolean
}
export interface ExamTickEvent {
  remainingSeconds: number
}
export interface ExamFinishedEvent {
  reason: 'time-up' | 'ended-by-host' | 'completed'
}
export interface SelectExamFileResponse {
  ok: boolean
  /** ok=false เมื่อครูกดยกเลิก หรือแพ็กเกจไม่ผ่าน validation (มี message) */
  title: string
  questionCount: number
  durationSeconds: number
  message?: string | undefined
}
export interface HostExamStateEvent {
  state: 'idle' | 'running' | 'collecting' | 'finished'
  title: string | null
  questionCount: number
  examEndsAtMs: number
  serverNowMs: number
  room: string | null
}
export interface HostStudentSummary {
  studentId: string
  studentName: string
  answeredCount: number
  maxReachedCursor: number
  totalQuestions: number
  awardedPoints: number
  online: boolean
  finished: boolean
  finishReason?: string | undefined
}
export interface HostExamSummariesEvent {
  summaries: HostStudentSummary[]
}
export interface StudentSubmitResponse {
  ok: boolean
  reason?: string | undefined
}
export interface KioskEnterResponse {
  ok: boolean
}

/* ---------- Guard payloads (Phase 3a) ---------- */

/** renderer แจ้งว่าผู้สอบคัดลอกภายในแอปเอง (กัน false positive ของ clipboard guard) */
export interface InternalCopyRequest {
  text: string
}
/** renderer ส่งช่วงห่างระหว่างการกดปุ่ม (IKI ms) มาให้วิเคราะห์จังหวะการพิมพ์ */
export interface TypingMetricsRequest {
  intervalsMs: number[]
}
/** เครื่องแม่: เหตุการณ์ตรวจจับจากเครื่องนักเรียน */
export interface HostGuardEventsEvent {
  studentId: string
  events: DetectionEvent[]
}

/* ---------- Doc Preview & Domain Allowlist payloads (Phase 3a-plus) ---------- */

/** โดเมนที่ระบบ record จาก Doc Preview (ต่อห้องสอบ) */
export interface RecordedDomainItem {
  domain: string
  topDomain: string
  hits: number
  source: 'preview' | 'top-url'
  approved: boolean
  lastSeenAtMs: number
}
export interface RecordedDomainsUpdatedEvent {
  records: RecordedDomainItem[]
}
export interface OpenDocPreviewResponse {
  ok: boolean
  reason?: string | undefined
}
export interface ListRecordedDomainsResponse {
  records: RecordedDomainItem[]
}
export interface ApproveDomainRequest {
  /** hostname — ค่าพิเศษ '*' = อนุมัติ/ยกเลิกทั้งหมดที่รอตัดสิน */
  domain: string
  approved: boolean
}
export interface ApproveDomainResponse {
  ok: boolean
  reason?: string | undefined
  updatedCount?: number | undefined
}
export interface SetDomainEnforcementRequest {
  mode: 'warn' | 'block'
}
export interface OkResponse {
  ok: boolean
}

/* ---------- Audit & Triage payloads (Phase 3b) ---------- */

export interface StudentEvidenceRequest {
  studentId: string
}
export interface ResolveTriageRequest {
  studentId: string
  resolution: 'cleared' | 'confirmed'
  note?: string | undefined
}
export interface SendProctorWarningRequest {
  studentId: string
  message: string
}
export interface SetStudentFreezeRequest {
  studentId: string
  frozen: boolean
}
export interface ExportFileResponse {
  ok: boolean
  filePath?: string | undefined
  reason?: string | undefined
}
export interface StudentFreezeStateEvent {
  frozen: boolean
  reason?: string | undefined
}

/* ---------- Channel maps (single source of truth for IPC surface) ---------- */

/* ---------- Zod schemas สำหรับ payload ของ network channels ---------- */

const HostRoomInfoSchema = z
  .object({
    roomId: z.uuid(),
    roomName: z.string().max(80),
    roomPin: z.string().regex(/^\d{6}$/),
    tcpPort: z.number().int().min(1024).max(65535),
    certFingerprint: z.string().length(64),
    certFpShort: z.string().length(16),
    mode: ExamModeSchema
  })
  .strict()

const RecordedDomainItemSchema = z
  .object({
    domain: z.string().min(1).max(200),
    topDomain: z.string().min(1).max(200),
    hits: z.number().int().nonnegative(),
    source: z.enum(['preview', 'top-url']),
    approved: z.boolean(),
    lastSeenAtMs: z.number().int().nonnegative()
  })
  .strict()

const RecordedDomainsUpdatedEventSchema = z
  .object({ records: z.array(RecordedDomainItemSchema).max(2_048) })
  .strict()

const DiscoveredRoomIpcSchema = UdpBeaconSchema.extend({
  sourceIp: z.string().min(3).max(45),
  lastSeenAtMs: z.number().int()
})

const HostStudentStatusIpcSchema = z
  .object({
    studentId: z.string().min(1).max(40),
    studentName: z.string().min(1).max(80),
    online: z.boolean(),
    focusState: FocusStateSchema.nullable(),
    currentQuestionIndex: z.number().int().nullable(),
    lastSeenAtMs: z.number().int().nullable()
  })
  .strict()

/**
 * Renderer -> Main (ipcRenderer.invoke) request/response channels.
 * `void` request = ไม่มี payload
 */
export interface IpcInvokeMap {
  'app:select-role': { req: SelectRoleRequest; res: SelectRoleResponse }
  'app:get-app-info': { req: void; res: AppInfo }
  'host:create-room': { req: CreateRoomRequest; res: HostRoomInfo }
  'host:close-room': { req: void; res: SelectRoleResponse }
  'host:get-room': { req: void; res: GetRoomResponse }
  'host:load-exam': { req: LoadExamRequest; res: LoadExamResponse }
  'host:select-exam-file': { req: void; res: SelectExamFileResponse }
  'host:start-exam': { req: void; res: ExamStartResponse }
  'host:end-exam': { req: void; res: ExamStartResponse }
  'student:start-discovery': { req: void; res: SelectRoleResponse }
  'student:stop-discovery': { req: void; res: SelectRoleResponse }
  'student:join-room': { req: JoinRoomRequest; res: JoinRoomResponse }
  'student:leave-room': { req: void; res: SelectRoleResponse }
  'student:submit-answer': {
    req: z.infer<typeof SubmitAnswerPayloadSchema>
    res: StudentSubmitResponse
  }
  'student:autosave-draft': {
    req: z.infer<typeof AutoSaveDraftPayloadSchema>
    res: StudentSubmitResponse
  }
  'student:navigate': {
    req: { cursorIndex: number }
    res: StudentSubmitResponse
  }
  'student:enter-kiosk': { req: void; res: KioskEnterResponse }
  'student:internal-copy': { req: InternalCopyRequest; res: StudentSubmitResponse }
  'student:typing-metrics': { req: TypingMetricsRequest; res: StudentSubmitResponse }
  'host:open-doc-preview': { req: { url: string }; res: OpenDocPreviewResponse }
  'host:close-doc-preview': { req: void; res: OkResponse }
  'host:list-recorded-domains': { req: void; res: ListRecordedDomainsResponse }
  'host:approve-domain': { req: ApproveDomainRequest; res: ApproveDomainResponse }
  'host:set-domain-enforcement': { req: SetDomainEnforcementRequest; res: OkResponse }
  'host:get-triage-overview': { req: void; res: TriageOverviewEvent }
  'host:get-student-evidence': { req: StudentEvidenceRequest; res: StudentEvidenceResponse }
  'host:resolve-triage': { req: ResolveTriageRequest; res: ResolveTriageResponse }
  'host:send-proctor-warning': { req: SendProctorWarningRequest; res: OkResponse }
  'host:set-student-freeze': { req: SetStudentFreezeRequest; res: OkResponse }
  'host:export-incident-report': { req: void; res: ExportFileResponse }
  'host:export-audit-bundle': { req: void; res: ExportFileResponse }
}

/** Main -> Renderer (webContents.send) push event channels */
export interface IpcEventMap {
  'app:role-changed': RoleChangedEvent
  'network:rooms-updated': RoomsUpdatedEvent
  'network:connection-state': StudentConnectionStatus
  'host:students-updated': StudentsUpdatedEvent
  'host:exam-state-changed': HostExamStateEvent
  'host:exam-summaries': HostExamSummariesEvent
  'host:exam-completed': ExamFinishedEvent
  'exam:started': ExamStartedPayload
  'exam:question': ClientQuestionPayload
  'exam:recovery': StateRecoveryPayload
  'exam:submit-rejected': SubmitRejectedPayload
  'exam:time-up': Record<string, never>
  'exam:completed': ExamCompletedPayload
  'exam:tick': ExamTickEvent
  'host:guard-events': HostGuardEventsEvent
  'host:recorded-domains-updated': RecordedDomainsUpdatedEvent
  'host:triage-updated': TriageOverviewEvent
  'exam:proctor-warning': { message: string; sentAtMs: number }
  'exam:freeze-state': StudentFreezeStateEvent
}

export type IpcInvokeChannel = keyof IpcInvokeMap
export type IpcEventChannel = keyof IpcEventMap

/* ---------- Envelope กลางของผลลัพธ์ IPC (Main -> Renderer) ---------- */

export interface IpcErrorDetail {
  code: 'VALIDATION' | 'HANDLER' | 'RESPONSE' | 'UNTRUSTED_FRAME'
  message: string
}
export interface IpcResult<T> {
  ok: boolean
  data?: T
  error?: IpcErrorDetail
}

/* ---------- Zod schemas (validated at the Main-process boundary) ---------- */

export const IpcInvokeSchemas: {
  [K in IpcInvokeChannel]: { request: ZodType<IpcInvokeMap[K]['req']>; response: ZodType<IpcInvokeMap[K]['res']> }
} = {
  'app:select-role': {
    request: z.object({ role: z.union([z.literal('host'), z.literal('student')]) }).strict(),
    response: z
      .object({ ok: z.boolean(), role: z.union([z.literal('host'), z.literal('student')]) })
      .strict()
  },
  'app:get-app-info': {
    request: z.void(),
    response: z
      .object({
        appVersion: z.string(),
        platform: z.string(),
        profileId: z.string().min(1),
        role: AppRoleSchema,
        isDev: z.boolean()
      })
      .strict()
  },
  'host:create-room': {
    request: z
      .object({
        roomName: z.string().min(1).max(80),
        mode: ExamModeSchema,
        enforcement: EnforcementModeSchema
      })
      .strict(),
    response: HostRoomInfoSchema
  },
  'host:close-room': {
    request: z.void(),
    response: z.object({ ok: z.boolean(), role: z.union([z.literal('host'), z.literal('student')]) }).strict()
  },
  'host:get-room': {
    request: z.void(),
    response: z
      .object({ room: HostRoomInfoSchema.nullable() })
      .strict()
  },
  'student:start-discovery': {
    request: z.void(),
    response: z.object({ ok: z.boolean(), role: z.union([z.literal('host'), z.literal('student')]) }).strict()
  },
  'student:stop-discovery': {
    request: z.void(),
    response: z.object({ ok: z.boolean(), role: z.union([z.literal('host'), z.literal('student')]) }).strict()
  },
  'student:join-room': {
    request: z
      .object({
        hostIp: z.string().min(3).max(45),
        hostPort: z.number().int().min(1024).max(65535),
        roomId: z.uuid(),
        roomPin: z.string().regex(/^\d{6}$/),
        studentId: z.string().min(1).max(40),
        studentName: z.string().min(1).max(80)
      })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        sessionToken: z.string().optional(),
        reason: z.string().max(120).optional()
      })
      .strict()
  },
  'student:leave-room': {
    request: z.void(),
    response: z.object({ ok: z.boolean(), role: z.union([z.literal('host'), z.literal('student')]) }).strict()
  },
  'host:load-exam': {
    request: z.object({ examJson: z.string().min(2).max(1024 * 512) }).strict(),
    response: z
      .object({
        ok: z.boolean(),
        title: z.string().max(120),
        questionCount: z.number().int().nonnegative(),
        durationSeconds: z.number().int().nonnegative()
      })
      .strict()
  },
  'host:select-exam-file': {
    request: z.void(),
    response: z
      .object({
        ok: z.boolean(),
        title: z.string().max(120),
        questionCount: z.number().int().nonnegative(),
        durationSeconds: z.number().int().nonnegative(),
        message: z.string().max(200).optional()
      })
      .strict()
  },
  'host:start-exam': {
    request: z.void(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'host:end-exam': {
    request: z.void(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'student:submit-answer': {
    request: SubmitAnswerPayloadSchema,
    response: z
      .object({ ok: z.boolean(), reason: z.string().max(60).optional() })
      .strict()
  },
  'student:autosave-draft': {
    request: AutoSaveDraftPayloadSchema,
    response: z
      .object({ ok: z.boolean(), reason: z.string().max(60).optional() })
      .strict()
  },
  'student:navigate': {
    request: z.object({ cursorIndex: z.number().int().nonnegative() }).strict(),
    response: z
      .object({ ok: z.boolean(), reason: z.string().max(60).optional() })
      .strict()
  },
  'student:enter-kiosk': {
    request: z.void(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'student:internal-copy': {
    request: z.object({ text: z.string().min(1).max(10_000) }).strict(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'student:typing-metrics': {
    request: z
      .object({ intervalsMs: z.array(z.number().int().min(0).max(10_000)).min(1).max(500) })
      .strict(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'host:open-doc-preview': {
    request: z.object({ url: z.string().min(5).max(2_048) }).strict(),
    response: z
      .object({ ok: z.boolean(), reason: z.string().max(60).optional() })
      .strict()
  },
  'host:close-doc-preview': {
    request: z.void(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'host:list-recorded-domains': {
    request: z.void(),
    response: z.object({ records: z.array(RecordedDomainItemSchema).max(2_048) }).strict()
  },
  'host:approve-domain': {
    request: z
      .object({ domain: z.string().min(1).max(200), approved: z.boolean() })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        reason: z.string().max(60).optional(),
        updatedCount: z.number().int().nonnegative().optional()
      })
      .strict()
  },
  'host:set-domain-enforcement': {
    request: z.object({ mode: z.enum(['warn', 'block']) }).strict(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'host:get-triage-overview': {
    request: z.void(),
    response: TriageOverviewEventSchema
  },
  'host:get-student-evidence': {
    request: z.object({ studentId: z.string().min(1).max(40) }).strict(),
    response: StudentEvidenceResponseSchema
  },
  'host:resolve-triage': {
    request: z
      .object({
        studentId: z.string().min(1).max(40),
        resolution: z.enum(['cleared', 'confirmed']),
        note: z.string().max(500).optional()
      })
      .strict(),
    response: z.object({ ok: z.boolean(), affectedAlerts: z.number().int().nonnegative() }).strict()
  },
  'host:send-proctor-warning': {
    request: z
      .object({ studentId: z.string().min(1).max(40), message: z.string().min(1).max(300) })
      .strict(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'host:set-student-freeze': {
    request: z
      .object({ studentId: z.string().min(1).max(40), frozen: z.boolean() })
      .strict(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'host:export-incident-report': {
    request: z.void(),
    response: z
      .object({
        ok: z.boolean(),
        filePath: z.string().max(1_000).optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'host:export-audit-bundle': {
    request: z.void(),
    response: z
      .object({
        ok: z.boolean(),
        filePath: z.string().max(1_000).optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  }
}

export const IpcEventSchemas: {
  [K in IpcEventChannel]: ZodType<IpcEventMap[K]>
} = {
  'app:role-changed': z.object({ role: AppRoleSchema }).strict(),
  'network:rooms-updated': z.object({ rooms: z.array(DiscoveredRoomIpcSchema) }).strict(),
  'network:connection-state': z
    .object({
      state: StudentConnectionStateSchema,
      reason: z.string().max(200).optional(),
      sessionToken: z.string().max(64).optional()
    })
    .strict(),
  'host:students-updated': z.object({ students: z.array(HostStudentStatusIpcSchema) }).strict(),
  'host:exam-state-changed': z
    .object({
      state: z.enum(['idle', 'running', 'collecting', 'finished']),
      title: z.string().nullable(),
      questionCount: z.number().int().nonnegative(),
      examEndsAtMs: z.number().int(),
      serverNowMs: z.number().int(),
      room: z.string().max(80).nullable()
    })
    .strict(),
  'host:exam-completed': z
    .object({ reason: z.enum(['time-up', 'ended-by-host', 'completed']) })
    .strict(),
  'host:exam-summaries': z
    .object({
      summaries: z.array(
        z
          .object({
            studentId: z.string().min(1),
            studentName: z.string().min(1),
            answeredCount: z.number().int().nonnegative(),
            maxReachedCursor: z.number().int().nonnegative(),
            totalQuestions: z.number().int().nonnegative(),
            awardedPoints: z.number().nonnegative(),
            online: z.boolean(),
            finished: z.boolean(),
            finishReason: z.string().max(20).optional()
          })
          .strict()
      )
    })
    .strict(),
  'exam:started': ExamStartedPayloadSchema,
  'exam:question': ClientQuestionPayloadSchema,
  'exam:recovery': StateRecoveryPayloadSchema,
  'exam:submit-rejected': SubmitRejectedPayloadSchema,
  'exam:time-up': ExamTimeUpPayloadSchema,
  'exam:completed': ExamCompletedPayloadSchema,
  'exam:tick': z.object({ remainingSeconds: z.number().int().nonnegative() }).strict(),
  'host:guard-events': z
    .object({
      studentId: z.string().min(1).max(40),
      events: z.array(DetectionEventSchema).min(1).max(20)
    })
    .strict(),
  'host:recorded-domains-updated': RecordedDomainsUpdatedEventSchema,
  'host:triage-updated': TriageOverviewEventSchema,
  'exam:proctor-warning': ProctorWarningPayloadSchema,
  'exam:freeze-state': FreezeStatePayloadSchema
}

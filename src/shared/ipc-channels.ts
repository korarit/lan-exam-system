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
import { EnrolledDeviceViewSchema, type EnrolledDeviceView } from './device-roster-schema'
export type { EnrolledDeviceView } from './device-roster-schema'
import {
  ProctorWarningPayloadSchema,
  FreezeStatePayloadSchema
} from './protocol-schema'
import {
  RingSegmentMetaSchema,
  type RingSegmentMeta
} from './screen-protocol'
export type { RingSegmentMeta } from './screen-protocol'
import type { FormResponsesSnapshot } from '@modules/dynamic-form/shared/form-responses-view'
export type { FormResponsesSnapshot } from '@modules/dynamic-form/shared/form-responses-view'
import {
  VirtualEntrySchema,
  CliTestCaseSchema,
  SqlTestCaseSchema,
  SupportedCodeLanguageSchema,
  DependencyBundleSchema
} from '@modules/code-ide/shared/code-schema'
import {
  TriageOverviewEventSchema,
  StudentEvidenceResponseSchema,
  type TriageOverviewEvent,
  type StudentEvidenceResponse,
  type ResolveTriageResponse
} from './triage'
import {
  GatewayStartRequestSchema,
  GatewayStatusSchema,
  GatewayInterfacesResponseSchema,
  GatewayLeasesResponseSchema,
  GatewayDnsLogResponseSchema,
  GatewayDnsLogEntrySchema,
  type GatewayStartRequest,
  type GatewayStatus,
  type GatewayInterfaceInfo,
  type GatewayLease,
  type GatewayDnsLogEntry
} from './gateway'
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
  /** จำนวนนักเรียนสูงสุดที่ห้องนี้รับ (1-1000) */
  maxStudents: number
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
  reason?: string | undefined
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

/* ---------- Attestation payloads (Phase 4) ---------- */

export interface AttestationTrackedStudent {
  studentId: string
  manifestHash: string | null
  signed: boolean
}
export interface AttestationConfigResponse {
  devMode: boolean
  signatureEnforced: boolean
  platform: string
  trackedStudents: AttestationTrackedStudent[]
}

/* ---------- TOFU device enrollment (auto-accept ตอน join) ---------- */

export interface ListEnrolledDevicesResponse {
  devices: EnrolledDeviceView[]
}
export interface SetEnrolledDeviceStatusRequest {
  deviceId: string
  status: 'active' | 'blocked'
}

/* ---------- Screen Monitoring payloads (Phase 3c) ---------- */

export interface ScreenSourceInfo {
  sourceId: string
  displayId: string
  displayIndex: number
  displayCount: number
  label: string
  width: number
  height: number
}
export interface ScreenEnvironmentStatus {
  ok: boolean
  platform: string
  permission: 'granted' | 'denied' | 'unknown-session'
  reason?: string | undefined
}
export interface StudentScreenSourcesResponse {
  environment: ScreenEnvironmentStatus
  sources: ScreenSourceInfo[]
}
/** renderer นักเรียนส่งเซกเมนต์ .webm (ยังไม่เข้ารหัส) ให้ main เข้ารหัส + เก็บ ring buffer */
export interface StudentScreenSegmentRequest {
  displayId: string
  seqNo: number
  startTimeMs: number
  endTimeMs: number
  data: Uint8Array
}
/** renderer นักเรียนส่งภาพย่อ/ภาพสด 1 เฟรมให้ main ส่งต่อเป็น binary frame */
export interface StudentScreenThumbnailRequest {
  displayIndex: number
  displayCount: number
  mode: 'thumbnail' | 'live'
  mimeType: string
  timestampMs: number
  displayId: string
  data: Uint8Array
}
export interface HostScreenInspectRequest {
  studentId: string
  mode: 'live' | 'playback' | 'stop'
  displayId?: string | undefined
}
export interface HostFetchSegmentRequest {
  studentId: string
  segmentId: string
}
export interface HostPinScreenRequest {
  studentId: string
  reason?: string | undefined
}
export interface HostScreenThumbnailEvent {
  studentId: string
  displayIndex: number
  displayCount: number
  mode: 'thumbnail' | 'live'
  mimeType: string
  imageBase64: string
  timestampMs: number
  displayId: string
}
export interface HostScreenSegmentsEvent {
  studentId: string
  displayId: string
  segments: RingSegmentMeta[]
}
export interface HostScreenSegmentDataEvent {
  studentId: string
  segmentId: string
  displayId: string
  mimeType: string
  dataBase64: string
}
/** เซกเมนต์ที่สตรีมสดมาทาง UDP ระหว่างโหมดดู — meta + ข้อมูล .webm พร้อมกัน */
export interface HostScreenLiveSegmentEvent {
  studentId: string
  segmentId: string
  displayId: string
  mimeType: string
  dataBase64: string
  seqNo: number
  startTimeMs: number
  endTimeMs: number
}
/** ฝั่ง renderer นักเรียน: บอกให้เริ่ม/หยุด screen worker และโหมด live */
export interface StudentScreenSessionEvent {
  active: boolean
  /** ช่วงเวลาสุ่มขั้นต่ำระหว่างภาพย่อ (ms) */
  thumbnailMinIntervalMs?: number | undefined
  /** ช่วงเวลาสุ่มสูงสุดระหว่างภาพย่อ (ms) */
  thumbnailMaxIntervalMs?: number | undefined
  reason?: string | undefined
}
export interface StudentScreenInspectEvent {
  requestId: string
  mode: 'live' | 'playback' | 'stop'
  displayId?: string | undefined
  /** ช่องทางส่งภาพสด (udp-segments = วิดีโอ 720p/30fps, jpeg-fallback = ย้อนไปภาพย่อ 5 fps ทาง TLS) */
  transport?: 'udp-segments' | 'jpeg-fallback' | undefined
}

/* ---------- Mode 2 / Mode 3 (Phase 5) ---------- */

/** สถานะแผงเอกสารที่ main push ไป renderer (ขณะเปิด/ปิด/บล็อกลิงก์) */
export interface DocsPanelState {
  open: boolean
  url: string | null
  /** โดเมนอนุญาตจาก Signed Policy (default-deny) */
  allowedDomains: string[]
  enforcement: 'warn' | 'block'
  /** ลิงก์สุดท้ายที่ถูกบล็อก (แสดงป้ายเตือนในแผง) */
  blockedUrl: string | null
  /** R4: URL นอกรายการที่กำลังเปิดในโหมด warn (ตรวจจับอย่างเดียว — แบนเนอร์เหลือง) */
  warnUrl: string | null
  /** R8: ข้อผิดพลาดการสร้าง/วาง WebContentsView (null = ปกติ) */
  viewError: string | null
}
export interface DocsToggleRequest {
  open: boolean
}
export interface DocsNavigateRequest {
  url: string
}
export interface OpenVsCodeResponse {
  ok: boolean
  reason?: string | undefined
}

/* ---------- Dynamic Form — .ztform Save/Load (Phase 6) ---------- */

export interface SaveZtformRequest {
  /** JSON ของ { form + assets } ที่ renderer ประกอบ (ตรวจด้วย Zod ฝั่ง main) */
  formPayloadJson: string
  encrypted: boolean
  password?: string | undefined
}
export interface SaveZtformResponse {
  ok: boolean
  filePath?: string | undefined
  reason?: string | undefined
}
export interface LoadZtformRequest {
  password?: string | undefined
}
export interface SavedFormRecord {
  formId: string
  title: string
  filePath: string
  totalQuestions: number
  totalPoints: number
  encrypted: boolean
  savedAtMs: number
}
export interface LoadZtformResponse {
  ok: boolean
  filePath?: string | undefined
  /** ต้องมีรหัสผ่าน (ไฟล์ถูกเข้ารหัส) — UI ต้องถามรหัสผ่านแล้วเรียกใหม่ */
  needPassword?: boolean | undefined
  manifest?: ZtformManifestSummary | undefined
  formPayloadJson?: string | undefined
  message?: string | undefined
}
export interface ZtformManifestSummary {
  formId: string
  title: string
  totalQuestions: number
  totalPoints: number
}
export interface ListSavedFormsResponse {
  forms: SavedFormRecord[]
}

/* ---------- Dynamic Form — Responses / Grading / Export (Phase 7) ---------- */

export interface FormZtformStateResponse {
  ok: boolean
  /** ห้องที่ระบุว่ารายการฟอร์มแนบอยู่ (roomId ณ รอบเปิด) */
  roomId: string | null
  roomName: string | null
  formTitle: string | null
  hasResponses: boolean
  message?: string | undefined
}
export interface FormSaveResultsRequest {
  encrypted: boolean
  password?: string | undefined
}
export interface FormAttachRoomFormRequest {
  formPayloadJson: string
}
export interface FormAttachRoomFormResponse {
  ok: boolean
  roomId?: string | undefined
  formTitle?: string | undefined
  reason?: string | undefined
}
export interface FormManualGradeRequest {
  studentId: string
  itemId: string
  /** null = ล้างคะแนนที่ครูให้แล้ว (กลับไปใช้อัตโนมัติ) */
  points: number | null
}
export interface FormManualGradeResponse {
  ok: boolean
  reason?: string | undefined
}
export interface FormRegradeResponse {
  ok: boolean
  students?: number | undefined
  changedItems?: number | undefined
  totalDeltaPoints?: number | undefined
  reason?: string | undefined
}
export interface FormExportFileResponse {
  ok: boolean
  filePath?: string | undefined
  reason?: string | undefined
}
export interface FormZtresultsManifestSummary {
  formId: string
  formTitle: string
  roomId: string
  roomName: string
  createdAtMs: number
  studentCount: number
}
export interface FormLoadZtresultsResponse {
  ok: boolean
  needPassword?: boolean | undefined
  manifest?: FormZtresultsManifestSummary | undefined
  message?: string | undefined
}

/* ---------- Module Packet Transport — Student → Host ผ่าน LAN (Phase 2 สเปค/เพิ่งมีโค้ด) ---------- */

/** นักเรียนส่ง action/autosave ของโมดูลผ่านสาย TLS (main หั่น chunks ให้เอง) */
export interface StudentModuleSendRequest {
  moduleId: 'dynamic-form' | 'code-ide' | 'external-url'
  kind: 'action' | 'autosave'
  payloadJson: string
}
export interface StudentModuleSendResponse {
  ok: boolean
  chunked?: boolean | undefined
  chunks?: number | undefined
  reason?: string | undefined
}
/** Host ตอบรับงานของโมดูล (ต่อชิ้น) */
export interface ModuleAckEvent {
  moduleId: 'dynamic-form' | 'code-ide' | 'external-url'
  kind: 'action' | 'autosave'
  ok: boolean
  progressText?: string | undefined
  reason?: string | undefined
}
/** Host ผลัก state เริ่มต้นของโมดูลรายคน (stripped view) */
export interface ModuleStateEvent {
  moduleId: 'dynamic-form' | 'code-ide' | 'external-url'
  stateJson: string
}

/* ---------- Code IDE — Local Runtime (Phase 9: รันบนเครื่องตัวเองผ่าน Main) ---------- */

/** รัน 1 CLI test ด้วยโค้ดปัจจุบันของนักเรียน (entries สดจาก IDE) */
export interface CodeIdeRunCliRequest {
  language: string
  entryPointPath: string
  entries: Array<{
    path: string
    kind: 'file' | 'folder'
    content?: string | undefined
    encoding?: 'utf8' | 'base64' | undefined
    readOnly?: boolean | undefined
    allowStudentCreateInside?: boolean | undefined
    hiddenFromStudent?: boolean | undefined
  }>
  test: {
    testId: string
    kind: 'stdio' | 'unit-harness'
    title: string
    stdin?: string | undefined
    expectedStdout?: string | undefined
    inputs?: Array<{ name: string; type: 'string' | 'int' | 'float' | 'bool'; value: string }> | undefined
    harnessTarget?: string | undefined
    visibility: 'sample' | 'hidden'
    points: number
    timeoutMs?: number | undefined
  }
  /** F-3: ใช้ offline libs ที่แคชจาก DependencyBundle ของโจทย์ข้อนี้ (ถ้าเครื่องนักเรียนแคชไว้แล้ว) */
  packageId?: string | undefined
}
export interface CodeIdeRunCliResponse {
  testId: string
  passed: boolean | null
  actualStdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  blockedReason?: string | undefined
  note: string
}
/**
 * F-3: เครื่องนักเรียนแคช DependencyBundle blobs ที่มากับ stripped view
 * ลง deps cache ฝั่งตัวเอง — รัน sample ด้วย lib จริงได้ออฟไลน์
 */
export interface CodeIdeCacheStudentBundlesRequest {
  packageId: string
  dependencies: Array<{
    bundleId: string
    ecosystem: 'npm' | 'pip' | 'maven-jar' | 'c-cpp-headers-libs' | 'cargo-vendor' | 'go-vendor' | 'composer-vendor' | 'frontend-vendor'
    packages: Array<{ name: string; version: string }>
    archiveRelativePath: string
  }>
  blobs: Array<{ archivePath: string; dataBase64: string; sha256: string }>
}
export interface CodeIdeCacheStudentBundlesResponse {
  ok: boolean
  cached: boolean
  unsupported: string[]
  reason?: string | undefined
}
/** F-3b: สถานะ deps ที่เครื่องนักเรียนมี (แคช blob / ติดตั้งเอง) */
export interface CodeIdeStudentDepsStatusRequest {
  packageId: string
}
export interface CodeIdeStudentDepsStatusResponse {
  cached: boolean
}
/** F-3b: เครื่องนักเรียน pip/npm install เอง (ครู opt-in + รายชื่อ exact ที่ครูอนุมัติ) */
export interface CodeIdeInstallStudentDepsRequest {
  packageId: string
  packages: Array<{
    ecosystem: 'npm' | 'pip'
    name: string
    version: string
  }>
}
export interface CodeIdeInstallStudentDepsResponse {
  ok: boolean
  installed: string[]
  note: string
  reason?: string | undefined
}
/** รัน 1 SQL test ด้วย query ปัจจุบันของนักเรียนบน SQLite ephemeral */
export interface CodeIdeRunSqlRequest {
  seedSql: string
  studentSql: string
  test: {
    testId: string
    kind: 'sql-query'
    title: string
    setupSqlOverride?: string | undefined
    verificationQuery?: string | undefined
    expectedColumns: string[]
    expectedRows: Array<Array<string | number | null>>
    checkColumnOrder?: boolean | undefined
    checkRowOrder?: boolean | undefined
    visibility: 'sample' | 'hidden'
    points: number
    timeoutMs?: number | undefined
  }
}
export interface CodeIdeRunSqlResponse {
  testId: string
  passed: boolean | null
  actualColumns: string[]
  actualRows: Array<Array<string | number | null>>
  note: string
}
/** เช็คว่า runtime ของภาษาที่ใช้มีในเครื่องไหม (ไม่ดาวน์โหลดแยก — ให้ผู้ใช้ติดตั้งเอง) */
export interface CodeIdeCheckRuntimesRequest {
  languages: string[]
}
export interface CodeIdeRuntimeStatus {
  name: string
  found: boolean
  version?: string | undefined
  path?: string | undefined
  /** โฟลเดอร์ SDK ที่ผู้ใช้ Browse เลือกเอง (ถ้ามี) */
  customPath?: string | undefined
  hint: string
}
export interface CodeIdeCheckRuntimesResponse {
  runtimes: CodeIdeRuntimeStatus[]
}
/** เปิด dialog เลือกโฟลเดอร์ SDK ที่ติดตั้งเอง */
export interface CodeIdeBrowseSdkPathRequest {
  title?: string | undefined
}
export interface CodeIdeBrowseSdkPathResponse {
  ok: boolean
  dirPath?: string | undefined
  reason?: string | undefined
}
/** ลงทะเบียนโฟลเดอร์ SDK + ตรวจว่ามี binary ของ runtime นั้นจริง */
export interface CodeIdeAddSdkPathRequest {
  runtime: string
  dirPath: string
}
export interface CodeIdeAddSdkPathResponse {
  ok: boolean
  version?: string | undefined
  reason?: string | undefined
}

/* ---------- Code IDE — Backend / Grader / Export (Phase 10: งาน + คิวตรวจ + ส่งออก) ---------- */

/** นักเรียนส่งโปรเจกต์ทั้งชุด (entries สดจาก IDE) — host แยก room จากห้องที่เปิดอยู่ */
export interface CodeIdeSubmitProjectRequest {
  studentId: string
  entries: Array<{
    path: string
    kind: 'file' | 'folder'
    content?: string | undefined
    encoding?: 'utf8' | 'base64' | undefined
    readOnly?: boolean | undefined
    allowStudentCreateInside?: boolean | undefined
    hiddenFromStudent?: boolean | undefined
  }>
}
export interface CodeIdeSubmitProjectResponse {
  ok: boolean
  fileCount?: number | undefined
  projectBytes?: number | undefined
  reason?: string | undefined
}
/** ครูผูก .ztcode package (JSON จาก Builder) เข้ากับห้องที่เปิดอยู่ */
export interface CodeIdeAttachPackageRequest {
  packageJson: string
}
export interface CodeIdeAttachPackageResponse {
  ok: boolean
  roomId?: string | undefined
  packageTitle?: string | undefined
  reason?: string | undefined
}
/** สรุปงานรายคนสำหรับตารางคะแนน (ไม่มีโค้ดนักเรียน — เปิด entries แยกรายคน) */
export interface CodeIdeSubmissionSummary {
  studentId: string
  fileCount: number
  passedCount: number
  totalCount: number
  autoPoints: number
  manualPoints: number | null
  totalPoints: number
  maxPoints: number
  status: 'queued' | 'grading' | 'graded' | 'blocked' | 'error'
  submittedAtMs: number | null
  gradedAtMs: number | null
  blockedReason: string | null
}
export interface CodeIdeSubmissionsResponse {
  ok: boolean
  roomId: string | null
  roomName: string | null
  packageTitle: string | null
  category: string | null
  language: string | null
  questionSlug: string | null
  maxPoints: number
  queue: { active: number; pending: number }
  /** archive ของ offline libs ที่ใช้ไม่ได้ (ครูต้องอัปโหลดเป็น .zip/.jar ใหม่) */
  depsUnsupported: string[]
  submissions: CodeIdeSubmissionSummary[]
  reason?: string | undefined
}
/** ผลตรวจราย test case (เปิดเผย sample + hidden — ฝั่งครูเท่านั้น) */
export interface CodeIdeGradeResultView {
  testId: string
  kind: string
  visibility: 'sample' | 'hidden'
  points: number
  earned: number
  passed: boolean | null
  note: string
  durationMs: number
}
/** รายละเอียดงานรายคนสำหรับ Mirror IDE Inspector */
export interface CodeIdeSubmissionDetailResponse {
  ok: boolean
  studentId?: string | undefined
  status?: string | undefined
  manualPoints?: number | null | undefined
  entries?: CodeIdeSubmitProjectRequest['entries'] | undefined
  /** starter ที่นักเรียนเห็นตอนเริ่ม (เทียบจุดตั้งต้นใน Playback) */
  starterEntries?: CodeIdeSubmitProjectRequest['entries'] | undefined
  /** autosave ล่าสุด (อาจใหม่กว่าฉบับที่ส่ง) */
  draftEntries?: CodeIdeSubmitProjectRequest['entries'] | undefined
  referenceEntries?: CodeIdeSubmitProjectRequest['entries'] | undefined
  gradeResults?: CodeIdeGradeResultView[] | undefined
  blockedReason?: string | null | undefined
  reason?: string | undefined
}
export interface CodeIdeManualGradeRequest {
  studentId: string
  points: number | null
}
export interface CodeIdeManualGradeResponse {
  ok: boolean
  reason?: string | undefined
}
export interface CodeIdeRegradeResponse {
  ok: boolean
  students?: number | undefined
  graded?: number | undefined
  reason?: string | undefined
}
export interface CodeIdeWorkspaceStateResponse {
  rootPath: string | null
  workspaceOk: boolean
  workspaceReason?: string | undefined
  queue: { active: number; pending: number }
}
export interface CodeIdeSetWorkspaceResponse {
  ok: boolean
  rootPath?: string | undefined
  reason?: string | undefined
}
/** Live Preview งาน frontend ของนักเรียน (bundle แล้ว — รันใน sandboxed iframe + CSP) */
export interface CodeIdeRunPreviewResponse {
  ok: boolean
  html?: string | undefined
  js?: string | undefined
  reason?: string | undefined
}
/** ครูยิง API ทดสอบเซิร์ฟเวอร์นักเรียน 1 request (spawn ชั่วคราวแล้ว teardown) */
export interface CodeIdeProbeApiRequest {
  studentId: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  bodyJson?: string | undefined
}
export interface CodeIdeProbeApiResponse {
  ok: boolean
  status?: number | null | undefined
  body?: string | undefined
  note?: string | undefined
  reason?: string | undefined
}
/** ครูรัน SQL ดู/ตรวจ DB ของนักเรียน (seed ใหม่ + รัน studentSql ก่อน) */
export interface CodeIdeQuerySqlRequest {
  studentId: string
  sql: string
}
export interface CodeIdeQuerySqlResponse {
  ok: boolean
  columns?: string[] | undefined
  rows?: Array<Array<string | number | null>> | undefined
  note?: string | undefined
  reason?: string | undefined
}
/** คอมเมนต์รายไฟล์ของครูใน Inspector */
export interface CodeIdeCommentSaveRequest {
  studentId: string
  path: string
  comment: string
}
export interface CodeIdeCommentItem {
  path: string
  comment: string
  updatedAtMs: number
}
export interface CodeIdeCommentListResponse {
  ok: boolean
  comments?: CodeIdeCommentItem[] | undefined
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

/* ---------- Screen Monitoring schemas (Phase 3c) ---------- */

const Uint8ArraySchema = z.instanceof(Uint8Array)

const ScreenSourceInfoSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    displayId: z.string().min(1).max(40),
    displayIndex: z.number().int().nonnegative(),
    displayCount: z.number().int().nonnegative(),
    label: z.string().max(120),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative()
  })
  .strict()

const ScreenEnvironmentStatusSchema = z
  .object({
    ok: z.boolean(),
    platform: z.string(),
    permission: z.enum(['granted', 'denied', 'unknown-session']),
    reason: z.string().max(200).optional()
  })
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
  'host:get-exam-state': { req: void; res: HostExamStateEvent & { durationSeconds: number } }
  'host:get-students': { req: void; res: StudentsUpdatedEvent }
  'host:get-summaries': { req: void; res: HostExamSummariesEvent }
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
  'student:exit-kiosk': { req: void; res: KioskEnterResponse }
  'student:internal-copy': { req: InternalCopyRequest; res: StudentSubmitResponse }
  'student:typing-metrics': { req: TypingMetricsRequest; res: StudentSubmitResponse }
  /* ---------- Module Packet Transport (Phase 2 สเปค/เพิ่งมีโค้ด) ---------- */
  'student:module-send': { req: StudentModuleSendRequest; res: StudentModuleSendResponse }
  /* ---------- Mode 2 / Mode 3 (Phase 5) ---------- */
  'exam:docs-toggle': { req: DocsToggleRequest; res: OkResponse }
  'exam:docs-navigate': { req: DocsNavigateRequest; res: OkResponse }
  'exam:open-vscode': { req: void; res: OpenVsCodeResponse }
  'student:focus-exam': { req: void; res: OkResponse }
  'host:open-doc-preview': { req: { url: string }; res: OpenDocPreviewResponse }
  'host:close-doc-preview': { req: void; res: OkResponse }
  'host:list-recorded-domains': { req: void; res: ListRecordedDomainsResponse }
  'host:approve-domain': { req: ApproveDomainRequest; res: ApproveDomainResponse }
  'host:clear-recorded-domains': { req: void; res: OkResponse }
  'host:set-domain-enforcement': { req: SetDomainEnforcementRequest; res: OkResponse }
  'host:get-triage-overview': { req: void; res: TriageOverviewEvent }
  'host:get-student-evidence': { req: StudentEvidenceRequest; res: StudentEvidenceResponse }
  'host:resolve-triage': { req: ResolveTriageRequest; res: ResolveTriageResponse }
  'host:send-proctor-warning': { req: SendProctorWarningRequest; res: OkResponse }
  'host:set-student-freeze': { req: SetStudentFreezeRequest; res: OkResponse }
  'host:export-incident-report': { req: void; res: ExportFileResponse }
  'host:export-audit-bundle': { req: void; res: ExportFileResponse }
  /* ---------- Host-as-Gateway (security item 2) ---------- */
  'gateway:interfaces': { req: void; res: { interfaces: GatewayInterfaceInfo[] } }
  'gateway:start': { req: GatewayStartRequest; res: GatewayStatus }
  'gateway:stop': { req: void; res: GatewayStatus }
  'gateway:status': { req: void; res: GatewayStatus }
  'gateway:leases': { req: void; res: { leases: GatewayLease[] } }
  'gateway:dns-log': { req: void; res: { entries: GatewayDnsLogEntry[] } }
  /* ---------- Attestation (Phase 4) ---------- */
  'host:get-attestation-config': { req: void; res: AttestationConfigResponse }
  'host:set-attestation-enforce': { req: { enforced: boolean }; res: OkResponse }
  /* ---------- TOFU device enrollment ---------- */
  'host:list-enrolled-devices': { req: void; res: ListEnrolledDevicesResponse }
  'host:set-enrolled-device-status': { req: SetEnrolledDeviceStatusRequest; res: OkResponse }
  'host:remove-enrolled-device': { req: { deviceId: string }; res: OkResponse }
  /* ---------- Screen Monitoring (Phase 3c) ---------- */
  'student:screen-get-sources': { req: void; res: StudentScreenSourcesResponse }
  'student:screen-segment': { req: StudentScreenSegmentRequest; res: OkResponse }
  'student:screen-thumbnail': { req: StudentScreenThumbnailRequest; res: OkResponse }
  'host:screen-inspect': { req: HostScreenInspectRequest; res: OkResponse }
  'host:fetch-ring-segment': { req: HostFetchSegmentRequest; res: OkResponse }
  'host:pin-screen-buffer': { req: HostPinScreenRequest; res: OkResponse }
  /* ---------- Dynamic Form — .ztform (Phase 6) ---------- */
  'form:save-ztform': { req: SaveZtformRequest; res: SaveZtformResponse }
  'form:load-ztform': { req: LoadZtformRequest; res: LoadZtformResponse }
  'host:list-saved-forms': { req: void; res: ListSavedFormsResponse }
  /* ---------- Dynamic Form — Responses/Grading/Export (Phase 7) ---------- */
  'form:ztform-state': { req: void; res: FormZtformStateResponse }
  'form:attach-room-form': { req: FormAttachRoomFormRequest; res: FormAttachRoomFormResponse }
  'form:responses-get': { req: void; res: FormResponsesSnapshot | null }
  'form:manual-grade': { req: FormManualGradeRequest; res: FormManualGradeResponse }
  'form:regrade-all': { req: { formPayloadJson?: string | undefined }; res: FormRegradeResponse }
  'form:export-csv': { req: void; res: FormExportFileResponse }
  'form:save-ztresults': { req: FormSaveResultsRequest; res: FormExportFileResponse }
  'form:load-ztresults': { req: LoadZtformRequest; res: FormLoadZtresultsResponse }
  'form:artifact-open': { req: { studentId: string; itemId: string; artifactId: string }; res: FormExportFileResponse }
  /* ---------- Code IDE — Local Runtime (Phase 9) ---------- */
  'code-ide:run-cli': { req: CodeIdeRunCliRequest; res: CodeIdeRunCliResponse }
  'code-ide:cache-student-bundles': { req: CodeIdeCacheStudentBundlesRequest; res: CodeIdeCacheStudentBundlesResponse }
  'code-ide:student-deps-status': { req: CodeIdeStudentDepsStatusRequest; res: CodeIdeStudentDepsStatusResponse }
  'code-ide:install-student-deps': { req: CodeIdeInstallStudentDepsRequest; res: CodeIdeInstallStudentDepsResponse }
  'code-ide:run-sql': { req: CodeIdeRunSqlRequest; res: CodeIdeRunSqlResponse }
  'code-ide:check-runtimes': { req: CodeIdeCheckRuntimesRequest; res: CodeIdeCheckRuntimesResponse }
  'code-ide:browse-sdk-path': { req: CodeIdeBrowseSdkPathRequest; res: CodeIdeBrowseSdkPathResponse }
  'code-ide:add-sdk-path': { req: CodeIdeAddSdkPathRequest; res: CodeIdeAddSdkPathResponse }
  /* ---------- Code IDE — Backend / Grader / Export (Phase 10) ---------- */
  /* (ส่งงาน/autosave ของนักเรียนวิ่งผ่านท่อกลาง student:module-send → LAN เท่านั้น — ไม่มี direct IPC) */
  'code-ide:attach-room-package': { req: CodeIdeAttachPackageRequest; res: CodeIdeAttachPackageResponse }
  'code-ide:submissions-get': { req: void; res: CodeIdeSubmissionsResponse }
  'code-ide:submission-detail': { req: { studentId: string }; res: CodeIdeSubmissionDetailResponse }
  'code-ide:manual-grade': { req: CodeIdeManualGradeRequest; res: CodeIdeManualGradeResponse }
  'code-ide:regrade-all': { req: void; res: CodeIdeRegradeResponse }
  'code-ide:workspace-state': { req: void; res: CodeIdeWorkspaceStateResponse }
  'code-ide:set-workspace-root': { req: void; res: CodeIdeSetWorkspaceResponse }
  'code-ide:open-student-folder': { req: { studentId: string }; res: CodeIdeSetWorkspaceResponse }
  'code-ide:export-csv': { req: void; res: CodeIdeSetWorkspaceResponse }
  'code-ide:export-bundle': { req: void; res: CodeIdeSetWorkspaceResponse }
  /* ---------- Code IDE — Inspector Run Tabs & Comments (Phase 10 ค้าง) ---------- */
  'code-ide:run-preview': { req: { studentId: string }; res: CodeIdeRunPreviewResponse }
  'code-ide:probe-api': { req: CodeIdeProbeApiRequest; res: CodeIdeProbeApiResponse }
  'code-ide:query-sql': { req: CodeIdeQuerySqlRequest; res: CodeIdeQuerySqlResponse }
  'code-ide:comment-save': { req: CodeIdeCommentSaveRequest; res: CodeIdeManualGradeResponse }
  'code-ide:comment-list': { req: { studentId: string }; res: CodeIdeCommentListResponse }
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
  'exam:module-ack': ModuleAckEvent
  'exam:module-state': ModuleStateEvent
  'exam:time-up': Record<string, never>
  'exam:completed': ExamCompletedPayload
  'exam:tick': ExamTickEvent
  'host:guard-events': HostGuardEventsEvent
  'host:recorded-domains-updated': RecordedDomainsUpdatedEvent
  'host:triage-updated': TriageOverviewEvent
  /* ---------- Host-as-Gateway (security item 2) ---------- */
  'gateway:status-changed': GatewayStatus
  'gateway:dns-query': GatewayDnsLogEntry
  /* ---------- Mode 2 / Mode 3 (Phase 5) ---------- */
  'exam:docs-state': DocsPanelState
  'exam:proctor-warning': { message: string; sentAtMs: number }
  'exam:freeze-state': StudentFreezeStateEvent
  /* ---------- Screen Monitoring (Phase 3c) ---------- */
  'screen:session': StudentScreenSessionEvent
  'screen:inspect': StudentScreenInspectEvent
  'host:screen-thumbnail': HostScreenThumbnailEvent
  'host:screen-segments': HostScreenSegmentsEvent
  'host:screen-segment-data': HostScreenSegmentDataEvent
  'host:screen-live-segment': HostScreenLiveSegmentEvent
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
        enforcement: EnforcementModeSchema,
        maxStudents: z.number().int().min(1).max(1000)
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
  'host:get-exam-state': {
    request: z.void(),
    response: z
      .object({
        state: z.enum(['idle', 'running', 'collecting', 'finished']),
        title: z.string().nullable(),
        questionCount: z.number().int().nonnegative(),
        examEndsAtMs: z.number().int(),
        serverNowMs: z.number().int(),
        room: z.string().max(80).nullable(),
        durationSeconds: z.number().int().nonnegative()
      })
      .strict()
  },
  'host:get-students': {
    request: z.void(),
    response: z.object({ students: z.array(HostStudentStatusIpcSchema) }).strict()
  },
  'host:get-summaries': {
    request: z.void(),
    response: z
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
  'student:exit-kiosk': {
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
  /* ---------- Module Packet Transport (Phase 2 สเปค/เพิ่งมีโค้ด) ---------- */
  'student:module-send': {
    request: z
      .object({
        moduleId: z.enum(['dynamic-form', 'code-ide', 'external-url']),
        kind: z.enum(['action', 'autosave']),
        payloadJson: z.string().min(2).max(12_000_000)
      })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        chunked: z.boolean().optional(),
        chunks: z.number().int().nonnegative().optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  /* ---------- Mode 2 / Mode 3 (Phase 5) ---------- */
  'exam:docs-toggle': {
    request: z.object({ open: z.boolean() }).strict(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'exam:docs-navigate': {
    request: z.object({ url: z.string().min(1).max(2_048) }).strict(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'exam:open-vscode': {
    request: z.void(),
    response: z.object({ ok: z.boolean(), reason: z.string().max(120).optional() }).strict()
  },
  'student:focus-exam': {
    request: z.void(),
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
  'host:clear-recorded-domains': {
    request: z.void(),
    response: z.object({ ok: z.boolean() }).strict()
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
  },
  'host:get-attestation-config': {
    request: z.void(),
    response: z
      .object({
        devMode: z.boolean(),
        signatureEnforced: z.boolean(),
        platform: z.string().max(20),
        trackedStudents: z.array(
          z
            .object({
              studentId: z.string().min(1).max(40),
              manifestHash: z.string().length(64).nullable(),
              signed: z.boolean()
            })
            .strict()
        )
      })
      .strict()
  },
  'host:set-attestation-enforce': {
    request: z.object({ enforced: z.boolean() }).strict(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'host:list-enrolled-devices': {
    request: z.void(),
    response: z
      .object({ devices: z.array(EnrolledDeviceViewSchema).max(2_000) })
      .strict()
  },
  'host:set-enrolled-device-status': {
    request: z
      .object({
        deviceId: z.string().regex(/^[0-9a-f]{32}$/),
        status: z.enum(['active', 'blocked'])
      })
      .strict(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'host:remove-enrolled-device': {
    request: z.object({ deviceId: z.string().regex(/^[0-9a-f]{32}$/) }).strict(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'student:screen-get-sources': {
    request: z.void(),
    response: z
      .object({
        environment: ScreenEnvironmentStatusSchema,
        sources: z.array(ScreenSourceInfoSchema).max(8)
      })
      .strict()
  },
  'student:screen-segment': {
    request: z
      .object({
        displayId: z.string().min(1).max(40),
        seqNo: z.number().int().nonnegative(),
        startTimeMs: z.number().int().nonnegative(),
        endTimeMs: z.number().int().nonnegative(),
        data: Uint8ArraySchema.refine((v) => v.byteLength <= 4 * 1024 * 1024, 'SEGMENT_TOO_LARGE')
      })
      .strict(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'student:screen-thumbnail': {
    request: z
      .object({
        displayIndex: z.number().int().nonnegative(),
        displayCount: z.number().int().nonnegative(),
        mode: z.enum(['thumbnail', 'live']),
        mimeType: z.string().max(60),
        timestampMs: z.number().int().nonnegative(),
        displayId: z.string().min(1).max(40),
        data: Uint8ArraySchema.refine((v) => v.byteLength <= 512 * 1024, 'FRAME_TOO_LARGE')
      })
      .strict(),
    response: z.object({ ok: z.boolean() }).strict()
  },
  'host:screen-inspect': {
    request: z
      .object({
        studentId: z.string().min(1).max(40),
        mode: z.enum(['live', 'playback', 'stop']),
        displayId: z.string().min(1).max(40).optional()
      })
      .strict(),
    response: z
      .object({ ok: z.boolean(), reason: z.string().max(200).optional() })
      .strict()
  },
  'host:fetch-ring-segment': {
    request: z
      .object({ studentId: z.string().min(1).max(40), segmentId: z.string().min(1).max(80) })
      .strict(),
    response: z
      .object({ ok: z.boolean(), reason: z.string().max(200).optional() })
      .strict()
  },
  'host:pin-screen-buffer': {
    request: z
      .object({ studentId: z.string().min(1).max(40), reason: z.string().max(200).optional() })
      .strict(),
    response: z
      .object({ ok: z.boolean(), reason: z.string().max(200).optional() })
      .strict()
  },
  /* ---------- Dynamic Form — .ztform (Phase 6) ---------- */
  'form:save-ztform': {
    request: z
      .object({
        formPayloadJson: z.string().min(2).max(10_000_000),
        encrypted: z.boolean(),
        password: z.string().min(1).max(200).optional()
      })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        filePath: z.string().max(1_000).optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'form:load-ztform': {
    request: z
      .object({ password: z.string().min(1).max(200).optional() })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        filePath: z.string().max(1_000).optional(),
        needPassword: z.boolean().optional(),
        manifest: z
          .object({
            formId: z.uuid(),
            title: z.string().max(120),
            totalQuestions: z.number().int().nonnegative(),
            totalPoints: z.number().nonnegative()
          })
          .strict()
          .optional(),
        formPayloadJson: z.string().min(2).max(10_000_000).optional(),
        message: z.string().max(300).optional()
      })
      .strict()
  },
  'host:list-saved-forms': {
    request: z.void(),
    response: z
      .object({
        forms: z.array(
          z
            .object({
              formId: z.uuid(),
              title: z.string().max(120),
              filePath: z.string().max(1_000),
              totalQuestions: z.number().int().nonnegative(),
              totalPoints: z.number().nonnegative(),
              encrypted: z.boolean(),
              savedAtMs: z.number().int().nonnegative()
            })
            .strict()
        )
      })
      .strict()
  },
  /* ---------- Dynamic Form — Responses/Grading/Export (Phase 7) ---------- */
  'form:ztform-state': {
    request: z.void(),
    response: z
      .object({
        ok: z.boolean(),
        roomId: z.string().max(64).nullable(),
        roomName: z.string().max(120).nullable(),
        formTitle: z.string().max(160).nullable(),
        hasResponses: z.boolean(),
        message: z.string().max(300).optional()
      })
      .strict()
  },
  'form:attach-room-form': {
    request: z
      .object({ formPayloadJson: z.string().min(2).max(20_000_000) })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        roomId: z.string().max(64).optional(),
        formTitle: z.string().max(160).optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'form:responses-get': {
    request: z.void(),
    response: z.union([z.object({ kind: z.literal('none') }).strict(), z.any()])
  },
  'form:manual-grade': {
    request: z
      .object({
        studentId: z.string().min(1).max(40),
        itemId: z.string().min(1).max(64),
        points: z.number().nonnegative().max(10000).nullable()
      })
      .strict(),
    response: z
      .object({ ok: z.boolean(), reason: z.string().max(200).optional() })
      .strict()
  },
  'form:regrade-all': {
    request: z
      .object({ formPayloadJson: z.string().min(2).max(20_000_000).optional() })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        students: z.number().int().nonnegative().optional(),
        changedItems: z.number().int().nonnegative().optional(),
        totalDeltaPoints: z.number().optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'form:export-csv': {
    request: z.void(),
    response: z
      .object({
        ok: z.boolean(),
        filePath: z.string().max(1_000).optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'form:save-ztresults': {
    request: z
      .object({
        encrypted: z.boolean(),
        password: z.string().min(1).max(200).optional()
      })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        filePath: z.string().max(1_000).optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'form:load-ztresults': {
    request: z
      .object({ password: z.string().min(1).max(200).optional() })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        needPassword: z.boolean().optional(),
        manifest: z
          .object({
            formId: z.uuid(),
            formTitle: z.string().max(120),
            roomId: z.string().max(64),
            roomName: z.string().max(120),
            createdAtMs: z.number().int().nonnegative(),
            studentCount: z.number().int().nonnegative()
          })
          .strict()
          .optional(),
        message: z.string().max(300).optional()
      })
      .strict()
  },
  'form:artifact-open': {
    request: z
      .object({
        studentId: z.string().min(1).max(40),
        itemId: z.string().min(1).max(64),
        artifactId: z.string().min(1).max(64)
      })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        filePath: z.string().max(1_000).optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  /* ---------- Code IDE — Local Runtime (Phase 9) ---------- */
  'code-ide:run-cli': {
    request: z
      .object({
        language: SupportedCodeLanguageSchema,
        entryPointPath: z.string().min(1).max(500),
        entries: z.array(VirtualEntrySchema).min(1).max(2000),
        test: CliTestCaseSchema,
        packageId: z.string().uuid().optional()
      })
      .strict(),
    response: z
      .object({
        testId: z.string().min(1).max(64),
        passed: z.boolean().nullable(),
        actualStdout: z.string().max(25_000),
        stderr: z.string().max(6_000),
        exitCode: z.number().int().nullable(),
        timedOut: z.boolean(),
        blockedReason: z.string().max(500).optional(),
        note: z.string().max(500)
      })
      .strict()
  },
  'code-ide:run-sql': {
    request: z
      .object({
        seedSql: z.string().max(500_000),
        studentSql: z.string().max(500_000),
        test: SqlTestCaseSchema
      })
      .strict(),
    response: z
      .object({
        testId: z.string().min(1).max(64),
        passed: z.boolean().nullable(),
        actualColumns: z.array(z.string().min(1).max(128)).max(64),
        actualRows: z
          .array(z.array(z.union([z.string(), z.number(), z.null()])).max(64))
          .max(200),
        note: z.string().max(500)
      })
      .strict()
  },
  'code-ide:cache-student-bundles': {
    request: z
      .object({
        packageId: z.string().uuid(),
        dependencies: z.array(DependencyBundleSchema).max(50),
        blobs: z
          .array(
            z
              .object({
                archivePath: z.string().min(1).max(500),
                dataBase64: z.string().min(1).max(8_000_000),
                sha256: z.string().length(64)
              })
              .strict()
          )
          .max(50)
      })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        cached: z.boolean(),
        unsupported: z.array(z.string().max(200)).max(50),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'code-ide:student-deps-status': {
    request: z.object({ packageId: z.string().uuid() }).strict(),
    response: z.object({ cached: z.boolean() }).strict()
  },
  'code-ide:install-student-deps': {
    request: z
      .object({
        packageId: z.string().uuid(),
        packages: z
          .array(
            z
              .object({
                ecosystem: z.enum(['npm', 'pip']),
                name: z.string().min(1).max(128),
                version: z.string().min(1).max(64)
              })
              .strict()
          )
          .max(50)
      })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        installed: z.array(z.string().max(160)).max(50),
        note: z.string().max(1000),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'code-ide:check-runtimes': {
    request: z
      .object({ languages: z.array(z.string().min(1).max(32)).max(32) })
      .strict(),
    response: z
      .object({
        runtimes: z
          .array(
            z
              .object({
                name: z.string().min(1).max(32),
                found: z.boolean(),
                version: z.string().max(200).optional(),
                path: z.string().max(500).optional(),
                customPath: z.string().max(500).optional(),
                hint: z.string().max(300)
              })
              .strict()
          )
          .max(32)
      })
      .strict()
  },
  'code-ide:browse-sdk-path': {
    request: z
      .object({ title: z.string().min(1).max(120).optional() })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        dirPath: z.string().max(1_000).optional(),
        reason: z.string().max(120).optional()
      })
      .strict()
  },
  'code-ide:add-sdk-path': {
    request: z
      .object({ runtime: z.string().min(1).max(32), dirPath: z.string().min(1).max(1_000) })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        version: z.string().max(200).optional(),
        reason: z.string().max(300).optional()
      })
      .strict()
  },
  /* ---------- Code IDE — Backend / Grader / Export (Phase 10) ---------- */
  'code-ide:attach-room-package': {
    request: z.object({ packageJson: z.string().min(2).max(30_000_000) }).strict(),
    response: z
      .object({
        ok: z.boolean(),
        roomId: z.string().max(64).optional(),
        packageTitle: z.string().max(160).optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'code-ide:submissions-get': {
    request: z.void(),
    response: z
      .object({
        ok: z.boolean(),
        roomId: z.string().max(64).nullable(),
        roomName: z.string().max(120).nullable(),
        packageTitle: z.string().max(160).nullable(),
        category: z.string().max(32).nullable(),
        language: z.string().max(32).nullable(),
        questionSlug: z.string().max(80).nullable(),
        maxPoints: z.number().nonnegative(),
        queue: z.object({ active: z.number().int().nonnegative(), pending: z.number().int().nonnegative() }).strict(),
        depsUnsupported: z.array(z.string().max(300)).max(50),
        submissions: z
          .array(
            z
              .object({
                studentId: z.string().min(1).max(40),
                fileCount: z.number().int().nonnegative(),
                passedCount: z.number().int().nonnegative(),
                totalCount: z.number().int().nonnegative(),
                autoPoints: z.number(),
                manualPoints: z.number().nullable(),
                totalPoints: z.number(),
                maxPoints: z.number(),
                status: z.enum(['queued', 'grading', 'graded', 'blocked', 'error']),
                submittedAtMs: z.number().int().nullable(),
                gradedAtMs: z.number().int().nullable(),
                blockedReason: z.string().max(500).nullable()
              })
              .strict()
          )
          .max(500),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'code-ide:submission-detail': {
    request: z.object({ studentId: z.string().min(1).max(40) }).strict(),
    response: z
      .object({
        ok: z.boolean(),
        studentId: z.string().max(40).optional(),
        status: z.string().max(20).optional(),
        manualPoints: z.number().nullable().optional(),
        entries: z.array(VirtualEntrySchema).max(2000).optional(),
        starterEntries: z.array(VirtualEntrySchema).max(2000).optional(),
        draftEntries: z.array(VirtualEntrySchema).max(2000).optional(),
        referenceEntries: z.array(VirtualEntrySchema).max(2000).optional(),
        gradeResults: z
          .array(
            z
              .object({
                testId: z.string().max(64),
                kind: z.string().max(32),
                visibility: z.enum(['sample', 'hidden']),
                points: z.number(),
                earned: z.number(),
                passed: z.boolean().nullable(),
                note: z.string().max(500),
                durationMs: z.number().int().nonnegative()
              })
              .strict()
          )
          .max(200)
          .optional(),
        blockedReason: z.string().max(500).nullable().optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'code-ide:manual-grade': {
    request: z
      .object({ studentId: z.string().min(1).max(40), points: z.number().nonnegative().max(10000).nullable() })
      .strict(),
    response: z.object({ ok: z.boolean(), reason: z.string().max(200).optional() }).strict()
  },
  'code-ide:regrade-all': {
    request: z.void(),
    response: z
      .object({
        ok: z.boolean(),
        students: z.number().int().nonnegative().optional(),
        graded: z.number().int().nonnegative().optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'code-ide:workspace-state': {
    request: z.void(),
    response: z
      .object({
        rootPath: z.string().max(1_000).nullable(),
        workspaceOk: z.boolean(),
        workspaceReason: z.string().max(120).optional(),
        queue: z.object({ active: z.number().int().nonnegative(), pending: z.number().int().nonnegative() }).strict()
      })
      .strict()
  },
  'code-ide:set-workspace-root': {
    request: z.void(),
    response: z
      .object({
        ok: z.boolean(),
        rootPath: z.string().max(1_000).optional(),
        reason: z.string().max(120).optional()
      })
      .strict()
  },
  'code-ide:open-student-folder': {
    request: z.object({ studentId: z.string().min(1).max(40) }).strict(),
    response: z
      .object({
        ok: z.boolean(),
        rootPath: z.string().max(1_000).optional(),
        reason: z.string().max(120).optional()
      })
      .strict()
  },
  'code-ide:export-csv': {
    request: z.void(),
    response: z
      .object({
        ok: z.boolean(),
        rootPath: z.string().max(1_000).optional(),
        reason: z.string().max(120).optional()
      })
      .strict()
  },
  'code-ide:export-bundle': {
    request: z.void(),
    response: z
      .object({
        ok: z.boolean(),
        rootPath: z.string().max(1_000).optional(),
        reason: z.string().max(120).optional()
      })
      .strict()
  },
  /* ---------- Code IDE — Inspector Run Tabs & Comments (Phase 10 ค้าง) ---------- */
  'code-ide:run-preview': {
    request: z.object({ studentId: z.string().min(1).max(40) }).strict(),
    response: z
      .object({
        ok: z.boolean(),
        html: z.string().max(1_000_000).optional(),
        js: z.string().max(2_000_000).optional(),
        reason: z.string().max(300).optional()
      })
      .strict()
  },
  'code-ide:probe-api': {
    request: z
      .object({
        studentId: z.string().min(1).max(40),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().min(1).max(500),
        bodyJson: z.string().max(200_000).optional()
      })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        status: z.number().int().min(100).max(599).nullable().optional(),
        body: z.string().max(8_000).optional(),
        note: z.string().max(300).optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'code-ide:query-sql': {
    request: z
      .object({ studentId: z.string().min(1).max(40), sql: z.string().max(100_000) })
      .strict(),
    response: z
      .object({
        ok: z.boolean(),
        columns: z.array(z.string().min(1).max(128)).max(64).optional(),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.null()])).max(64)).max(200).optional(),
        note: z.string().max(500).optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  'code-ide:comment-save': {
    request: z
      .object({
        studentId: z.string().min(1).max(40),
        path: z.string().min(1).max(500),
        comment: z.string().max(5000)
      })
      .strict(),
    response: z.object({ ok: z.boolean(), reason: z.string().max(200).optional() }).strict()
  },
  'code-ide:comment-list': {
    request: z.object({ studentId: z.string().min(1).max(40) }).strict(),
    response: z
      .object({
        ok: z.boolean(),
        comments: z
          .array(
            z
              .object({
                path: z.string().min(1).max(500),
                comment: z.string().max(5000),
                updatedAtMs: z.number().int().nonnegative()
              })
              .strict()
          )
          .max(2000)
          .optional(),
        reason: z.string().max(200).optional()
      })
      .strict()
  },
  /* ---------- Host-as-Gateway (security item 2) ---------- */
  'gateway:interfaces': {
    request: z.void(),
    response: GatewayInterfacesResponseSchema
  },
  'gateway:start': {
    request: GatewayStartRequestSchema,
    response: GatewayStatusSchema
  },
  'gateway:stop': {
    request: z.void(),
    response: GatewayStatusSchema
  },
  'gateway:status': {
    request: z.void(),
    response: GatewayStatusSchema
  },
  'gateway:leases': {
    request: z.void(),
    response: GatewayLeasesResponseSchema
  },
  'gateway:dns-log': {
    request: z.void(),
    response: GatewayDnsLogResponseSchema
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
  'exam:module-ack': z
    .object({
      moduleId: z.enum(['dynamic-form', 'code-ide', 'external-url']),
      kind: z.enum(['action', 'autosave']),
      ok: z.boolean(),
      progressText: z.string().max(200).optional(),
      reason: z.string().max(200).optional()
    })
    .strict(),
  'exam:module-state': z
    .object({
      moduleId: z.enum(['dynamic-form', 'code-ide', 'external-url']),
      stateJson: z.string().min(2).max(8_000_000)
    })
    .strict(),
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
  /* ---------- Mode 2 / Mode 3 (Phase 5) ---------- */
  'exam:docs-state': z
    .object({
      open: z.boolean(),
      url: z.string().max(2_048).nullable(),
      allowedDomains: z.array(z.string().min(1).max(200)).max(512),
      enforcement: z.enum(['warn', 'block']),
      blockedUrl: z.string().max(2_048).nullable(),
      warnUrl: z.string().max(2_048).nullable(),
      viewError: z.string().max(500).nullable()
    })
    .strict(),
  'exam:proctor-warning': ProctorWarningPayloadSchema,
  'exam:freeze-state': FreezeStatePayloadSchema,
  'screen:session': z
    .object({
      active: z.boolean(),
      thumbnailMinIntervalMs: z.number().int().min(1000).max(60_000).optional(),
      thumbnailMaxIntervalMs: z.number().int().min(1000).max(60_000).optional(),
      reason: z.string().max(200).optional()
    })
    .strict(),
  'screen:inspect': z
    .object({
      requestId: z.string().min(1).max(64),
      mode: z.enum(['live', 'playback', 'stop']),
      displayId: z.string().min(1).max(40).optional(),
      transport: z.enum(['udp-segments', 'jpeg-fallback']).optional()
    })
    .strict(),
  'host:screen-thumbnail': z
    .object({
      studentId: z.string().min(1).max(40),
      displayIndex: z.number().int().nonnegative(),
      displayCount: z.number().int().nonnegative(),
      mode: z.enum(['thumbnail', 'live']),
      mimeType: z.string().max(60),
      imageBase64: z.string().max(700_000),
      timestampMs: z.number().int().nonnegative(),
      displayId: z.string().min(1).max(40)
    })
    .strict(),
  'host:screen-segments': z
    .object({
      studentId: z.string().min(1).max(40),
      displayId: z.string().min(1).max(40),
      segments: z.array(RingSegmentMetaSchema).max(600)
    })
    .strict(),
  'host:screen-segment-data': z
    .object({
      studentId: z.string().min(1).max(40),
      segmentId: z.string().min(1).max(80),
      displayId: z.string().min(1).max(40),
      mimeType: z.string().max(60),
      dataBase64: z.string().max(4_200_000)
    })
    .strict(),
  'host:screen-live-segment': z
    .object({
      studentId: z.string().min(1).max(40),
      segmentId: z.string().min(1).max(80),
      displayId: z.string().min(1).max(40),
      mimeType: z.string().max(60),
      dataBase64: z.string().max(6_000_000),
      seqNo: z.number().int().nonnegative(),
      startTimeMs: z.number().int().nonnegative(),
      endTimeMs: z.number().int().nonnegative()
    })
    .strict(),
  /* ---------- Host-as-Gateway (security item 2) ---------- */
  'gateway:status-changed': GatewayStatusSchema,
  'gateway:dns-query': GatewayDnsLogEntrySchema
}

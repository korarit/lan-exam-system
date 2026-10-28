import { z } from 'zod'
import {
  ExamStartedPayloadSchema,
  ExamCompletedPayloadSchema,
  ExamTimeUpPayloadSchema,
  StateRecoveryPayloadSchema,
  SubmitAnswerPayloadSchema,
  SubmitRejectedPayloadSchema,
  AutoSaveDraftPayloadSchema,
  FinalDraftFlushPayloadSchema,
  NavigateToPayloadSchema,
  ClientQuestionPayloadSchema
} from './exam-schema'
import {
  SignedDetectionPolicySchema,
  DetectionEventSchema,
  MAX_EVENTS_PER_REPORT,
  type SignedDetectionPolicy,
  type DetectionEvent
} from './policy-schema'
import {
  ScreenSessionPayloadSchema,
  ScreenInspectRequestPayloadSchema,
  FetchRingSegmentPayloadSchema,
  PinRingSegmentsPayloadSchema,
  RingSegmentListPayloadSchema,
  ScreenUdpRegisterPayloadSchema,
  ScreenUdpReadyPayloadSchema
} from './screen-protocol'
export type {
  RingSegmentMeta,
  ScreenInspectMode,
  ScreenFrameMode
} from './screen-protocol'

/* ============================================================
 * ข้อความเครือข่าย (over TLS 1.3, Length-prefixed framing)
 * ============================================================ */

export const PROTOCOL_VERSION = 1

export const NetMsgType = {
  clientHello: 'CLIENT_HELLO',
  serverProof: 'SERVER_PROOF',
  joinRequest: 'JOIN_REQUEST',
  joinAccepted: 'JOIN_ACCEPTED',
  joinRejected: 'JOIN_REJECTED',
  heartbeatPing: 'HEARTBEAT_PING',
  heartbeatPong: 'HEARTBEAT_PONG',
  resumeRequest: 'RESUME_REQUEST',
  roomClosed: 'ROOM_CLOSED',
  error: 'ERROR',
  /* ---------- Exam Core (Phase 2) ---------- */
  examStarted: 'EXAM_STARTED',
  questionPayload: 'QUESTION_PAYLOAD',
  submitAnswer: 'SUBMIT_ANSWER',
  submitRejected: 'SUBMIT_REJECTED',
  autosaveDraft: 'AUTOSAVE_DRAFT',
  finalDraftFlush: 'FINAL_DRAFT_FLUSH',
  navigateTo: 'NAVIGATE_TO',
  stateRecovery: 'STATE_RECOVERY',
  timeUp: 'EXAM_TIME_UP',
  examCompleted: 'EXAM_COMPLETED',
  /* ---------- Guard (Phase 3a) ---------- */
  guardEvent: 'GUARD_EVENT',
  policyUpdate: 'POLICY_UPDATE',
  /* ---------- Proctor actions (Phase 3b) ---------- */
  proctorWarning: 'PROCTOR_WARNING',
  freezeExam: 'FREEZE_EXAM',
  unfreezeExam: 'UNFREEZE_EXAM',
  /* ---------- Screen Monitoring (Phase 3c) ---------- */
  screenSession: 'SCREEN_SESSION',
  screenInspectRequest: 'SCREEN_INSPECT_REQUEST',
  ringSegmentList: 'RING_SEGMENT_LIST',
  fetchRingSegment: 'FETCH_RING_SEGMENT',
  pinRingSegments: 'PIN_RING_SEGMENTS',
  /* ---------- Screen Monitoring (Phase 3c — UDP transport) ---------- */
  screenUdpRegister: 'SCREEN_UDP_REGISTER',
  screenUdpReady: 'SCREEN_UDP_READY'
} as const

export type NetMsgTypeValue = (typeof NetMsgType)[keyof typeof NetMsgType]

/** ตรวจว่าเป็น base64 ที่ถอดออกมาได้ N bytes (ทำงานได้ทั้งฝั่ง Node และ browser) */
function base64OfLength(bytes: number) {
  const regex = /^[A-Za-z0-9+/]+={0,2}$/
  const byteLength = (s: string): number => {
    const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0
    return Math.floor((s.length * 3) / 4) - padding
  }
  return z
    .string()
    .regex(regex, { message: 'must be standard base64' })
    .refine((s) => byteLength(s) === bytes, { message: `must decode to ${bytes} bytes` })
}

const nonceSchema = base64OfLength(32)
const hmacSchema = base64OfLength(32)
const sessionKeySchema = base64OfLength(32)

/* ---------- Payload schema ต่อ message type ---------- */

export const ClientHelloPayloadSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    clientNonce: nonceSchema
  })
  .strict()

export const ServerProofPayloadSchema = z
  .object({
    serverNonce: nonceSchema,
    /** HMAC(roomPinKey, certFingerprint + clientNonce + serverNonce) */
    hmacProof: hmacSchema
  })
  .strict()

export const JoinRequestPayloadSchema = z
  .object({
    studentId: z.string().min(1).max(40),
    studentName: z.string().min(1).max(80),
    /** HMAC(roomPinKey, certFingerprint + serverNonce + clientNonce + studentId) */
    clientAuthHmac: hmacSchema
  })
  .strict()

export const JoinRejectedReasonSchema = z.enum([
  'bad-auth',
  'room-closed',
  'room-full',
  'duplicate-id',
  'rate-limited',
  'unknown-message'
])
export type JoinRejectedReason = z.infer<typeof JoinRejectedReasonSchema>

export const JoinAcceptedPayloadSchema = z
  .object({
    sessionToken: z.string().min(16).max(64),
    /** คีย์ต่อ session สำหรับ HMAC ทุกข้อความถัดไป */
    dynamicSessionKey: sessionKeySchema,
    serverTimeMs: z.number().int(),
    remainingExamSeconds: z.number().int().nonnegative(),
    studentCount: z.number().int().nonnegative()
  })
  .strict()

export const JoinRejectedPayloadSchema = z
  .object({ reason: JoinRejectedReasonSchema })
  .strict()

export const FocusStateSchema = z.enum(['focused', 'blurred', 'fullscreen-exit'])
export type FocusState = z.infer<typeof FocusStateSchema>

export const HeartbeatPingPayloadSchema = z
  .object({
    focusState: FocusStateSchema,
    currentQuestionIndex: z.number().int().nonnegative().nullable()
  })
  .strict()

export const HeartbeatPongPayloadSchema = z
  .object({
    serverTimeMs: z.number().int(),
    remainingExamSeconds: z.number().int().nonnegative()
  })
  .strict()

export const ResumeRequestPayloadSchema = z
  .object({ sessionToken: z.string().min(16).max(64) })
  .strict()

export const RoomClosedPayloadSchema = z.object({}).strict()

export const ErrorPayloadSchema = z
  .object({ message: z.string().max(200) })
  .strict()

/** เครื่องนักเรียน → เครื่องแม่: ชุดเหตุการณ์ตรวจจับ (batch ลด fragmentation) */
export const GuardEventPayloadSchema = z
  .object({ events: z.array(DetectionEventSchema).min(1).max(MAX_EVENTS_PER_REPORT) })
  .strict()
export type GuardEventPayload = { events: DetectionEvent[] }

/** เครื่องแม่ → เครื่องนักเรียน: นโยบายตรวจจับเซ็นลายเซ็น (อัปเดตระหว่างสอบได้) */
export const PolicyUpdatePayloadSchema = z
  .object({ policy: SignedDetectionPolicySchema })
  .strict()
export type PolicyUpdatePayload = { policy: SignedDetectionPolicy }

/** เครื่องแม่ → เครื่องนักเรียน: ข้อความเตือนจากผู้คุมสอบขึ้นจอ (Phase 3b) */
export const ProctorWarningPayloadSchema = z
  .object({
    message: z.string().min(1).max(300),
    sentAtMs: z.number().int().nonnegative()
  })
  .strict()
export type ProctorWarningPayload = z.infer<typeof ProctorWarningPayloadSchema>

/** เครื่องแม่ → เครื่องนักเรียน: สั่ง Freeze/Unfreeze เครื่อง (Phase 3b) */
export const FreezeStatePayloadSchema = z
  .object({
    frozen: z.boolean(),
    reason: z.string().max(160).optional()
  })
  .strict()
export type FreezeStatePayload = z.infer<typeof FreezeStatePayloadSchema>

/** Envelope กลางของทุกข้อความ (Length-prefixed frame บรรจุ JSON ของ envelope นี้) */
export const NetEnvelopeSchema = z
  .object({
    msgId: z.uuid(),
    seq: z.number().int().nonnegative(),
    timestamp: z.number().int(),
    type: z.string(),
    payload: z.unknown(),
    /** เติมเมื่อได้ dynamicSessionKey แล้ว */
    hmac: hmacSchema.optional()
  })
  .strict()

export type NetEnvelope = z.infer<typeof NetEnvelopeSchema>

export const NetMessagePayloadSchemas: Record<string, z.ZodType> = {
  [NetMsgType.clientHello]: ClientHelloPayloadSchema,
  [NetMsgType.serverProof]: ServerProofPayloadSchema,
  [NetMsgType.joinRequest]: JoinRequestPayloadSchema,
  [NetMsgType.joinAccepted]: JoinAcceptedPayloadSchema,
  [NetMsgType.joinRejected]: JoinRejectedPayloadSchema,
  [NetMsgType.heartbeatPing]: HeartbeatPingPayloadSchema,
  [NetMsgType.heartbeatPong]: HeartbeatPongPayloadSchema,
  [NetMsgType.resumeRequest]: ResumeRequestPayloadSchema,
  [NetMsgType.roomClosed]: RoomClosedPayloadSchema,
  [NetMsgType.error]: ErrorPayloadSchema,
  [NetMsgType.examStarted]: ExamStartedPayloadSchema,
  [NetMsgType.questionPayload]: ClientQuestionPayloadSchema,
  [NetMsgType.submitAnswer]: SubmitAnswerPayloadSchema,
  [NetMsgType.submitRejected]: SubmitRejectedPayloadSchema,
  [NetMsgType.autosaveDraft]: AutoSaveDraftPayloadSchema,
  [NetMsgType.finalDraftFlush]: FinalDraftFlushPayloadSchema,
  [NetMsgType.navigateTo]: NavigateToPayloadSchema,
  [NetMsgType.stateRecovery]: StateRecoveryPayloadSchema,
  [NetMsgType.timeUp]: ExamTimeUpPayloadSchema,
  [NetMsgType.examCompleted]: ExamCompletedPayloadSchema,
  [NetMsgType.guardEvent]: GuardEventPayloadSchema,
  [NetMsgType.policyUpdate]: PolicyUpdatePayloadSchema,
  [NetMsgType.proctorWarning]: ProctorWarningPayloadSchema,
  [NetMsgType.freezeExam]: FreezeStatePayloadSchema,
  [NetMsgType.unfreezeExam]: FreezeStatePayloadSchema,
  [NetMsgType.screenSession]: ScreenSessionPayloadSchema,
  [NetMsgType.screenInspectRequest]: ScreenInspectRequestPayloadSchema,
  [NetMsgType.ringSegmentList]: RingSegmentListPayloadSchema,
  [NetMsgType.fetchRingSegment]: FetchRingSegmentPayloadSchema,
  [NetMsgType.pinRingSegments]: PinRingSegmentsPayloadSchema,
  [NetMsgType.screenUdpRegister]: ScreenUdpRegisterPayloadSchema,
  [NetMsgType.screenUdpReady]: ScreenUdpReadyPayloadSchema
}

/* ============================================================
 * UDP Discovery Beacon
 * ============================================================ */

export const UdpBeaconSchema = z
  .object({
    magic: z.literal('ZTEXAM_V1'),
    roomId: z.uuid(),
    roomName: z.string().max(80),
    hostName: z.string().max(60),
    examMode: z.enum(['closed', 'in-app-docs', 'external-tools']),
    tcpPort: z.number().int().min(1024).max(65535),
    /** 16 ตัวแรกของ SHA-256 certificate fingerprint */
    certFpShort: z.string().length(16),
    studentCount: z.number().int().nonnegative(),
    examStatus: z.enum(['lobby', 'in-progress', 'ended']),
    timestamp: z.number().int()
  })
  .strict()

export type UdpBeacon = z.infer<typeof UdpBeaconSchema>

export interface DiscoveredRoom extends UdpBeacon {
  sourceIp: string
  lastSeenAtMs: number
}

/* ============================================================
 * สถานะการเชื่อมต่อ (Fail-closed state machine)
 * ============================================================ */

export const StudentConnectionStateSchema = z.enum([
  'idle',
  'connecting',
  'ready',
  'frozen',
  'reconnecting',
  'rejected',
  'closed'
])
export type StudentConnectionState = z.infer<typeof StudentConnectionStateSchema>

export interface StudentConnectionStatus {
  state: StudentConnectionState
  reason?: string | undefined
  sessionToken?: string | undefined
}

export interface HostStudentStatus {
  studentId: string
  studentName: string
  online: boolean
  focusState: FocusState | null
  currentQuestionIndex: number | null
  lastSeenAtMs: number | null
}

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

/* ---------- Channel maps (single source of truth for IPC surface) ---------- */

/* ---------- Zod schemas สำหรับ payload ของ network channels ---------- */

const HostRoomInfoSchema = z
  .object({
    roomId: z.uuid(),
    roomName: z.string().max(80),
    roomPin: z.string().regex(/^\d{6}$/),
    tcpPort: z.number().int().min(1024).max(65535),
    certFingerprint: z.string().length(64),
    certFpShort: z.string().length(16)
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
  'student:start-discovery': { req: void; res: SelectRoleResponse }
  'student:stop-discovery': { req: void; res: SelectRoleResponse }
  'student:join-room': { req: JoinRoomRequest; res: JoinRoomResponse }
  'student:leave-room': { req: void; res: SelectRoleResponse }
}

/** Main -> Renderer (webContents.send) push event channels */
export interface IpcEventMap {
  'app:role-changed': RoleChangedEvent
  'network:rooms-updated': RoomsUpdatedEvent
  'network:connection-state': StudentConnectionStatus
  'host:students-updated': StudentsUpdatedEvent
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
  'host:students-updated': z.object({ students: z.array(HostStudentStatusIpcSchema) }).strict()
}

import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { HostRoomManager } from '../network/host-room'
import type { RoomDiscoveryListener } from '../network/discovery'
import {
  ExamTlsClient,
  HandshakeProofError,
  JoinRejectedError
} from '../network/tls-client'
import type { SelectRoleResponse } from '@shared/ipc-channels'
import type { StudentConnectionStatus } from '@shared/protocol-schema'

const ok = (): SelectRoleResponse => ({ ok: true, role: 'host' })

export interface NetworkServices {
  /** สร้าง/คืน HostRoomManager (ผูกกับฐานข้อมูลเครื่องแม่ใน main/index.ts) */
  getRoomManager(): HostRoomManager
  getDiscovery(): RoomDiscoveryListener
  getStudentClient(): ExamTlsClient
  /** จดจำ IP/พอร์ตเครื่องแม่ที่ join ล่าสุด (NetworkInspector ยกเว้นเฉพาะท่อสอบ) */
  onStudentJoinedRoom?: (hostIp: string, roomId: string, hostPort: number) => void
}

export function registerNetworkHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  services: NetworkServices
): void {
  /* ---------- Host ---------- */

  router.register('host:create-room', async (req) => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const info = await services.getRoomManager().createRoom({
      roomName: req.roomName,
      mode: req.mode,
      enforcement: req.enforcement,
      maxStudents: req.maxStudents
    })
    return info
  })

  router.register('host:close-room', async () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    await services.getRoomManager().closeRoom()
    return ok()
  })

  router.register('host:get-room', () => {
    return { room: services.getRoomManager().room }
  })

  router.register('host:get-students', () => {
    return { students: services.getRoomManager().students }
  })

  /* ---------- Student ---------- */

  router.register('student:start-discovery', () => {
    services.getDiscovery().start()
    return ok()
  })

  router.register('student:stop-discovery', () => {
    services.getDiscovery().stop()
    return ok()
  })

  router.register('student:join-room', async (req) => {
    try {
      const result = await services.getStudentClient().connect({
        host: req.hostIp,
        port: req.hostPort,
        roomId: req.roomId,
        roomPin: req.roomPin,
        studentId: req.studentId,
        studentName: req.studentName
      })
      services.onStudentJoinedRoom?.(req.hostIp, req.roomId, req.hostPort)
      return { ok: true, sessionToken: result.sessionToken }
    } catch (err) {
      const reason =
        err instanceof HandshakeProofError
          ? 'bad-proof (PIN ผิด หรือเครื่องแม่ถูกปลอมแทน)'
          : err instanceof JoinRejectedError
            ? `rejected: ${err.reason}`
            : err instanceof Error
              ? err.message.slice(0, 120)
              : 'unknown-error'
      return { ok: false, reason }
    }
  })

  router.register('student:leave-room', () => {
    services.getStudentClient().stop()
    return ok()
  })
}

/** สถานะการเชื่อมต่อถูก push จาก main ผ่าน event นี้เสมอ */
export function forwardConnectionState(
  eventSender: (channel: string, payload: unknown) => void
): (status: StudentConnectionStatus) => void {
  return (status) => eventSender('network:connection-state', status)
}

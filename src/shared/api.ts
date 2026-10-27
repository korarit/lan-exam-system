import type {
  SelectRoleRequest,
  SelectRoleResponse,
  AppInfo,
  RoleChangedEvent,
  CreateRoomRequest,
  HostRoomInfo,
  GetRoomResponse,
  JoinRoomRequest,
  JoinRoomResponse,
  RoomsUpdatedEvent,
  StudentsUpdatedEvent,
  IpcEventChannel,
  IpcEventMap
} from './ipc-channels'

export type Unsubscribe = () => void
export type AnyEventMap = IpcEventMap
export type EventListener<C extends IpcEventChannel> = (payload: IpcEventMap[C]) => void

/**
 * API เดียวที่ preload เปิดให้ renderer ผ่าน contextBridge
 * ห้ามส่ง ipcRenderer หรือ remote object ออกไปตรง ๆ
 */
export interface ZtExamApi {
  selectRole(req: SelectRoleRequest): Promise<SelectRoleResponse>
  getAppInfo(): Promise<AppInfo>
  /* ---------- Host ---------- */
  createRoom(req: CreateRoomRequest): Promise<HostRoomInfo>
  closeRoom(): Promise<SelectRoleResponse>
  getRoom(): Promise<GetRoomResponse>
  /* ---------- Student ---------- */
  startDiscovery(): Promise<SelectRoleResponse>
  stopDiscovery(): Promise<SelectRoleResponse>
  joinRoom(req: JoinRoomRequest): Promise<JoinRoomResponse>
  leaveRoom(): Promise<SelectRoleResponse>
  /* ---------- Event subscribe (คืน unsubscribe() กัน memory leak ใน React) ---------- */
  onRoleChanged(listener: (event: RoleChangedEvent) => void): Unsubscribe
  onEvent<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventMap[C]) => void
  ): Unsubscribe
}

// เผื่อ typing ของผู้เรียก: รูปแบบ event ทั้งหมด
export type { RoomsUpdatedEvent, StudentsUpdatedEvent }

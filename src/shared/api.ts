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
  LoadExamRequest,
  LoadExamResponse,
  SelectExamFileResponse,
  ExamStartResponse,
  StudentSubmitResponse,
  KioskEnterResponse,
  IpcInvokeMap,
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
  loadExam(req: LoadExamRequest): Promise<LoadExamResponse>
  selectExamFile(): Promise<SelectExamFileResponse>
  startExam(): Promise<ExamStartResponse>
  endExam(): Promise<ExamStartResponse>
  /* ---------- Student ---------- */
  startDiscovery(): Promise<SelectRoleResponse>
  stopDiscovery(): Promise<SelectRoleResponse>
  joinRoom(req: JoinRoomRequest): Promise<JoinRoomResponse>
  leaveRoom(): Promise<SelectRoleResponse>
  submitAnswer(req: IpcInvokeMap['student:submit-answer']['req']): Promise<StudentSubmitResponse>
  autosaveDraft(req: IpcInvokeMap['student:autosave-draft']['req']): Promise<StudentSubmitResponse>
  navigate(req: { cursorIndex: number }): Promise<StudentSubmitResponse>
  enterKiosk(): Promise<KioskEnterResponse>
  /* ---------- Guard (Phase 3a) ---------- */
  markInternalCopy(req: IpcInvokeMap['student:internal-copy']['req']): Promise<StudentSubmitResponse>
  sendTypingMetrics(req: IpcInvokeMap['student:typing-metrics']['req']): Promise<StudentSubmitResponse>
  /* ---------- Doc Preview & Domain Allowlist (Phase 3a-plus) ---------- */
  openDocPreview(req: IpcInvokeMap['host:open-doc-preview']['req']): Promise<IpcInvokeMap['host:open-doc-preview']['res']>
  closeDocPreview(): Promise<IpcInvokeMap['host:close-doc-preview']['res']>
  listRecordedDomains(): Promise<IpcInvokeMap['host:list-recorded-domains']['res']>
  approveDomain(req: IpcInvokeMap['host:approve-domain']['req']): Promise<IpcInvokeMap['host:approve-domain']['res']>
  setDomainEnforcement(req: IpcInvokeMap['host:set-domain-enforcement']['req']): Promise<IpcInvokeMap['host:set-domain-enforcement']['res']>
  /* ---------- Event subscribe (คืน unsubscribe() กัน memory leak ใน React) ---------- */
  onRoleChanged(listener: (event: RoleChangedEvent) => void): Unsubscribe
  onEvent<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventMap[C]) => void
  ): Unsubscribe
}

// เผื่อ typing ของผู้เรียก: รูปแบบ event ทั้งหมด
export type { RoomsUpdatedEvent, StudentsUpdatedEvent }

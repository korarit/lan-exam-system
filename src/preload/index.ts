import { contextBridge, ipcRenderer } from 'electron'
import type {
  IpcInvokeChannel,
  IpcInvokeMap,
  IpcResult,
  IpcEventChannel,
  IpcEventMap
} from '@shared/ipc-channels'
import type { ZtExamApi, Unsubscribe } from '@shared/api'

async function call<C extends IpcInvokeChannel>(
  channel: C,
  payload: IpcInvokeMap[C]['req']
): Promise<IpcInvokeMap[C]['res']> {
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<
    IpcInvokeMap[C]['res']
  >
  if (!result.ok || result.data === undefined) {
    throw new Error(result.error?.message ?? 'IPC call failed')
  }
  return result.data
}

function subscribe<C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEventMap[C]) => void
): Unsubscribe {
  const wrapped = (_event: unknown, payload: IpcEventMap[C]): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api: ZtExamApi = {
  selectRole: (req) => call('app:select-role', req),
  getAppInfo: () => call('app:get-app-info', undefined),

  createRoom: (req) => call('host:create-room', req),
  closeRoom: () => call('host:close-room', undefined),
  getRoom: () => call('host:get-room', undefined),
  loadExam: (req) => call('host:load-exam', req),
  selectExamFile: () => call('host:select-exam-file', undefined),
  startExam: () => call('host:start-exam', undefined),
  endExam: () => call('host:end-exam', undefined),

  startDiscovery: () => call('student:start-discovery', undefined),
  stopDiscovery: () => call('student:stop-discovery', undefined),
  joinRoom: (req) => call('student:join-room', req),
  leaveRoom: () => call('student:leave-room', undefined),
  submitAnswer: (req) => call('student:submit-answer', req),
  autosaveDraft: (req) => call('student:autosave-draft', req),
  navigate: (req) => call('student:navigate', req),
  enterKiosk: () => call('student:enter-kiosk', undefined),
  markInternalCopy: (req) => call('student:internal-copy', req),
  sendTypingMetrics: (req) => call('student:typing-metrics', req),

  onRoleChanged: (listener) => subscribe('app:role-changed', listener),
  onEvent: (channel, listener) => subscribe(channel, listener)
}

contextBridge.exposeInMainWorld('ztExam', api)

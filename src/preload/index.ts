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

  docsToggle: (req) => call('exam:docs-toggle', req),
  docsNavigate: (req) => call('exam:docs-navigate', req),
  openVsCode: () => call('exam:open-vscode', undefined),
  focusExam: () => call('student:focus-exam', undefined),

  openDocPreview: (req) => call('host:open-doc-preview', req),
  closeDocPreview: () => call('host:close-doc-preview', undefined),
  listRecordedDomains: () => call('host:list-recorded-domains', undefined),
  approveDomain: (req) => call('host:approve-domain', req),
  setDomainEnforcement: (req) => call('host:set-domain-enforcement', req),

  getTriageOverview: () => call('host:get-triage-overview', undefined),
  getStudentEvidence: (req) => call('host:get-student-evidence', req),
  resolveTriage: (req) => call('host:resolve-triage', req),
  sendProctorWarning: (req) => call('host:send-proctor-warning', req),
  setStudentFreeze: (req) => call('host:set-student-freeze', req),
  exportIncidentReport: () => call('host:export-incident-report', undefined),
  exportAuditBundle: () => call('host:export-audit-bundle', undefined),

  getAttestationConfig: () => call('host:get-attestation-config', undefined),
  setAttestationEnforce: (req) => call('host:set-attestation-enforce', req),

  getScreenSources: () => call('student:screen-get-sources', undefined),
  sendScreenSegment: (req) => call('student:screen-segment', req),
  sendScreenThumbnail: (req) => call('student:screen-thumbnail', req),
  screenInspect: (req) => call('host:screen-inspect', req),
  fetchRingSegment: (req) => call('host:fetch-ring-segment', req),
  pinScreenBuffer: (req) => call('host:pin-screen-buffer', req),

  /* ---------- Dynamic Form — .ztform (Phase 6) ---------- */
  saveZtform: (req) => call('form:save-ztform', req),
  loadZtform: (req) => call('form:load-ztform', req),
  listSavedForms: () => call('host:list-saved-forms', undefined),

  /* ---------- Dynamic Form — Responses/Grading/Export (Phase 7) ---------- */
  getFormState: () => call('form:ztform-state', undefined),
  attachRoomForm: (req) => call('form:attach-room-form', req),
  getFormResponses: () => call('form:responses-get', undefined),
  formManualGrade: (req) => call('form:manual-grade', req),
  formRegradeAll: (req) => call('form:regrade-all', req),
  exportFormCsv: () => call('form:export-csv', undefined),
  saveZtresults: (req) => call('form:save-ztresults', req),
  loadZtresults: (req) => call('form:load-ztresults', req),
  openFormArtifact: (req) => call('form:artifact-open', req),

  onRoleChanged: (listener) => subscribe('app:role-changed', listener),
  onEvent: (channel, listener) => subscribe(channel, listener)
}

contextBridge.exposeInMainWorld('ztExam', api)

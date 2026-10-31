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
  getExamState: () => call('host:get-exam-state', undefined),
  getStudents: () => call('host:get-students', undefined),
  getSummaries: () => call('host:get-summaries', undefined),
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
  moduleSend: (req) => call('student:module-send', req),
  enterKiosk: () => call('student:enter-kiosk', undefined),
  exitKiosk: () => call('student:exit-kiosk', undefined),
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
  clearRecordedDomains: () => call('host:clear-recorded-domains', undefined),
  setDomainEnforcement: (req) => call('host:set-domain-enforcement', req),

  getTriageOverview: () => call('host:get-triage-overview', undefined),
  getStudentEvidence: (req) => call('host:get-student-evidence', req),
  resolveTriage: (req) => call('host:resolve-triage', req),
  sendProctorWarning: (req) => call('host:send-proctor-warning', req),
  setStudentFreeze: (req) => call('host:set-student-freeze', req),
  exportIncidentReport: () => call('host:export-incident-report', undefined),
  exportAuditBundle: () => call('host:export-audit-bundle', undefined),

  gatewayInterfaces: () => call('gateway:interfaces', undefined),
  gatewayStart: (req) => call('gateway:start', req),
  gatewayStop: () => call('gateway:stop', undefined),
  gatewayStatus: () => call('gateway:status', undefined),
  gatewayLeases: () => call('gateway:leases', undefined),
  gatewayDnsLog: () => call('gateway:dns-log', undefined),

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

  /* ---------- Code IDE — Backend / Grader / Export (Phase 10) ---------- */
  attachCodeRoomPackage: (req) => call('code-ide:attach-room-package', req),
  getCodeSubmissions: () => call('code-ide:submissions-get', undefined),
  getCodeSubmissionDetail: (req) => call('code-ide:submission-detail', req),
  codeManualGrade: (req) => call('code-ide:manual-grade', req),
  codeRegradeAll: () => call('code-ide:regrade-all', undefined),
  getCodeWorkspaceState: () => call('code-ide:workspace-state', undefined),
  setCodeWorkspaceRoot: () => call('code-ide:set-workspace-root', undefined),
  openCodeStudentFolder: (req) => call('code-ide:open-student-folder', req),
  exportCodeCsv: () => call('code-ide:export-csv', undefined),
  exportCodeBundle: () => call('code-ide:export-bundle', undefined),
  runCodePreview: (req) => call('code-ide:run-preview', req),
  probeCodeApi: (req) => call('code-ide:probe-api', req),
  queryCodeSql: (req) => call('code-ide:query-sql', req),
  saveCodeComment: (req) => call('code-ide:comment-save', req),
  listCodeComments: (req) => call('code-ide:comment-list', req),

  /* ---------- Code IDE — Local Runtime (Phase 9) ---------- */
  runCliTest: (req) => call('code-ide:run-cli', req),
  cacheStudentBundles: (req) => call('code-ide:cache-student-bundles', req),
  studentDepsStatus: (req) => call('code-ide:student-deps-status', req),
  installStudentDeps: (req) => call('code-ide:install-student-deps', req),
  runSqlTest: (req) => call('code-ide:run-sql', req),
  checkRuntimes: (req) => call('code-ide:check-runtimes', req),
  browseSdkPath: (req) => call('code-ide:browse-sdk-path', req),
  addSdkPath: (req) => call('code-ide:add-sdk-path', req),

  onRoleChanged: (listener) => subscribe('app:role-changed', listener),
  onEvent: (channel, listener) => subscribe(channel, listener)
}

contextBridge.exposeInMainWorld('ztExam', api)

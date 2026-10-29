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
  moduleSend(req: IpcInvokeMap['student:module-send']['req']): Promise<IpcInvokeMap['student:module-send']['res']>
  enterKiosk(): Promise<KioskEnterResponse>
  /* ---------- Guard (Phase 3a) ---------- */
  markInternalCopy(req: IpcInvokeMap['student:internal-copy']['req']): Promise<StudentSubmitResponse>
  sendTypingMetrics(req: IpcInvokeMap['student:typing-metrics']['req']): Promise<StudentSubmitResponse>
  /* ---------- Mode 2 / Mode 3 (Phase 5) ---------- */
  docsToggle(req: IpcInvokeMap['exam:docs-toggle']['req']): Promise<IpcInvokeMap['exam:docs-toggle']['res']>
  docsNavigate(req: IpcInvokeMap['exam:docs-navigate']['req']): Promise<IpcInvokeMap['exam:docs-navigate']['res']>
  openVsCode(): Promise<IpcInvokeMap['exam:open-vscode']['res']>
  focusExam(): Promise<IpcInvokeMap['student:focus-exam']['res']>
  /* ---------- Doc Preview & Domain Allowlist (Phase 3a-plus) ---------- */
  openDocPreview(req: IpcInvokeMap['host:open-doc-preview']['req']): Promise<IpcInvokeMap['host:open-doc-preview']['res']>
  closeDocPreview(): Promise<IpcInvokeMap['host:close-doc-preview']['res']>
  listRecordedDomains(): Promise<IpcInvokeMap['host:list-recorded-domains']['res']>
  approveDomain(req: IpcInvokeMap['host:approve-domain']['req']): Promise<IpcInvokeMap['host:approve-domain']['res']>
  setDomainEnforcement(req: IpcInvokeMap['host:set-domain-enforcement']['req']): Promise<IpcInvokeMap['host:set-domain-enforcement']['res']>
  /* ---------- Audit Hash Chain & Triage (Phase 3b) ---------- */
  getTriageOverview(): Promise<IpcInvokeMap['host:get-triage-overview']['res']>
  getStudentEvidence(req: IpcInvokeMap['host:get-student-evidence']['req']): Promise<IpcInvokeMap['host:get-student-evidence']['res']>
  resolveTriage(req: IpcInvokeMap['host:resolve-triage']['req']): Promise<IpcInvokeMap['host:resolve-triage']['res']>
  sendProctorWarning(req: IpcInvokeMap['host:send-proctor-warning']['req']): Promise<IpcInvokeMap['host:send-proctor-warning']['res']>
  setStudentFreeze(req: IpcInvokeMap['host:set-student-freeze']['req']): Promise<IpcInvokeMap['host:set-student-freeze']['res']>
  exportIncidentReport(): Promise<IpcInvokeMap['host:export-incident-report']['res']>
  exportAuditBundle(): Promise<IpcInvokeMap['host:export-audit-bundle']['res']>
  /* ---------- Attestation (Phase 4) ---------- */
  getAttestationConfig(): Promise<IpcInvokeMap['host:get-attestation-config']['res']>
  setAttestationEnforce(req: IpcInvokeMap['host:set-attestation-enforce']['req']): Promise<IpcInvokeMap['host:set-attestation-enforce']['res']>
  /* ---------- Screen Monitoring (Phase 3c) ---------- */
  getScreenSources(): Promise<IpcInvokeMap['student:screen-get-sources']['res']>
  sendScreenSegment(req: IpcInvokeMap['student:screen-segment']['req']): Promise<IpcInvokeMap['student:screen-segment']['res']>
  sendScreenThumbnail(req: IpcInvokeMap['student:screen-thumbnail']['req']): Promise<IpcInvokeMap['student:screen-thumbnail']['res']>
  screenInspect(req: IpcInvokeMap['host:screen-inspect']['req']): Promise<IpcInvokeMap['host:screen-inspect']['res']>
  fetchRingSegment(req: IpcInvokeMap['host:fetch-ring-segment']['req']): Promise<IpcInvokeMap['host:fetch-ring-segment']['res']>
  pinScreenBuffer(req: IpcInvokeMap['host:pin-screen-buffer']['req']): Promise<IpcInvokeMap['host:pin-screen-buffer']['res']>
  /* ---------- Dynamic Form — .ztform (Phase 6) ---------- */
  saveZtform(req: IpcInvokeMap['form:save-ztform']['req']): Promise<IpcInvokeMap['form:save-ztform']['res']>
  loadZtform(req: IpcInvokeMap['form:load-ztform']['req']): Promise<IpcInvokeMap['form:load-ztform']['res']>
  listSavedForms(): Promise<IpcInvokeMap['host:list-saved-forms']['res']>
  /* ---------- Dynamic Form — Responses/Grading/Export (Phase 7) ---------- */
  getFormState(): Promise<IpcInvokeMap['form:ztform-state']['res']>
  attachRoomForm(req: IpcInvokeMap['form:attach-room-form']['req']): Promise<IpcInvokeMap['form:attach-room-form']['res']>
  getFormResponses(): Promise<IpcInvokeMap['form:responses-get']['res']>
  formManualGrade(req: IpcInvokeMap['form:manual-grade']['req']): Promise<IpcInvokeMap['form:manual-grade']['res']>
  formRegradeAll(req: IpcInvokeMap['form:regrade-all']['req']): Promise<IpcInvokeMap['form:regrade-all']['res']>
  exportFormCsv(): Promise<IpcInvokeMap['form:export-csv']['res']>
  saveZtresults(req: IpcInvokeMap['form:save-ztresults']['req']): Promise<IpcInvokeMap['form:save-ztresults']['res']>
  loadZtresults(req: IpcInvokeMap['form:load-ztresults']['req']): Promise<IpcInvokeMap['form:load-ztresults']['res']>
  openFormArtifact(req: IpcInvokeMap['form:artifact-open']['req']): Promise<IpcInvokeMap['form:artifact-open']['res']>
  /* ---------- Code IDE — Backend / Grader / Export (Phase 10) ---------- */
  attachCodeRoomPackage(req: IpcInvokeMap['code-ide:attach-room-package']['req']): Promise<IpcInvokeMap['code-ide:attach-room-package']['res']>
  getCodeSubmissions(): Promise<IpcInvokeMap['code-ide:submissions-get']['res']>
  getCodeSubmissionDetail(req: IpcInvokeMap['code-ide:submission-detail']['req']): Promise<IpcInvokeMap['code-ide:submission-detail']['res']>
  codeManualGrade(req: IpcInvokeMap['code-ide:manual-grade']['req']): Promise<IpcInvokeMap['code-ide:manual-grade']['res']>
  codeRegradeAll(): Promise<IpcInvokeMap['code-ide:regrade-all']['res']>
  getCodeWorkspaceState(): Promise<IpcInvokeMap['code-ide:workspace-state']['res']>
  setCodeWorkspaceRoot(): Promise<IpcInvokeMap['code-ide:set-workspace-root']['res']>
  openCodeStudentFolder(req: IpcInvokeMap['code-ide:open-student-folder']['req']): Promise<IpcInvokeMap['code-ide:open-student-folder']['res']>
  exportCodeCsv(): Promise<IpcInvokeMap['code-ide:export-csv']['res']>
  exportCodeBundle(): Promise<IpcInvokeMap['code-ide:export-bundle']['res']>
  runCodePreview(req: IpcInvokeMap['code-ide:run-preview']['req']): Promise<IpcInvokeMap['code-ide:run-preview']['res']>
  probeCodeApi(req: IpcInvokeMap['code-ide:probe-api']['req']): Promise<IpcInvokeMap['code-ide:probe-api']['res']>
  queryCodeSql(req: IpcInvokeMap['code-ide:query-sql']['req']): Promise<IpcInvokeMap['code-ide:query-sql']['res']>
  saveCodeComment(req: IpcInvokeMap['code-ide:comment-save']['req']): Promise<IpcInvokeMap['code-ide:comment-save']['res']>
  listCodeComments(req: IpcInvokeMap['code-ide:comment-list']['req']): Promise<IpcInvokeMap['code-ide:comment-list']['res']>
  /* ---------- Code IDE — Local Runtime (Phase 9: รันบนเครื่องตัวเอง) ---------- */
  runCliTest(req: IpcInvokeMap['code-ide:run-cli']['req']): Promise<IpcInvokeMap['code-ide:run-cli']['res']>
  runSqlTest(req: IpcInvokeMap['code-ide:run-sql']['req']): Promise<IpcInvokeMap['code-ide:run-sql']['res']>
  checkRuntimes(req: IpcInvokeMap['code-ide:check-runtimes']['req']): Promise<IpcInvokeMap['code-ide:check-runtimes']['res']>
  browseSdkPath(req: IpcInvokeMap['code-ide:browse-sdk-path']['req']): Promise<IpcInvokeMap['code-ide:browse-sdk-path']['res']>
  addSdkPath(req: IpcInvokeMap['code-ide:add-sdk-path']['req']): Promise<IpcInvokeMap['code-ide:add-sdk-path']['res']>
  /* ---------- Event subscribe (คืน unsubscribe() กัน memory leak ใน React) ---------- */
  onRoleChanged(listener: (event: RoleChangedEvent) => void): Unsubscribe
  onEvent<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventMap[C]) => void
  ): Unsubscribe
}

// เผื่อ typing ของผู้เรียก: รูปแบบ event ทั้งหมด
export type { RoomsUpdatedEvent, StudentsUpdatedEvent }

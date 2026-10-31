import { app, BrowserWindow, clipboard, powerMonitor, safeStorage, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pbkdf2Sync } from 'node:crypto'
import { IpcEventSchemas, type IpcEventChannel } from '@shared/ipc-channels'
import { NetMsgType } from '@shared/protocol-schema'
import { applyRuntimeArgPolicy, parseRuntimeArgs, type RuntimeArgPolicy } from './runtime-args'
import { loadDeploymentConfig } from './deployment-config'
import { ReconnectTokenStore } from './network/token-store'
import { IpcRouter, createElectronIpcRegistrar } from './ipc/router'
import { registerAppHandlers, type AppRuntimeState } from './ipc/app-handlers'
import { registerNetworkHandlers, forwardConnectionState } from './ipc/network-handlers'
import {
  registerExamHandlers,
  createStudentExamEventForwarder,
  makeKioskHooks
} from './ipc/exam-handlers'
import { registerDomainHandlers } from './ipc/domain-handlers'
import { registerAuditHandlers } from './ipc/audit-handlers'
import { registerScreenHandlers } from './ipc/screen-handlers'
import { registerAttestationHandlers } from './ipc/attestation-handlers'
import { registerDeviceEnrollmentHandlers } from './ipc/device-handlers'
import { registerModeHandlers } from './ipc/mode-handlers'
import { registerDynamicFormHandlers } from './ipc/dynamic-form-handlers'
import { registerFormResponseHandlers } from './ipc/form-response-handlers'
import { registerCodeIdeHandlers } from './ipc/code-ide-handlers'
import { registerCodeIdeHostHandlers } from './ipc/code-ide-host-handlers'
import { registerGatewayHandlers } from './ipc/gateway-handlers'
import { GatewayService } from './network/gateway/gateway-service'
import { ModuleTransportHost, registerModuleTransportStudentHandlers } from './network/module-transport'
import type { CodeIdeHostService } from '@modules/code-ide/main/code-host-service'
import { CodeIdeHostService as CodeIdeHostServiceImpl } from '@modules/code-ide/main/code-host-service'
import type { FormHostService } from '@modules/dynamic-form/main/form-host-service'
import { FormHostService as FormHostServiceImpl } from '@modules/dynamic-form/main/form-host-service'
import '@modules/register-modules'
import { DocsViewController, type DocsPanelState } from './browser/docs-view'
import { LocalConnectProxy } from './proxy/connect-proxy'
import { VsCodeController } from './guard/vscode-controller'
import { DomainAllowlistService } from './host/domain-allowlist'
import { DocPreviewController } from './host/doc-preview'
import { TriageService } from './host/triage-service'
import { ProctorViewService } from './screen/proctor-view-service'
import { ScreenStreamController } from './screen/stream-controller'
import { createMainWindow, createFloatingHudWindow, enforceKioskInputBlocking } from './window'
import { HostDatabase, getDefaultDatabasePath } from './storage/db'
import { HostRoomManager } from './network/host-room'
import { RoomDiscoveryListener } from './network/discovery'
import { ExamTlsClient } from './network/tls-client'
import { CoreSessionManager } from './host/core-session-manager'
import { GuardEngine } from './guard/guard-engine'
import { HardwareVmGuard } from './guard/hardware-vm-guard'
import { TypingMonitor } from './guard/typing-monitor'
import { signedOrDevEnv } from './policy-env'
import { makeDetectionEvent } from './guard/process-inspector'
import type { DetectionEvent } from '@shared/policy-schema'
import { NativeKeyboardGuard, resolveNativeAddonPath } from './guard/native-bridge'
import type { RuntimeBinding } from '@shared/attestation-schema'
import { AttestationResponder } from './attestation/client-responder'
import { AttestationHostService, type AttestationFailure } from './attestation/host-verifier'
import { ensureLocalManifestSnapshot } from './attestation/manifest'
import { deviceKeyFilePath, loadOrCreateDeviceIdentity } from './attestation/device-key'
import {
  buildDeviceRosterLookup,
  emptyDeviceRosterLookup,
  loadDeviceRoster,
  type DeviceRosterLookup
} from './attestation/device-roster'
import { setNativeDeviceSeed } from './attestation/native-attestation'
import { trustedKeyPemSet } from './attestation/trusted-keys'
import { DeviceEnrollmentService } from './host/device-enrollment'
import { inspectLaunch, describeFindings, isAllowedInDev, type LaunchFinding } from './guard/launch-guard'
import { applyProcessMitigations } from './guard/process-mitigations'

/* ============================================================
 * Phase 4 — Launch Guard: วิ่งเป็นบรรทัดแรกสุด (ก่อนสิ่งใด ๆ ของแอป)
 * Production: พบ flag/env อันตราย → ปฏิเสธการรันทันที (fail-closed)
 * ============================================================ */
const IS_PACKAGED = app.isPackaged
const IS_DEV_BUILD = !IS_PACKAGED
const rawLaunchFindings = inspectLaunch({
  argv: process.argv.slice(1),
  execArgv: process.execArgv,
  env: process.env,
  hasChromiumSwitch: (name) => {
    try {
      return app.commandLine.hasSwitch(name)
    } catch {
      return false
    }
  }
})
const launchFindings: LaunchFinding[] = rawLaunchFindings.filter((finding) => !(IS_DEV_BUILD && isAllowedInDev(finding)))
if (launchFindings.length > 0) {
  console.error(`[launch-guard] พบสภาพแวดล้อมอันตราย: ${describeFindings(launchFindings)}`)
  if (!IS_DEV_BUILD) {
    // ห้ามเปิดหน้าโหมดนักเรียน/เครื่องแม่ที่ถูกแก้ CLI (เช่น --remote-debugging-port, ELECTRON_RUN_AS_NODE)
    app.exit(1)
  }
}

/**
 * VULN-01/05: ใช้ OS process mitigation policies ตั้งแต่ต้น boot (Windows)
 * - ต้องทำก่อนเปิดพื้นผิวที่รับข้อมูลจากภายนอก
 * - dev ไม่ทำ เพื่อไม่รบกวน debugger/hot reload
 */
const processMitigationResult = IS_PACKAGED ? applyProcessMitigations() : null
if (processMitigationResult && processMitigationResult.failed.length > 0) {
  console.warn(`[mitigation] ใช้ไม่สำเร็จ: ${processMitigationResult.failed.join(', ')}`)
}

/**
 * VULN-38: ปิด accessibility tree ระหว่างแอปสอบ
 * (ค่าเริ่มต้นของ Electron เปิดเมื่อตรวจพบ screen reader — ช่องอ่านโจทย์ผ่าน UIA)
 */
try {
  app.setAccessibilitySupportEnabled(false)
} catch {
  // บางแพลตฟอร์ม/ช่วงเวลายังตั้งไม่ได้ — guard ยังรายงานสถานะจริง
}
try {
  app.commandLine.appendSwitch('disable-renderer-accessibility')
} catch {
  // switch ถูกตั้งไปแล้ว/ไม่รองรับ — ข้าม
}

/** โหมดบังคับตรวจลายเซ็นจริงแม้ใน dev (env หรือสวิตช์จากหน้าตั้งค่าห้องสอบ) */
const attestationStrictToggle = { enforced: process.env.ZTEXAM_STRICT_ATTESTATION === '1' }

/* ---------- จัดการ isolation ของ multi-instance ก่อนพร้อมใช้งาน ---------- */
/**
 * config ที่ลงลายเซ็น (ถ้ามี) — ใช้แทน env ที่ผู้ใช้แก้เองได้
 * VULN-42: production รับเฉพาะไฟล์ใต้ resources (ไม่รับ path จาก env)
 */
const deploymentConfigPath = IS_PACKAGED
  ? (process.resourcesPath ? path.join(process.resourcesPath, 'deployment.json') : null)
  : (process.env.ZTEXAM_DEPLOYMENT_CONFIG ?? null)
const deploymentConfig = loadDeploymentConfig(deploymentConfigPath)

function envProfileAllowlist(): readonly string[] | undefined {
  const raw = process.env.ZTEXAM_ALLOWED_PROFILES
  if (raw === undefined) return undefined
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

const runtimePolicy: RuntimeArgPolicy = { production: IS_PACKAGED }
const allowedProfiles = signedOrDevEnv(
  IS_PACKAGED,
  deploymentConfig?.allowedProfiles,
  envProfileAllowlist()
)
if (allowedProfiles !== undefined) runtimePolicy.allowedProfiles = allowedProfiles
if (deploymentConfig?.allowedRoles !== undefined) {
  runtimePolicy.allowedRoles = deploymentConfig.allowedRoles
}
if (deploymentConfig?.lockedRole !== undefined) {
  runtimePolicy.lockedRole = deploymentConfig.lockedRole
}
const allowWindowedKiosk =
  deploymentConfig?.allowWindowedKiosk ??
  (!IS_PACKAGED && process.env.ZTEXAM_ALLOW_WINDOWED_KIOSK === '1')
if (allowWindowedKiosk) runtimePolicy.allowWindowedKiosk = true

const runtime = applyRuntimeArgPolicy(parseRuntimeArgs(process.argv), runtimePolicy)
const defaultUserData = app.getPath('userData')
// แยก userData ต่อ profile เพื่อไม่ให้ cache/cookies/SQLite ของ host กับ student ชนกัน
app.setPath('userData', path.join(defaultUserData, `instance-${runtime.profileId}`))

// ล็อก single-instance ต่อ profile (เปิด host + student พร้อมกันในเครื่องเดียวได้ แต่ profile เดียวกันซ้ำไม่ได้)
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const state: AppRuntimeState = {
  profileId: runtime.profileId,
  role: runtime.role
}
if (deploymentConfig?.lockedRole !== undefined) {
  state.lockedRole = deploymentConfig.lockedRole
}

let mainWindow: BrowserWindow | null = null
let hostDb: HostDatabase | null = null
let roomManager: HostRoomManager | null = null
let sessionManager: CoreSessionManager | null = null
let domainAllowlist: DomainAllowlistService | null = null
let docPreview: DocPreviewController | null = null
let triageService: TriageService | null = null
let gatewayService: GatewayService | null = null
let proctorViewService: ProctorViewService | null = null
let screenStreamController: ScreenStreamController | null = null
let discovery = new RoomDiscoveryListener()
let studentClient: ExamTlsClient | null = null
let docsViewController: DocsViewController | null = null
let vsCodeController: VsCodeController | null = null
let connectProxy: LocalConnectProxy | null = null
let floatingHudWindow: BrowserWindow | null = null
let guardEngine: GuardEngine | null = null
/** VULN-50: unsubscribe display listeners */
let displayUnsubscribe: (() => void) | null = null
/** VULN-51/52: host-side screen liveness */
let screenLivenessTimer: NodeJS.Timeout | null = null
const reportedStaleScreen = new Set<string>()
let typingMonitor: TypingMonitor | null = null
let nativeKeyboardGuard: NativeKeyboardGuard | null = null
let attestationResponder: AttestationResponder | null = null
let attestationHost: AttestationHostService | null = null
/** deviceId ของเครื่องนี้ (per-device key ที่ลงทะเบียนใน roster) */
let currentDeviceId: string | null = null
/** public key ของเครื่องนี้ (แนบไปกับ attestation เพื่อ enroll ครั้งแรก) */
let currentDevicePublicKey: string | null = null
/** host: lookup public key จาก signed device roster */
let deviceRosterLookup: DeviceRosterLookup | null = null
/** host: มี signed roster ที่ configure แล้วหรือไม่ (strict mode = ไม่ auto-enroll) */
let deviceRosterStrict = false
/** host: TOFU enrollment store (SQLite) */
let deviceEnrollmentService: DeviceEnrollmentService | null = null
/** IP เครื่องแม่จากการ join ล่าสุด (NetworkInspector ยกเว้นเฉพาะพอร์ตสอบ) */
let lastJoinedHostIp: string | null = null
/** พอร์ต TLS ของห้องสอบที่ join ล่าสุด (null = ยังไม่รู้) */
let lastJoinedHostPort: number | null = null
/** Room ID ที่เข้าล่าสุด (ring buffer ใช้ตั้งชื่อโฟลเดอร์ชั่วคราว — Phase 3c) */
let lastJoinedRoomId: string | null = null
/** สถานะออนไลน์รอบก่อนของแต่ละคน (ใช้ตรวจการเปลี่ยนสถานะ) */
const studentOnlineState = new Map<string, boolean>()
/** นักเรียนที่ตรวจพบ client ซ้ำตอน lobby — freeze ทันทีเมื่อเริ่มสอบ (studentId → reason/event) */
const pendingDuplicateClientFreezes = new Map<string, { reason: string; event: DetectionEvent }>()
/** ช่วงสอบฝั่งนักเรียนกำลังทำงานอยู่หรือไม่ (ใช้ตัดสินว่าจะรายงาน focus หรือไม่) */
let studentExamRunning = false
let studentExamMode: 'closed' | 'in-app-docs' | 'external-tools' = 'closed'
let blurStartedAtMs = 0
let blurBriefTimer: NodeJS.Timeout | null = null
let blurProlongedTimer: NodeJS.Timeout | null = null

/** late-bound hook: เรียกเมื่อนักเรียน reconnect/handshake สำเร็จ */
let studentEstablishedHandler: ((studentId: string) => void) | null = null

function ensureHostDatabase(): HostDatabase {
  hostDb ??= new HostDatabase({ filePath: getDefaultDatabasePath(app.getPath('userData')) })
  return hostDb
}

function ensureSessionManager(): CoreSessionManager {
  sessionManager ??= new CoreSessionManager({
    db: ensureHostDatabase(),
    getRoom: () => roomManager,
    sendHostEvent: sendEventToWindow,
    disconnectFreezeMs: resolveDisconnectFreezeMs(),
    onAnomaly: (source, reason) => {
      // Phase 3b: anomaly ของ exam (cursor ผิด / ข้อความแปลกปลอม) ลง audit hash chain ด้วย
      console.warn(`[exam-anomaly] ${source ?? '?'}: ${reason}`)
      try {
        ensureTriageService().recordHostEvent(
          source,
          'HOST_ANOMALY_DETECTED',
          'warning',
          `พฤติกรรมน่าสงสัยจากระบบข้อสอบ: ${reason}`,
          { reason, source: source ?? 'HOST' },
          10
        )
      } catch {
        // ยังไม่มีห้อง/chain — แสดง log อย่างเดียวพอ
      }
    },
    // Phase 3a-plus: โดเมนที่ครูอนุมัติ + พฤติกรรมเตือน/บล็อก จากการ์ดเตรียมเอกสาร
    getAllowedDomains: () => {
      const roomId = roomManager?.room?.roomId
      return roomId ? ensureDomainAllowlist().listApproved(roomId) : []
    },
    getDomainEnforcement: () => ensureDomainAllowlist().resolveDomainEnforcement(roomManager?.room?.roomId ?? null),
    // Phase 5 (Mode 2): docsUrl จากการเตรียมเอกสาร → EXAM_STARTED
    getDocsStartUrl: () => ensureDocPreview().getLastUrl(roomManager?.room?.roomId ?? null),
    // Phase 5: ประวัติโดเมนอนุญาต (docs/proxy) → hash chain 'normal' ไม่มีผล triage
    onDocsUrlLog: (studentId, payload) => {
      try {
        const triage = ensureTriageService()
        const roomId = triage.roomId
        if (!roomId) return
        triage.audit.append(roomId, {
          studentId,
          eventCode: 'DOCS_URL_VISITED',
          category: 'docs',
          severity: 'normal',
          scoreDelta: 0,
          summaryText: `ใช้เว็บที่อนุญาตตามขอบเขตข้อสอบ: ${payload.topDomain}`,
          evidence: { url: payload.url.slice(0, 300), source: payload.source, topDomain: payload.topDomain },
          clientTimestampMs: payload.occurredAtMs
        })
        triage.pushOverview()
      } catch {
        // chain ยังไม่พร้อม (ยังไม่เริ่มสอบ) — ข้าม
      }
    },
    // Phase 3b: ท่อข้อมูลตรวจจับ → hash chain + triage
    onDetectionBatch: (studentId, events) => {
      try {
        ensureTriageService().recordStudentEvents(studentId, events)
      } catch {
        // chain ยังไม่พร้อม (ยังไม่เริ่มสอบ) — ยังส่ง event ให้ renderer อยู่แล้ว
      }
      // Phase 3c: Pin-on-Critical — เหตุการณ์วิกฤต → ล็อกเซกเมนต์รอบเหตุทันที
      for (const event of events) {
        if (event.severity !== 'critical') continue
        roomManager?.tlsServerInstance?.sendToStudent(studentId, NetMsgType.pinRingSegments, {
          eventId: event.eventId,
          timestampMs: event.occurredAtMs
        })
      }
    },
    onExamStarted: (roomId, policy) => {
      ensureTriageService().startRoom(roomId, policy)
      // client ซ้ำที่ตรวจพบตอน lobby → freeze รอครูตรวจทันทีที่เริ่มสอบ
      for (const [studentId, pending] of pendingDuplicateClientFreezes) {
        try {
          ensureTriageService().recordStudentEvents(studentId, [pending.event])
          ensureTriageService().setFrozen(studentId, true, pending.reason)
        } catch {
          // ครูยังเห็น event ใน triage และปลด/จัดการได้
        }
      }
      pendingDuplicateClientFreezes.clear()
      // VULN-51/52: เฝ้าหลักฐานหน้าจอฝั่ง host ตลอดการสอบ
      startScreenLivenessMonitor()
      // Phase 2 (ท่อกลาง modules): ดัน stripped code-ide package ให้ทุกคนตอนเริ่มสอบ
      pushCodeIdePackageToStudents(roomId)
      // F-1: ดัน stripped form view รายคน (ลำดับข้อ/ตัวเลือกของตัวเอง) ตอนเริ่มสอบ
      pushFormViewToStudents(roomId)
      // Phase 4: เริ่มสุ่มตรวจ attestation ตลอดการสอบ (45–120 วินาที/รอบ)
      ensureAttestationHostService().startExam(
        ensureRoomManager().students.map((student) => student.studentId)
      )
    },
    onExamEnded: (roomId, reason) => {
      stopScreenLivenessMonitor()
      pendingDuplicateClientFreezes.clear()
      ensureTriageService().endRoom(roomId, reason)
      // F-2: finalize โมดูลที่ผูกไว้ (เลื่อน draft ค้างเป็น submission + ปั๊มสถานะ)
      try {
        finalizeModuleSessions(roomId)
      } catch {
        /* finalize ล้มเหลว — คำตอบที่ ingest แล้วใน DB ยังอยู่ */
      }
      // Phase 4: จบการสอบ → หยุดตรวจ attestation (เคลียร์ timer ทั้งหมด)
      attestationHost?.stop()
      attestationHost = null
    },
    // Phase 3c: รายการเซกเมนต์ย้อนหลังจากนักเรียน → ProctorViewService
    onStudentNetMessage: (studentId, type, payload) => {
      // Phase 2 (ท่อกลาง modules): action/autosave/chunks ของ pluggable modules ก่อน
      if (ensureModuleTransport().handleStudentMessage(studentId, type, payload)) return true
      if (type === NetMsgType.ringSegmentList) {
        ensureProctorViewService().ingestSegmentList(studentId, payload)
        return true
      }
      // Phase 3c (UDP): นักเรียนประกาศตำแหน่งช่องทาง UDP สตรีมหน้าจอ
      if (type === NetMsgType.screenUdpRegister) {
        ensureProctorViewService().handleUdpRegister(studentId, payload)
        return true
      }
      // Phase 4: คำตอบ attestation ของเครื่องนักเรียน (HMAC ผูกกับ TLS exporter)
      if (type === NetMsgType.attestationResponse) {
        ensureAttestationHostService().handleResponse(studentId, payload)
        return true
      }
      return false
    },
    // Phase 3c (UDP): พอร์ต UDP ของเครื่องแม่ + จับคู่กุญแจ UDP ต่อ SCREEN_SESSION
    getScreenUdpPort: () => ensureProctorViewService().getUdpPort(),
    onScreenSessionSent: (studentId, screenBufferKey) => {
      ensureProctorViewService().noteScreenSession(studentId, screenBufferKey)
    }
  })
  return sessionManager
}

function ensureDomainAllowlist(): DomainAllowlistService {
  domainAllowlist ??= new DomainAllowlistService(ensureHostDatabase())
  return domainAllowlist
}

/** Phase 7: Backend ของโมดูล dynamic-form ฝังใน Electron Main ของเครื่องแม่ */
let formHostService: FormHostService | null = null
function ensureFormHostService(): FormHostService {
  formHostService ??= new FormHostServiceImpl(
    ensureHostDatabase(),
    (roomId) => {
      const row = ensureHostDatabase()
        .db.prepare('SELECT crypto_salt FROM exam_sessions WHERE id = ?')
        .get(roomId) as { crypto_salt: string } | undefined
      const salt = row?.crypto_salt ?? roomId
      return pbkdf2Sync(salt, roomId, 10_000, 32, 'sha256')
    },
    path.join(app.getPath('userData'), 'exam-vault')
  )
  return formHostService
}

/** Phase 10: Backend ของโมดูล code-ide ฝังใน Electron Main ของเครื่องแม่ */
let codeIdeHostService: CodeIdeHostService | null = null
function ensureCodeIdeService(): CodeIdeHostService {
  codeIdeHostService ??= new CodeIdeHostServiceImpl(
    ensureHostDatabase(),
    (roomId) => {
      const row = ensureHostDatabase()
        .db.prepare('SELECT crypto_salt FROM exam_sessions WHERE id = ?')
        .get(roomId) as { crypto_salt: string } | undefined
      const salt = row?.crypto_salt ?? roomId
      return pbkdf2Sync(salt, roomId, 10_000, 32, 'sha256')
    }
  )
  return codeIdeHostService
}

/** Phase 3b: Audit hash chain + Triage engine ของเครื่องแม่ */
function ensureTriageService(): TriageService {
  triageService ??= new TriageService({
    db: ensureHostDatabase(),
    getRoom: () => roomManager,
    sendHostEvent: sendEventToWindow
  })
  return triageService
}

/**
 * Security item 2: host-as-gateway (DHCP + DNS sinkhole + posture)
 * - ไม่ auto-start — ครูต้องกดเปิดเองในหน้าตั้งค่าห้อง
 * - DNS ที่ถูกบล็อกไหลเข้า triage/audit chain; ทุก query ยัง push ไปหน้า host
 */
function ensureGatewayService(): GatewayService {
  gatewayService ??= new GatewayService({
    getRole: () => state.role,
    onStatus: (status) => sendEventToWindow('gateway:status-changed', status),
    onDnsQuery: (entry) => {
      sendEventToWindow('gateway:dns-query', entry)
      if (entry.allowed) return
      try {
        ensureTriageService().recordHostEvent(
          null,
          'GATEWAY_DNS_BLOCKED',
          'warning',
          `DNS ถูกบล็อกที่ gateway: ${entry.domain}`,
          {
            domain: entry.domain,
            clientIp: entry.clientIp,
            qtype: String(entry.qtype),
            action: entry.action
          },
          5
        )
      } catch {
        // ยังไม่มีห้อง/chain — in-memory log + renderer event ยังอยู่
      }
    },
    onAudit: (eventCode, summaryText, evidence) => {
      try {
        ensureTriageService().recordHostEvent('HOST', eventCode, 'normal', summaryText, evidence, 0)
      } catch {
        console.info(`[gateway-audit-fallback] ${eventCode}: ${summaryText}`)
      }
    }
  })
  return gatewayService
}

/** Phase 2 (ท่อกลาง MODULE_PACKET_ENVELOPE — สเปคมีแต่เพิ่งมีโค้ด): รับส่ง action/autosave ของ modules ผ่าน LAN */
let moduleTransport: ModuleTransportHost | null = null
function ensureModuleTransport(): ModuleTransportHost {
  moduleTransport ??= new ModuleTransportHost({
    getRoomId: () => roomManager?.room?.roomId ?? null,
    sendToStudent: (studentId, type, payload) => {
      roomManager?.tlsServerInstance?.sendToStudent(studentId, type, payload)
    },
      handleModuleMessage: async ({ roomId, studentId, moduleId, kind, payloadJson, serverTimestampMs }) => {
        // VULN-57: module action/autosave ต้องผ่าน gate freeze/หมดเวลาเหมือน SUBMIT_ANSWER
        const gate = ensureSessionManager().canAcceptModuleSubmission(studentId)
        if (!gate.ok) return { ok: false, reason: gate.reason }
        if (moduleId === 'code-ide') {
          return ensureCodeIdeService().ingestViaTransport({
            roomId,
            studentId,
            kind,
            payloadJson,
            serverTimestampMs
          })
        }
        if (moduleId === 'dynamic-form') {
          return ensureFormHostService().ingestViaTransport({
            roomId,
            studentId,
            kind,
            payloadJson,
            serverTimestampMs
          })
        }
        return { ok: false, reason: 'UNKNOWN_MODULE' }
      }
  })
  return moduleTransport
}

/** ดัน stripped package view ให้เครื่องนักเรียนทุกคนตอนเริ่มสอบ (host → student) */
function pushCodeIdePackageToStudents(roomId: string): void {
  try {
    const service = ensureCodeIdeService()
    const ctx = service.getRoomPackage(roomId)
    if (!ctx) return
    const view = service.studentViewFor(roomId)
    if (!view) return
    const stateJson = JSON.stringify(view)
    const students = ensureRoomManager().students
    for (const s of students) {
      if (!s.online) continue
      roomManager?.tlsServerInstance?.sendToStudent(s.studentId, NetMsgType.moduleStatePush, {
        moduleId: 'code-ide',
        stateJson
      })
    }
  } catch {
    /* push ไม่ได้ — นักเรียนจะเห็นห้องว่างแล้วแจ้งครู */
  }
}

/** F-1: ดัน stripped form view รายคนให้เครื่องนักเรียนทุกคนตอนเริ่มสอบ (host → student) */
function pushFormViewToStudents(roomId: string): void {
  try {
    const service = ensureFormHostService()
    if (!service.getRoomForm(roomId)) return
    const students = ensureRoomManager().students
    for (const s of students) {
      if (!s.online) continue
      const view = service.studentViewFor(roomId, s.studentId)
      if (!view) continue
      roomManager?.tlsServerInstance?.sendToStudent(s.studentId, NetMsgType.moduleStatePush, {
        moduleId: 'dynamic-form',
        stateJson: JSON.stringify(view)
      })
    }
  } catch {
    /* push ไม่ได้ — นักเรียนทำได้เฉพาะข้อสอบหลัก แล้วแจ้งครู */
  }
}

/**
 * F-2: จบสอบ — finalize โมดูลที่ผูกไว้กับห้อง
 * - code-ide: เลื่อน draft ค้างที่ยังไม่เคยส่งเป็น submission แล้วเข้าคิวตรวจ
 * - dynamic-form: ปั๊ม endedAtMs (คำตอบรายข้อบันทึกครบแล้วตอน ingest)
 */
function finalizeModuleSessions(roomId: string): void {
  const students = ensureRoomManager().students.map((s) => s.studentId)
  if (students.length === 0) return
  try {
    if (ensureCodeIdeService().getRoomPackage(roomId)) {
      void ensureCodeIdeService().finalizeStudentSessions(roomId, students, 'time-up')
    }
  } catch {
    /* ข้าม — submission ที่ส่งแล้วใน DB ยังอยู่ */
  }
  try {
    ensureFormHostService().finalizeStudentSession(roomId)
  } catch {
    /* ข้าม */
  }
}

/** Phase 3c: บริการดูหน้าจอนักเรียน (Pull on Demand + Thumbnail store) ฝั่งเครื่องแม่ */
function ensureProctorViewService(): ProctorViewService {
  proctorViewService ??= new ProctorViewService({
    getRoom: () => roomManager,
    sendHostEvent: sendEventToWindow,
    recordScreenAudit: (studentId, eventCode, summaryText, evidence) => {
      try {
        const triage = ensureTriageService()
        const roomId = triage.roomId
        if (!roomId) return
        triage.audit.append(roomId, {
          studentId,
          eventCode,
          category: 'proctor',
          severity: 'normal',
          scoreDelta: 0,
          summaryText,
          evidence
        })
        triage.pushOverview()
      } catch {
        // chain ยังไม่พร้อม — ข้าม
      }
    }
  })
  return proctorViewService
}

/**
 * VULN-51/52: host ตรวจว่าเครื่องที่ควรส่งภาพยังส่งจริง
 * ภาพย่อถูกสุ่มส่งทุก 5-15s → เผื่อ 3 รอบ (45s) ก่อนตัดสินว่าหลักฐานขาดตอน
 */
const SCREEN_EVIDENCE_STALE_MS = 45_000

function startScreenLivenessMonitor(): void {
  if (screenLivenessTimer) return
  screenLivenessTimer = setInterval(() => {
    let stale: Array<{ studentId: string; ageMs: number }> = []
    try {
      stale = ensureProctorViewService().getStaleStudents(Date.now(), SCREEN_EVIDENCE_STALE_MS)
    } catch {
      return
    }
    const staleIds = new Set(stale.map((entry) => entry.studentId))
    for (const studentId of [...reportedStaleScreen]) {
      if (!staleIds.has(studentId)) reportedStaleScreen.delete(studentId)
    }
    for (const entry of stale) {
      if (reportedStaleScreen.has(entry.studentId)) continue
      reportedStaleScreen.add(entry.studentId)
      const event = makeDetectionEvent('SCREEN_EVIDENCE_STALE', 'screen-liveness', {
        ageMs: String(entry.ageMs)
      })
      try {
        ensureTriageService().recordStudentEvents(entry.studentId, [event])
      } catch {
        // triage ยังไม่พร้อม — เก็บไว้รอบถัดไป
        reportedStaleScreen.delete(entry.studentId)
      }
    }
  }, 5_000)
  screenLivenessTimer.unref?.()
}

function stopScreenLivenessMonitor(): void {
  if (screenLivenessTimer) clearInterval(screenLivenessTimer)
  screenLivenessTimer = null
  reportedStaleScreen.clear()
}

/** VULN-48 (Windows/macOS): lock/unlock ระหว่างสอบ = session switch */
function reportSessionSwitch(reason: string): void {
  if (state.role !== 'student' || !studentExamRunning) return
  try {
    ensureGuardEngine().pushExternalEvent(
      makeDetectionEvent('SESSION_SWITCH_DETECTED', 'power-monitor', { reason }, undefined, Date.now)
    )
  } catch {
    // guard ยังไม่พร้อม
  }
}

/** Phase 3c: ตัวควบคุมบันทึก/ส่งหน้าจอฝั่งนักเรียน */
function ensureScreenStreamController(): ScreenStreamController {
  screenStreamController ??= new ScreenStreamController({
    getClient: () => (state.role === 'student' ? studentClient : null),
    getSessionId: () => lastJoinedRoomId,
    getHostIp: () => lastJoinedHostIp,
    sendRendererEvent: sendEventToWindow,
    onStatus: (message) => console.warn(`[screen] ${message}`)
  })
  return screenStreamController
}

function ensureDocPreview(): DocPreviewController {
  docPreview ??= new DocPreviewController({
    getRoom: () => roomManager,
    allowlist: ensureDomainAllowlist(),
    sendHostEvent: sendEventToWindow
  })
  return docPreview
}

/** roster ของห้อง: signed config ก่อน แล้วค่อย env เฉพาะ dev (VULN-42) */
function resolveRoomRoster(): readonly string[] | undefined {
  if (deploymentConfig?.roster !== undefined) return deploymentConfig.roster
  if (IS_PACKAGED) return undefined
  const raw = process.env.ZTEXAM_ROSTER
  if (raw === undefined) return undefined
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

function resolveMaxReconnects(): number {
  if (deploymentConfig?.maxReconnectsPerStudent !== undefined) {
    return deploymentConfig.maxReconnectsPerStudent
  }
  if (IS_PACKAGED) return 5
  const raw = Number(process.env.ZTEXAM_MAX_RECONNECTS)
  return Number.isInteger(raw) && raw >= 0 ? raw : 5
}

function resolveDisconnectFreezeMs(): number | null {
  // null จาก signed config = ปิด freeze โดยเจตนา (ต้องแยกจาก undefined)
  if (deploymentConfig?.disconnectFreezeMs !== undefined) {
    return deploymentConfig.disconnectFreezeMs
  }
  if (IS_PACKAGED) return 30_000
  const raw = Number(process.env.ZTEXAM_DISCONNECT_FREEZE_MS)
  if (Number.isInteger(raw) && raw >= 0) return raw === 0 ? null : raw
  return 30_000
}

function ensureRoomManager(): HostRoomManager {
  const roster = resolveRoomRoster()
  roomManager ??= new HostRoomManager({
    db: ensureHostDatabase(),
    maxStudents: 60,
    ...(roster !== undefined ? { roster } : {}),
    maxReconnectsPerStudent: resolveMaxReconnects(),
    onStudentsChanged: (students) => {
      sendEventToWindow('host:students-updated', { students })
      // Phase 3b: สถานะหลุด/กลับมาเชื่อมต่อ → triage (ลำดับความสำคัญของ DISCONNECTED)
      for (const student of students) {
        const wasOnline = studentOnlineState.get(student.studentId)
        if (wasOnline === true && !student.online) {
          try {
            ensureTriageService().recordHostEvent(
              student.studentId,
              'STUDENT_LINK_LOST',
              'warning',
              'ขาดการเชื่อมต่อระหว่างการสอบ',
              { lastSeenAtMs: student.lastSeenAtMs ?? 0 },
              10
            )
          } catch {
            // chain ยังไม่พร้อม — triage ยังแสดงสถานะหลุดตามปกติ
          }
        }
        studentOnlineState.set(student.studentId, student.online)
        triageService?.setStudentConnection(student.studentId, student.online)
        // VULN-04: หลุดระหว่างสอบเกินกำหนด → CoreSessionManager สั่ง freeze อัตโนมัติ
        sessionManager?.handleStudentConnectionChange(student.studentId, student.online)
        // Phase 4: หลุดการรับ → ยก pending challenge (จะถูกท้าถามใหม่ตอน reconnect)
        if (!student.online) attestationHost?.forget(student.studentId)
      }
    },
    onRoomClosed: () => {
      sendEventToWindow('host:students-updated', { students: [] })
      studentOnlineState.clear()
      pendingDuplicateClientFreezes.clear()
      // Phase 3a-plus: เก็บกวาดของค้างของห้องเก่า (preview + ค่าทับ enforcement)
      docPreview?.close()
      ensureDomainAllowlist().setEnforcementOverride(null)
      // Phase 3c: ล้าง thumbnail store ของห้องเก่า
      proctorViewService?.clearAll()
      // Phase 4: หยุด attestation scheduler ของห้องเก่า
      attestationHost?.stop()
      attestationHost = null
      // Phase 3b: เริ่ม chain/state ใหม่เมื่อเปิดห้องถัดไป
      triageService = null
    },
    onStudentEstablished: (studentId) => {
      // deferred: session manager ยังไม่ถูกสร้าง ณ เวลา create room ก็ยังได้ (late-binding)
      studentEstablishedHandler?.(studentId)
    },
    onDuplicateClientIp: (studentId, existingStudentId, ip) => {
      const event = makeDetectionEvent('DUPLICATE_CLIENT_IP_DETECTED', 'duplicate-client-guard', {
        ip,
        otherStudentId: existingStudentId
      })
      flagDuplicateClient(studentId, event, DUPLICATE_IP_FREEZE_REASON)
    },
    // Phase 3c: binary frame (ภาพย่อ / เซกเมนต์) จากนักเรียน → ProctorViewService
    onStudentBinary: (studentId, subType, payload) => {
      const service = ensureProctorViewService()
      if (subType === 0x01) service.ingestScreenFrame(studentId, payload)
      else if (subType === 0x02) service.ingestSegmentData(studentId, payload)
    }
  })
  return roomManager
}

/** ที่เก็บโทเคนเชื่อมต่อกลับต่อ (room, student) — เข้ารหัสด้วย OS keyring ถ้ามี */
let reconnectTokenStore: ReconnectTokenStore | null = null

function ensureReconnectTokenStore(): ReconnectTokenStore {
  if (reconnectTokenStore) return reconnectTokenStore
  const sessionsDir = path.join(app.getPath('userData'), 'sessions')
  reconnectTokenStore = new ReconnectTokenStore({
    filePath: path.join(sessionsDir, 'reconnect.enc.json'),
    legacyFilePath: path.join(sessionsDir, 'reconnect.json'),
    vault: {
      encrypt: (plain) => {
        try {
          if (!safeStorage.isEncryptionAvailable()) return null
          return safeStorage.encryptString(plain).toString('base64')
        } catch {
          return null
        }
      },
      decrypt: (cipher) => {
        try {
          if (!safeStorage.isEncryptionAvailable()) return null
          return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
        } catch {
          return null
        }
      }
    }
  })
  return reconnectTokenStore
}

function loadReconnectToken(roomId: string, studentId: string): string | null {
  try {
    return ensureReconnectTokenStore().load(roomId, studentId)
  } catch {
    return null
  }
}

function saveReconnectToken(roomId: string, studentId: string, token: string): void {
  try {
    ensureReconnectTokenStore().save(roomId, studentId, token)
  } catch {
    // เขียนไม่ได้ — การเชื่อมต่อรอบนี้ยังใช้โทเคนในหน่วยความจำได้
  }
}

function ensureStudentClient(): ExamTlsClient {
  studentClient ??= new ExamTlsClient({
    getReconnectToken: loadReconnectToken,
    onReconnectToken: saveReconnectToken,
    onConnectionState: (status) => {
      if (status.state === 'closed' || status.state === 'rejected') {
        studentExamRunning = false
        clearBlurTimers()
        typingMonitor?.stop()
      }
      // Phase 4: ท่อใหม่ = exporter คนละค่า — เครื่องนักเรียนต้องส่ง manifest ใหม่หลัง reconnect
      if (status.state === 'connecting') ensureAttestationResponder(true).resetOnReconnect()
      // Phase 5: หลุดการเชื่อมต่อ → ซ่อนแผงเอกสาร (fail-closed) / กลับมาเมื่อ reconnect สำเร็จ
      docsViewController?.setHidden(status.state === 'frozen' || status.state === 'reconnecting')
      forwardConnectionState(sendEventToWindow)(status)
    },
    onBinary: (subType, payload) => {
      ensureScreenStreamController().handleBinaryFrame(subType, payload)
    },
    onMessage: createStudentExamEventForwarder(sendEventToWindow, () => mainWindow, {
      onNetMessage: (type, payload) => {
        // Phase 5: เริ่มการสอบ → เตรียมโครง Mode 2/3 (แผงเอกสาร, proxy, floating HUD)
        if (type === NetMsgType.examStarted) {
          const started = payload as { examMode?: 'closed' | 'in-app-docs' | 'external-tools'; docsUrl?: string | null }
          studentExamRunning = true
          studentExamMode = started.examMode ?? 'closed'
          clearBlurTimers()
          ensureTypingMonitor().start()
          try {
            ensureStudentClient().setExamUiState('focused', null)
          } catch {
            // client ยังไม่พร้อม — heartbeat รอบถัดไปจะอัปเดตเอง
          }
          void prepareExamModeSurface(started)
        }
        if (type === NetMsgType.stateRecovery) {
          const recovered = payload as { examMode?: 'closed' | 'in-app-docs' | 'external-tools' }
          studentExamRunning = true
          ensureTypingMonitor().start()
          if (recovered.examMode) studentExamMode = recovered.examMode
        }
        if (type === NetMsgType.timeUp || type === NetMsgType.examCompleted) {
          studentExamRunning = false
          clearBlurTimers()
          typingMonitor?.stop()
        }
        // Phase 2 (ท่อกลาง modules): ack งานที่ส่ง + state เริ่มต้นของโมดูล
        if (type === NetMsgType.moduleAck) {
          sendEventToWindow('exam:module-ack', payload)
          return true
        }
        if (type === NetMsgType.moduleStatePush) {
          sendEventToWindow('exam:module-state', payload)
          return true
        }
        // Phase 4: คำท้า attestation จากเครื่องแม่ (ผูกกับ TLS exporter ของเรา)
        if (type === NetMsgType.attestationChallenge) {
          return ensureAttestationResponder(false).handleChallengeMessage(payload)
        }
        // Phase 3c: เปิดเซสชันบันทึกหน้าจอ (คีย์จากเครื่องแม่ผ่านหน่วยความจำ)
        if (type === NetMsgType.screenSession) {
          const session = payload as {
            screenBufferKey: string
            thumbnailMinIntervalMs: number
            thumbnailMaxIntervalMs: number
          }
          if (lastJoinedRoomId) {
            ensureScreenStreamController().startSession(lastJoinedRoomId, session)
          }
          return true
        }
        // Phase 3c (UDP): เครื่องแม่ยืนยันช่องทางสตรีมหน้าจอ
        if (type === NetMsgType.screenUdpReady) {
          const ready = payload as { ok: boolean; reason?: string }
          ensureScreenStreamController().handleUdpReady(ready.ok, ready.reason)
          return true
        }
        // Phase 3c: คำสั่งหน้าจอจากเครื่องแม่ (inspect / fetch / pin)
        return ensureScreenStreamController().handleNetMessage(type, payload)
      },
      onPolicyUpdate: (policy) => {
        const sessionKey = ensureStudentClient().getSessionKey()
        if (!sessionKey) return
        const accepted = ensureGuardEngine().applyPolicy(policy, sessionKey, true)
        if (!accepted) {
          // นโยบายปลอม/หมดอายุ — ฟ้องกลับเครื่องแม่แบบชัดเจน
          console.warn('[guard] ปฏิเสธนโยบายตรวจจับที่ลายเซ็นไม่ถูกต้อง')
        }
      },
      onExamEnded: () => {
        guardEngine?.stop()
        typingMonitor?.stop()
        // Phase 3c: จบสอบ → Zero-Trace Cleanup (ลบ ring buffer + คีย์ทันที)
        screenStreamController?.stopSession('exam-ended')
        // Phase 5: ทุกพื้นผิวของ Mode 2/3 หยุดพร้อมกัน
        docsViewController?.destroy()
        vsCodeController?.stop()
        connectProxy?.close()
        connectProxy = null
        closeFloatingHud()
      }
    })
  })
  return studentClient
}

function ensureGuardEngine(): GuardEngine {
  if (guardEngine) return guardEngine
  guardEngine = new GuardEngine({
    sendToHost: (type, payload) => ensureStudentClient().sendExamMessage(type, payload),
    getExamBounds: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return null
      const bounds = mainWindow.getBounds()
      return { left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height }
    },
    getHostIp: () => lastJoinedHostIp,
    getHostPort: () => lastJoinedHostPort,
    // Phase 5: proxy ของโหมดข้อสอบที่พิเศษ (0 = ปิด → NetworkInspector ตัดตัวเองออกชั่วคราว)
    getLocalProxyPort: () => connectProxy?.getBoundPort() ?? 0,
    // VULN-05: packaged build ต้องรันจาก resources root ของตัวเองเท่านั้น
    isPackaged: IS_PACKAGED,
    // VULN-38: accessibility tree ต้องปิดระหว่างสอบ
    isAccessibilityTreeEnabled: () => {
      try {
        return app.isAccessibilitySupportEnabled()
      } catch {
        return false
      }
    }
  })
  // VULN-50: ผูก display hotplug/metrics จริง (เดิม wireElectronScreen ไม่มีผู้เรียก)
  try {
    displayUnsubscribe = HardwareVmGuard.wireElectronScreen(guardEngine.hardware, screen)
  } catch {
    displayUnsubscribe = null
  }
  return guardEngine
}

/**
 * VULN-08: วัดจังหวะพิมพ์จาก main process (before-input-event)
 * — ไม่พึ่ง renderer ที่ผู้สอบแก้ได้ และทำงานเหมือนกันทุก OS
 */
function ensureTypingMonitor(): TypingMonitor {
  typingMonitor ??= new TypingMonitor({
    onSample: (intervalsMs) => {
      try {
        ensureGuardEngine().ingestTypingSamples(intervalsMs, 'main')
      } catch {
        // guard ยังไม่พร้อม — ตัวอย่างนี้หายไป
      }
    }
  })
  return typingMonitor
}

/* ============================================================
 * Phase 5 — Mode 2 / Mode 3 surfaces (ฝั่งเครื่องนักเรียน)
 * ============================================================ */

/** Mode 2: ตัวควบคุมแผงเอกสาร WebContentsView (ผูกกับ GuardEngine + DOCS_URL_LOG) */
function ensureDocsView(): DocsViewController {
  docsViewController ??= new DocsViewController({
    getWindow: () => mainWindow,
    getPolicy: () => {
      const policy = guardEngine?.currentPolicy
      if (!policy) return null
      return { allowedDomains: policy.allowedDomains, enforcement: policy.domainEnforcement }
    },
    emit: (event) => ensureGuardEngine().pushExternalEvent(event),
    logUrl: (payload) => {
      try {
        ensureStudentClient().sendExamMessage(NetMsgType.docsUrlLog, payload)
      } catch {
        // สายหลุด — ประวัติชุดนี้หายเฉพาะท้องถิ่น
      }
    },
    pushState: (state: DocsPanelState) => sendEventToWindow('exam:docs-state', state)
  })
  return docsViewController
}

/** Mode 3: ตัวคุม VS Code (โปรไฟล์ + watchdog) */
function ensureVsCode(): VsCodeController {
  vsCodeController ??= new VsCodeController({
    emit: (event) => ensureGuardEngine().pushExternalEvent(event),
    // VULN-43: production ห้าม override binary/extensions ผ่าน env
    allowEnvOverrides: !IS_PACKAGED
  })
  return vsCodeController
}

/** Mode 3: Local HTTP CONNECT proxy (127.0.0.1:<สุ่ม>) */
function ensureConnectProxy(): LocalConnectProxy {
  connectProxy ??= new LocalConnectProxy({
    getAllowedDomains: () => guardEngine?.currentPolicy?.allowedDomains ?? [],
    getEnforcement: () => guardEngine?.currentPolicy?.domainEnforcement ?? 'warn',
    emit: (event) => ensureGuardEngine().pushExternalEvent(event),
    logAllowed: (payload) => {
      try {
        ensureStudentClient().sendExamMessage(NetMsgType.docsUrlLog, payload)
      } catch {
        // สายหลุด — ข้าม
      }
    },
    now: Date.now
  })
  return connectProxy
}

/**
 * เริ่มการสอบ → เตรียมพื้นผิวของโหมดห้อง:
 * - Mode 2: รับ docsUrl เริ่มต้นจากครู + ผูก session แผงเอกสาร
 * - Mode 3: เปิด local proxy (พอร์ตสุ่ม) + เตรียมโปรไฟล์ VS Code + floating HUD
 */
async function prepareExamModeSurface(payload: { examMode?: string; docsUrl?: string | null }): Promise<void> {
  const mode = payload.examMode ?? 'closed'
  const roomId = lastJoinedRoomId
  if (roomId) ensureDocsView().setSessionId(roomId)
  ensureDocsView().setPreferredStartUrl(payload.docsUrl ?? null)
  if (mode !== 'external-tools') {
    closeFloatingHud()
    return
  }
  try {
    const port = await ensureConnectProxy().listen()
    if (port > 0 && roomId) {
      const prepared = await ensureVsCode().prepareProfile(roomId, port)
      if (!prepared.ok) console.warn(`[mode3] เตรียมโปรไฟล์ VS Code ไม่สำเร็จ: ${prepared.reason ?? '?'}`)
    }
  } catch (err) {
    console.warn(`[mode3] เปิด local proxy ไม่สำเร็จ: ${err instanceof Error ? err.message : '?'}`)
    return
  }
  showFloatingHud()
}

function showFloatingHud(): void {
  if (floatingHudWindow && !floatingHudWindow.isDestroyed()) {
    floatingHudWindow.showInactive()
    return
  }
  floatingHudWindow = createFloatingHudWindow({ isDev: process.env.NODE_ENV !== 'production' })
  floatingHudWindow?.once('ready-to-show', () => {
    floatingHudWindow?.showInactive()
  })
}

function closeFloatingHud(): void {
  if (floatingHudWindow && !floatingHudWindow.isDestroyed()) {
    floatingHudWindow.close()
  }
  floatingHudWindow = null
}

/** VULN-05/62: runtime binding ที่ host ใช้ตรวจว่าไม่ได้รันจาก wrapper */
function currentRuntimeBinding(): RuntimeBinding {
  const addonPath = resolveNativeAddonPath(!IS_PACKAGED)
  return {
    executablePath: process.execPath,
    resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
    commandLine: process.argv.join(' '),
    packaged: IS_PACKAGED,
    defaultApp: process.defaultApp === true,
    platform: process.platform,
    ...(addonPath ? { addonPath } : {})
  }
}

/**
 * path ของ device key ระดับเครื่อง (ไม่ผูกกับ profile instance-*)
 * - 1 เครื่อง = 1 identity แม้เปิดหลาย profile (host/student)
 * - ใช้ appData root: <userData>/device-key.json
 */
function deviceKeyStorePath(): string {
  const profileUserData = app.getPath('userData')
  const base = path.basename(profileUserData).startsWith('instance-')
    ? path.dirname(profileUserData)
    : profileUserData
  return deviceKeyFilePath(base)
}

/**
 * Phase 4 (per-device): โหลด/สร้าง Ed25519 key ของเครื่องนี้
 * - seed ถูกเข้ารหัสด้วย machine identity (ไม่ใช่ TPM/DPAPI ตามข้อกำหนด)
 * - ส่ง seed เข้า native addon ในหน่วยความจำเท่านั้น
 * - คืน null = ใช้ไม่ได้ (fail-closed; production จะตอบ attestation ไม่ได้)
 */
function ensureDeviceIdentity(): string | null {
  if (currentDeviceId !== null) return currentDeviceId
  try {
    const identity = loadOrCreateDeviceIdentity({
      filePath: deviceKeyStorePath()
    })
    const seeded = setNativeDeviceSeed(identity.seedHex)
    if (!seeded) {
      console.warn('[device-key] ตั้ง seed ให้ native addon ไม่สำเร็จ (addon ไม่พร้อม/ยังไม่ build)')
    }
    currentDeviceId = identity.deviceId
    currentDevicePublicKey = identity.publicKeyHex
    if (!identity.hardwareBound) {
      console.warn('[device-key] machine identity ใช้ fallback (ไม่ผูก MachineGuid/machine-id)')
    }
    return currentDeviceId
  } catch (error) {
    console.error(
      `[device-key] ใช้ identity ไม่ได้ (fail-closed): ${error instanceof Error ? error.message : 'unknown'}`
    )
    return null
  }
}

/**
 * host: โหลด signed device roster
 * - production: resources/device-roster.sig.json
 * - dev: env ZTEXAM_DEVICE_ROSTER
 * ไม่มี/ตรวจไม่ผ่าน = ไม่ยอมรับ native signature ของ device ใด ๆ
 */
function ensureDeviceRosterLookup(): DeviceRosterLookup {
  if (deviceRosterLookup) return deviceRosterLookup
  const rosterPath = IS_PACKAGED
    ? (process.resourcesPath ? path.join(process.resourcesPath, 'device-roster.sig.json') : null)
    : (process.env.ZTEXAM_DEVICE_ROSTER ?? null)
  const configured = rosterPath !== null && fs.existsSync(rosterPath)
  const body = loadDeviceRoster(rosterPath, trustedKeyPemSet())
  if (configured && !body) {
    // มีไฟล์แต่ลายเซ็น/รูปแบบเสีย → strict + fail-closed (ห้าม fallback ไป TOFU)
    deviceRosterStrict = true
    console.error('[device-roster] พบไฟล์แต่ตรวจไม่ผ่าน — ใช้ strict mode (ไม่ auto-enroll)')
  } else if (body) {
    deviceRosterStrict = true
  } else {
    deviceRosterStrict = false
    console.warn('[device-roster] ไม่มี roster — ใช้ TOFU enrollment (auto-accept จาก join)')
  }
  deviceRosterLookup = body ? buildDeviceRosterLookup(body) : emptyDeviceRosterLookup()
  return deviceRosterLookup
}

/** host: TOFU enrollment store — ใช้เมื่อไม่มี signed roster (หรือ roster ไม่ครอบ device นี้) */
function ensureDeviceEnrollment(): DeviceEnrollmentService {
  deviceEnrollmentService ??= new DeviceEnrollmentService(ensureHostDatabase())
  return deviceEnrollmentService
}

/** Phase 4: นักเรียน — ผู้ตอบคำถามความถูกต้องของไฟล์แอป (ผูกกับ TLS session) */
function ensureAttestationResponder(resetOnly: boolean): AttestationResponder {
  attestationResponder ??= new AttestationResponder({
    sendToHost: (type, payload) => ensureStudentClient().sendExamMessage(type, payload),
    getTlsExporter: () => studentClient?.exporter ?? null,
    getSnapshot: () => ensureLocalManifestSnapshot(IS_DEV_BUILD),
    isDev: () => IS_DEV_BUILD,
    getRuntimeBinding: () => currentRuntimeBinding(),
    getDeviceId: () => ensureDeviceIdentity(),
    getDevicePublicKey: () => currentDevicePublicKey
  })
  void resetOnly
  return attestationResponder
}

/** Phase 4: เครื่องแม่ — ตัวตรวจ attestation (สุ่ม challenge ตลอดการสอบ) */
function ensureAttestationHostService(): AttestationHostService {
  attestationHost ??= new AttestationHostService({
    getRoom: () => ensureRoomManager(),
    isDev: () => IS_DEV_BUILD,
    isSignatureEnforced: () => attestationStrictToggle.enforced,
    minAppVersion: () => deploymentConfig?.minAppVersion ?? null,
    requireRuntimeBinding: () => IS_PACKAGED,
    devicePublicKeyHex: (deviceId) => {
      if (deviceId === null) return null
      return (
        ensureDeviceRosterLookup().publicKeyHexFor(deviceId) ??
        ensureDeviceEnrollment().lookupPublicKey(deviceId)
      )
    },
    deviceStudentId: (deviceId) => {
      if (deviceId === null) return null
      return (
        ensureDeviceRosterLookup().studentIdFor(deviceId) ??
        ensureDeviceEnrollment().studentIdFor(deviceId)
      )
    },
    enrollDevice: ({ deviceId, publicKeyHex, studentId }) => {
      ensureDeviceRosterLookup()
      // signed roster = strict mode: ห้าม auto-enroll device ที่ไม่อยู่ใน roster
      if (deviceRosterStrict) return { ok: false, reason: 'native-device-unknown' }
      const result = ensureDeviceEnrollment().observe({ deviceId, publicKeyHex, studentId })
      if (!result.ok) return { ok: false, reason: `device-${result.reason}` }
      if (result.status === 'enrolled') {
        console.warn(`[device-enrollment] enrolled ${studentId} ← ${deviceId}`)
      }
      return { ok: true, publicKeyHex: result.publicKeyHex }
    },
    onVerified: (ok, isNew) => {
      if (isNew && ok.signedOnDevice) {
        console.warn(`[attestation] ยืนยันไฟล์แอปผ่าน (ลายเซ็นตรง): ${ok.studentId}`)
      }
    },
    onFailed: (failure: AttestationFailure) => {
      handleAttestationFailure(failure)
    }
  })
  return attestationHost
}

/** Phase 4: attestation ล้มเหลว → คนแดงใน triage + hash chain + freeze จอข้อสอบทันที */
function handleAttestationFailure(failure: AttestationFailure): void {
  console.error(`[attestation] ตรวจไม่ผ่าน: ${failure.studentId} (${failure.reason})`)
  const duplicateDevice =
    failure.reason === 'device-student-mismatch' || failure.reason === 'device-student-conflict'
  const detail = {
    reason: failure.reason,
    challengeId: failure.challengeId.slice(0, 60)
  }
  const event = duplicateDevice
    ? makeDetectionEvent('DUPLICATE_CLIENT_DEVICE_DETECTED', 'attestation-verifier', detail)
    : makeDetectionEvent('ATTESTATION_VERIFICATION_FAILED', 'attestation-verifier', detail)
  if (duplicateDevice) {
    flagDuplicateClient(failure.studentId, event, DUPLICATE_DEVICE_FREEZE_REASON)
    return
  }
  try {
    ensureTriageService().recordStudentEvents(failure.studentId, [event])
  } catch {
    // chain ยังไม่พร้อม (ยังไม่เริ่มสอบ) — แค่แจ้งหน้าจอครูตามด้านล่าง
  }
  sendEventToWindow('host:guard-events', { studentId: failure.studentId, events: [event] })
  // fail-closed: แช่หน้าจอข้อสอบของเครื่องนักเรียนทันที (ครูปลดได้หลังตรวจ)
  roomManager?.tlsServerInstance?.sendToStudent(failure.studentId, NetMsgType.freezeExam, {
    frozen: true,
    reason: 'ยืนยันความถูกต้องของไฟล์แอปไม่ผ่าน (Attestation Failed)'
  })
}

const DUPLICATE_IP_FREEZE_REASON = 'ตรวจพบ client ที่ 2 จาก IP เดียวกัน — รอครูตรวจสอบ'
const DUPLICATE_DEVICE_FREEZE_REASON = 'ตรวจพบเครื่องเดิมถูกใช้กับบัญชีนักเรียนอื่น — รอครูตรวจสอบ'

/**
 * ตรวจพบ client ซ้ำ (IP เดียวกัน หรือ device เดียวกัน):
 * - แจ้งครูทันทีผ่าน toast + audit chain (ถ้าเริ่มสอบแล้ว)
 * - freeze นักเรียนที่เพิ่งเข้ามา รอครูตรวจ/ปลด
 * - ถ้ายังอยู่ lobby จะ freeze ทันทีที่เริ่มสอบ (เพราะ setFrozen ต้องมีห้องที่ start แล้ว)
 */
function flagDuplicateClient(studentId: string, event: DetectionEvent, reason: string): void {
  console.warn(`[duplicate-client] ${studentId}: ${event.code}`)
  sendEventToWindow('host:guard-events', { studentId, events: [event] })
  const triage = ensureTriageService()
  try {
    triage.recordStudentEvents(studentId, [event])
  } catch {
    // chain ยังไม่พร้อม — toast ด้านบนแจ้งครูแล้ว
  }
  if (triage.roomId !== null) {
    try {
      triage.setFrozen(studentId, true, reason)
      return
    } catch {
      // ตกไปส่ง freeze ตรงแบบ fail-closed ด้านล่าง
    }
    roomManager?.tlsServerInstance?.sendToStudent(studentId, NetMsgType.freezeExam, {
      frozen: true,
      reason
    })
    return
  }
  // ยังอยู่ lobby — เก็บไว้ freeze ทันทีที่เริ่มสอบ (ตอนนี้ยังไม่มี exam ให้ล็อก)
  pendingDuplicateClientFreezes.set(studentId, { reason, event })
}

/** Phase 4: native addon บล็อกปุ่มลัดระดับระบบ (Windows) / fallback ตามแพลตฟอร์ม */
function ensureNativeKeyboardGuard(): NativeKeyboardGuard {
  nativeKeyboardGuard ??= new NativeKeyboardGuard({
    getMainWindow: () => mainWindow,
    // VULN-43: production โหลด addon จากตำแหน่งที่ manifest ครอบเท่านั้น
    allowEnvOverrides: !IS_PACKAGED,
    emitEvent: (event) => {
      // ปุ่มถูกบล็อก → วิ่งเข้าท่อตรวจจับเดิม (GUARD_EVENT → hash chain → triage → pin-on-critical)
      ensureGuardEngine().pushExternalEvent(event)
    }
  })
  return nativeKeyboardGuard
}

function sendEventToWindow(channel: string, payload: unknown): void {
  // Phase 5: ส่งถึงทุกหน้าต่าง (หน้าหลัก + floating HUD ของ Mode 3)
  for (const target of BrowserWindow.getAllWindows()) {
    if (target.isDestroyed()) continue
    // push event ทุกตัวผ่าน Zod validation ก่อนส่งเสมอ
    const schema = IpcEventSchemas[channel as IpcEventChannel]
    const parsed = schema.safeParse(payload)
    if (!parsed.success) continue
    target.webContents.send(channel, parsed.data)
  }
}

function clearBlurTimers(): void {
  if (blurBriefTimer) clearTimeout(blurBriefTimer)
  if (blurProlongedTimer) clearTimeout(blurProlongedTimer)
  blurBriefTimer = null
  blurProlongedTimer = null
}

function handleStudentWindowBlur(): void {
  if (state.role !== 'student' || !studentExamRunning) return
  if (studentExamMode === 'external-tools') return
  clearBlurTimers()
  blurStartedAtMs = Date.now()
  try {
    ensureStudentClient().setExamUiState('blurred', null)
  } catch {
    // ยังไม่มี client — ข้ามการอัปเดตสถานะ
  }
  blurBriefTimer = setTimeout(() => {
    blurBriefTimer = null
    if (state.role !== 'student' || !studentExamRunning || studentExamMode === 'external-tools') return
    ensureGuardEngine().pushExternalEvent(
      makeDetectionEvent('WINDOW_BLUR_BRIEF', 'focus-guard', {
        durationMs: String(Date.now() - blurStartedAtMs)
      })
    )
  }, 1_000)
  blurProlongedTimer = setTimeout(() => {
    blurProlongedTimer = null
    if (state.role !== 'student' || !studentExamRunning || studentExamMode === 'external-tools') return
    ensureGuardEngine().pushExternalEvent(
      makeDetectionEvent('WINDOW_BLUR_PROLONGED', 'focus-guard', {
        durationMs: String(Date.now() - blurStartedAtMs)
      })
    )
  }, 15_000)
}

function handleStudentWindowFocus(): void {
  if (state.role !== 'student') return
  clearBlurTimers()
  blurStartedAtMs = 0
  try {
    ensureStudentClient().setExamUiState('focused', null)
  } catch {
    // ยังไม่มี client — ข้ามการอัปเดตสถานะ
  }
}

function createWindow(): void {
  mainWindow = createMainWindow({
    role: state.role,
    isDev: IS_DEV_BUILD
  })
  enforceKioskInputBlocking(mainWindow, () => state.role === 'student' && studentExamRunning)
  mainWindow.webContents.on('before-input-event' as never, (event: { preventDefault(): void }, input: {
    type: string
    key: string
    control: boolean
    meta: boolean
    shift: boolean
    alt: boolean
  }) => {
    if (state.role !== 'student' || !studentExamRunning) return
    if (input.type !== 'keyDown') return
    const accel = input.control || input.meta
    const plainAccel = accel && !input.shift && !input.alt
    // VULN-09: main เป็นเจ้าของ mark "คัดลอกภายใน" (ไม่เชื่อ renderer)
    if (plainAccel && (input.key === 'c' || input.key === 'C')) {
      setTimeout(() => {
        if (state.role !== 'student' || !studentExamRunning) return
        void (async () => {
          try {
            const text = await clipboard.readText()
            if (text) ensureGuardEngine().clipboard.markInternalCopy(text)
          } catch {
            // clipboard อ่านไม่ได้ — รอบถัดไปยังตรวจ paste ได้
          }
        })()
      }, 30)
      return
    }
    // paste: Ctrl/Cmd+V และ Shift+Insert (ทุกแพลตฟอร์ม)
    const isPaste =
      (plainAccel && (input.key === 'v' || input.key === 'V')) ||
      (input.shift && !input.control && !input.meta && !input.alt && input.key === 'Insert')
    if (isPaste) {
      // clipboard API ของ Electron เป็น async — บล็อกคีย์ก่อนแล้วค่อยวางเองถ้าผ่าน
      event.preventDefault()
      void (async () => {
        try {
          const allowed = await ensureGuardEngine().clipboard.interceptPaste()
          const win = mainWindow
          if (allowed && win && !win.isDestroyed()) win.webContents.paste()
        } catch {
          // guard ยังไม่พร้อม — บล็อกไว้ก่อน (fail-closed)
        }
      })()
      return
    }
    // VULN-08: เก็บจังหวะพิมพ์ที่ main (ไม่ต้องพึ่ง renderer)
    if (!input.control && !input.meta && !input.alt) {
      try {
        ensureTypingMonitor().handleKeyDown(input.key)
      } catch {
        // monitor ยังไม่พร้อม
      }
    }
  })
  mainWindow.on('blur', handleStudentWindowBlur)
  mainWindow.on('focus', handleStudentWindowFocus)
  mainWindow.on('closed', () => {
    clearBlurTimers()
    mainWindow = null
  })
}

void app.whenReady().then(() => {
  const router = new IpcRouter(createElectronIpcRegistrar(), {
    // VULN-21: รับ IPC เฉพาะ WebContents ของหน้าต่างแอป (main window + floating HUD)
    isTrustedSender: (event) => {
      const senderId = event.sender?.id
      if (senderId === undefined) return false
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === senderId) {
        return true
      }
      if (
        floatingHudWindow &&
        !floatingHudWindow.isDestroyed() &&
        floatingHudWindow.webContents.id === senderId
      ) {
        return true
      }
      return false
    }
  })
  registerAppHandlers(router, state, {
    onRoleSelected: (role) => {
      if (role === 'host') {
        // โปรแกรมเครื่องแม่ต้องมีฐานข้อมูลพร้อมใช้ตั้งแต่เลือกบทบาท
        ensureHostDatabase()
        // Phase 3c (UDP): bind ช่องทางรับสตรีมหน้าจอล่วงหน้า (พอร์ตถูกอ้างใน SCREEN_SESSION)
        void ensureProctorViewService()
          .getUdpPortAsync()
          .then((port) => console.warn(`[screen-udp] receiver bound at port ${port ?? 'FAILED'}`))
      }
    },
    eventSender: sendEventToWindow
  })
  registerNetworkHandlers(router, state, {
    getRoomManager: ensureRoomManager,
    getDiscovery: () => discovery,
    getStudentClient: ensureStudentClient,
    onStudentJoinedRoom: (hostIp, roomId, hostPort) => {
      lastJoinedHostIp = hostIp
      lastJoinedHostPort = hostPort
      lastJoinedRoomId = roomId
      // Phase 5: ผก session เอกสารของห้องใหม่ (ครั้งแรกจะสร้าง DocsViewController)
      if (state.role === 'student') ensureDocsView().setSessionId(roomId)
    }
  })
  const kioskHooks = makeKioskHooks(() => mainWindow, runtime.windowedKiosk)
  registerExamHandlers(router, state, {
    getSessionManager: ensureSessionManager,
    getStudentClient: ensureStudentClient,
    getGuardEngine: () => (state.role === 'student' ? ensureGuardEngine() : null),
    ...kioskHooks,
    // VULN-21: ระหว่างสอบห้าม renderer สั่งออก kiosk เอง
    isExamRunning: () => state.role === 'student' && studentExamRunning,
    // Phase 4: เริ่ม/หยุด native keyboard guard พร้อมเข้า-ออกโหมด Kiosk
    enterKiosk: () => {
      kioskHooks.enterKiosk()
      if (state.role === 'student' && !runtime.windowedKiosk) ensureNativeKeyboardGuard().start()
    },
    exitKiosk: () => {
      nativeKeyboardGuard?.stop()
      kioskHooks.exitKiosk()
    }
  })
  registerAttestationHandlers(router, state, {
    getAttestationHost: () => (state.role === 'host' ? attestationHost : null),
    isDev: () => IS_DEV_BUILD,
    strictToggle: attestationStrictToggle
  })
  registerDeviceEnrollmentHandlers(router, state, {
    getEnrollment: ensureDeviceEnrollment
  })
  registerDomainHandlers(router, state, {
    getSessionManager: ensureSessionManager,
    getDocPreview: ensureDocPreview,
    getAllowlist: ensureDomainAllowlist,
    getSessionId: () => roomManager?.room?.roomId ?? null,
    // R3: การตัดสิน allowlist ลง audit hash chain (มีชื่อครู/เวลา) — lobby (ยังไม่มี chain) fallback เป็น console
    recordAudit: (eventCode, summaryText, evidence) => {
      try {
        ensureTriageService().recordHostEvent('HOST', eventCode, 'normal', summaryText, evidence, 0)
      } catch {
        console.info(`[allowlist-audit-fallback] ${eventCode}: ${summaryText}`)
      }
    }
  })
  registerAuditHandlers(router, state, {
    getSessionManager: ensureSessionManager,
    getTriageService: ensureTriageService
  })
  // Security item 2: host-as-gateway (เฉพาะ role=host; ไม่ auto-start)
  registerGatewayHandlers(router, state, {
    getGateway: ensureGatewayService
  })
  registerScreenHandlers(router, state, {
    getStreamController: () => (state.role === 'student' ? ensureScreenStreamController() : null),
    getProctorViewService: () => (state.role === 'host' ? ensureProctorViewService() : null)
  })
  // Phase 5: Mode 2 (แผงเอกสาร) + Mode 3 (VS Code / focus)
  registerModeHandlers(router, state, {
    getDocsView: () => (state.role === 'student' ? ensureDocsView() : null),
    launchVsCode: async () => {
      if (state.role !== 'student') return { ok: false, reason: 'STUDENT_ROLE_REQUIRED' }
      const port = connectProxy?.getBoundPort() ?? 0
      if (port <= 0) return { ok: false, reason: 'PROXY_NOT_RUNNING' }
      return ensureVsCode().launch(`http://127.0.0.1:${port}`)
    },
    focusExamWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
        return true
      }
      return false
    }
  })
  // Phase 6: โมดูล dynamic-form — Save/Load ไฟล์ .ztform + ตาราง saved_forms
  registerDynamicFormHandlers(router, state, {
    getDatabase: ensureHostDatabase
  })
  // Phase 9: โมดูล code-ide — รัน CLI/SQL บนเครื่องตัวเอง + เช็ค runtime
  registerCodeIdeHandlers(router)
  // Phase 2 (ท่อกลาง modules): เครื่องนักเรียนส่ง action/autosave ผ่านสาย TLS
  registerModuleTransportStudentHandlers(router, state, {
    getStudentClient: () => (state.role === 'student' ? ensureStudentClient() : null),
    isConnected: () => {
      if (state.role !== 'student' || !studentClient) return false
      // ExamTlsClient ไม่มี getter สถานะ — ถือว่าใช้ได้เมื่อ join สำเร็จแล้ว (มี session key)
      try {
        return studentClient.getSessionKey() !== null
      } catch {
        return false
      }
    }
  })
  // Phase 10: Backend code-ide (ส่งงาน + คิวตรวจ hidden + ส่งออก) ฝั่งเครื่องแม่
  registerCodeIdeHostHandlers(router, state, {
    getDatabase: ensureHostDatabase,
    getCodeIdeService: ensureCodeIdeService,
    getActiveRoom: () => {
      const room = roomManager?.room
      if (!room) return null
      return { roomId: room.roomId, roomName: room.roomName }
    }
  })
  // Phase 7: Backend ฟอร์ม (validator/vault/auto-grader/regrade/export)
  registerFormResponseHandlers(router, state, {
    getDatabase: ensureHostDatabase,
    getFormService: ensureFormHostService,
    getActiveRoom: () => {
      const room = roomManager?.room
      if (!room) return null
      return { roomId: room.roomId, roomName: room.roomName }
    }
  })
  studentEstablishedHandler = (studentId) => {
    // Phase 4: ท่อ handshake ใหม่ = ยิง challenge attestation ทันที (แล้วสุ่มเวลาตามปกติ)
    ensureAttestationHostService().noteStudentEstablished(studentId)
    try {
      ensureSessionManager().handleStudentEstablished(studentId)
    } catch {
      // room ยังไม่พร้อม / ยังไม่เริ่มสอบ — ข้ามได้
    }
  }

  // ห้องที่มองเห็นเปลี่ยน → push ไปหน้า Student ทันที
  discovery.on('rooms-changed', (rooms: unknown) => {
    sendEventToWindow('network:rooms-updated', { rooms })
  })

  // บทบาทจาก CLI flag (--role=host|student) ใช้ตั้ง shortcut ในห้องคอมได้เลย
  if (runtime.role === 'host') {
    ensureHostDatabase()
  }
  if (runtime.role === 'student') {
    // เปิดฟัง UDP beacon ตั้งแต่เปิดแอปในห้องคอม (หน้า Room Browser)
    discovery.start()
    // per-device attestation key: เตรียมตั้งแต่ boot (fail-closed ถ้าใช้ไม่ได้)
    ensureDeviceIdentity()
  }

  // VULN-48: lock/unlock ระหว่างสอบ (Windows/macOS; Linux ใช้ SessionSwitchGuard)
  powerMonitor.on('lock-screen', () => reportSessionSwitch('lock-screen'))
  powerMonitor.on('unlock-screen', () => reportSessionSwitch('unlock-screen'))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  mainWindow?.focus()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  studentClient?.abort()
  typingMonitor?.stop()
  // Phase 4: ปลด native hook + หยุด attestation เสมอ (กันปล่อย keyboard hook ค้างระบบ)
  nativeKeyboardGuard?.stop()
  attestationHost?.stop()
  attestationHost = null
  // VULN-50/51: ถอด display listener + หยุด liveness timer
  displayUnsubscribe?.()
  displayUnsubscribe = null
  stopScreenLivenessMonitor()
  // Prompt 3c: Zero-Trace — ลบ ring buffer/คีย์ทันทีเมื่อปิดแอป
  screenStreamController?.stopSession('app-quit')
  proctorViewService?.clearAll()
  // Phase 5: ปิดพื้นผิว Mode 2/3
  docsViewController?.destroy()
  vsCodeController?.stop()
  connectProxy?.close()
  closeFloatingHud()
  // Security item 2: ปิด DHCP/DNS gateway ทุกครั้งก่อนออก (ไม่ทิ้งพอร์ต 67/53 ค้าง)
  gatewayService?.stop()
  gatewayService = null
  void roomManager?.closeRoom()
  discovery.stop()
})

app.on('will-quit', () => {
  hostDb?.close()
  hostDb = null
})

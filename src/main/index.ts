import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { IpcEventSchemas, type IpcEventChannel } from '@shared/ipc-channels'
import { NetMsgType } from '@shared/protocol-schema'
import { parseRuntimeArgs } from './runtime-args'
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
import { DomainAllowlistService } from './host/domain-allowlist'
import { DocPreviewController } from './host/doc-preview'
import { TriageService } from './host/triage-service'
import { ProctorViewService } from './screen/proctor-view-service'
import { ScreenStreamController } from './screen/stream-controller'
import { createMainWindow, enforceKioskInputBlocking } from './window'
import { HostDatabase, getDefaultDatabasePath } from './storage/db'
import { HostRoomManager } from './network/host-room'
import { RoomDiscoveryListener } from './network/discovery'
import { ExamTlsClient } from './network/tls-client'
import { CoreSessionManager } from './host/core-session-manager'
import { GuardEngine } from './guard/guard-engine'
import { NativeKeyboardGuard } from './guard/native-bridge'
import { AttestationResponder } from './attestation/client-responder'
import { AttestationHostService, type AttestationFailure } from './attestation/host-verifier'
import { ensureLocalManifestSnapshot } from './attestation/manifest'
import { inspectLaunch, describeFindings, isAllowedInDev, type LaunchFinding } from './guard/launch-guard'

/* ============================================================
 * Phase 4 — Launch Guard: วิ่งเป็นบรรทัดแรกสุด (ก่อนสิ่งใด ๆ ของแอป)
 * Production: พบ flag/env อันตราย → ปฏิเสธการรันทันที (fail-closed)
 * ============================================================ */
const IS_DEV_BUILD = process.env.NODE_ENV !== 'production'
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

/** โหมดบังคับตรวจลายเซ็นจริงแม้ใน dev (env หรือสวิตช์จากหน้าตั้งค่าห้องสอบ) */
const attestationStrictToggle = { enforced: process.env.ZTEXAM_STRICT_ATTESTATION === '1' }

/* ---------- จัดการ isolation ของ multi-instance ก่อนพร้อมใช้งาน ---------- */
const runtime = parseRuntimeArgs(process.argv)
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

let mainWindow: BrowserWindow | null = null
let hostDb: HostDatabase | null = null
let roomManager: HostRoomManager | null = null
let sessionManager: CoreSessionManager | null = null
let domainAllowlist: DomainAllowlistService | null = null
let docPreview: DocPreviewController | null = null
let triageService: TriageService | null = null
let proctorViewService: ProctorViewService | null = null
let screenStreamController: ScreenStreamController | null = null
const discovery = new RoomDiscoveryListener()
let studentClient: ExamTlsClient | null = null
let guardEngine: GuardEngine | null = null
let nativeKeyboardGuard: NativeKeyboardGuard | null = null
let attestationResponder: AttestationResponder | null = null
let attestationHost: AttestationHostService | null = null
/** IP เครื่องแม่จากการ join ล่าสุด (NetworkInspector ยกเว้นให้เสมอ) */
let lastJoinedHostIp: string | null = null
/** Room ID ที่เข้าล่าสุด (ring buffer ใช้ตั้งชื่อโฟลเดอร์ชั่วคราว — Phase 3c) */
let lastJoinedRoomId: string | null = null

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
      // Phase 4: เริ่มสุ่มตรวจ attestation ตลอดการสอบ (45–120 วินาที/รอบ)
      ensureAttestationHostService().startExam(
        ensureRoomManager().students.map((student) => student.studentId)
      )
    },
    onExamEnded: (roomId, reason) => {
      ensureTriageService().endRoom(roomId, reason)
      // Phase 4: จบการสอบ → หยุดตรวจ attestation (เคลียร์ timer ทั้งหมด)
      attestationHost?.stop()
      attestationHost = null
    },
    // Phase 3c: รายการเซกเมนต์ย้อนหลังจากนักเรียน → ProctorViewService
    onStudentNetMessage: (studentId, type, payload) => {
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

/** Phase 3b: Audit hash chain + Triage engine ของเครื่องแม่ */
function ensureTriageService(): TriageService {
  triageService ??= new TriageService({
    db: ensureHostDatabase(),
    getRoom: () => roomManager,
    sendHostEvent: sendEventToWindow
  })
  return triageService
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

function ensureRoomManager(): HostRoomManager {
  roomManager ??= new HostRoomManager({
    db: ensureHostDatabase(),
    maxStudents: 60,
    onStudentsChanged: (students) => {
      sendEventToWindow('host:students-updated', { students })
      // Phase 3b: สถานะหลุด/กลับมาเชื่อมต่อ → triage (ลำดับความสำคัญของ DISCONNECTED)
      for (const student of students) {
        triageService?.setStudentConnection(student.studentId, student.online)
        // Phase 4: หลุดการรับ → ยก pending challenge (จะถูกท้าถามใหม่ตอน reconnect)
        if (!student.online) attestationHost?.forget(student.studentId)
      }
    },
    onRoomClosed: () => {
      sendEventToWindow('host:students-updated', { students: [] })
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
    // Phase 3c: binary frame (ภาพย่อ / เซกเมนต์) จากนักเรียน → ProctorViewService
    onStudentBinary: (studentId, subType, payload) => {
      const service = ensureProctorViewService()
      if (subType === 0x01) service.ingestScreenFrame(studentId, payload)
      else if (subType === 0x02) service.ingestSegmentData(studentId, payload)
    }
  })
  return roomManager
}

function ensureStudentClient(): ExamTlsClient {
  studentClient ??= new ExamTlsClient({
    onConnectionState: (status) => {
      // Phase 4: ท่อใหม่ = exporter คนละค่า — เครื่องนักเรียนต้องส่ง manifest ใหม่หลัง reconnect
      if (status.state === 'connecting') ensureAttestationResponder(true).resetOnReconnect()
      forwardConnectionState(sendEventToWindow)(status)
    },
    onBinary: (subType, payload) => {
      ensureScreenStreamController().handleBinaryFrame(subType, payload)
    },
    onMessage: createStudentExamEventForwarder(sendEventToWindow, () => mainWindow, {
      onNetMessage: (type, payload) => {
        // Phase 4: คำท้า attestation จากเครื่องแม่ (ผูกกับ TLS exporter ของเรา)
        if (type === NetMsgType.attestationChallenge) {
          return ensureAttestationResponder(false).handleChallengeMessage(payload)
        }
        // Phase 3c: เปิดเซสชันบันทึกหน้าจอ (คีย์จากเครื่องแม่ผ่านหน่วยความจำ)
        if (type === NetMsgType.screenSession) {
          const session = payload as { screenBufferKey: string; thumbnailIntervalMs: number }
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
        // Phase 3c: จบสอบ → Zero-Trace Cleanup (ลบ ring buffer + คีย์ทันที)
        screenStreamController?.stopSession('exam-ended')
      }
    })
  })
  return studentClient
}

function ensureGuardEngine(): GuardEngine {
  guardEngine ??= new GuardEngine({
    sendToHost: (type, payload) => ensureStudentClient().sendExamMessage(type, payload),
    getExamBounds: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return null
      const bounds = mainWindow.getBounds()
      return { left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height }
    },
    getHostIp: () => lastJoinedHostIp,
    getLocalProxyPort: () => 0 // Mode 3 ยังไม่เปิด proxy (Phase 5)
  })
  return guardEngine
}

/** Phase 4: นักเรียน — ผู้ตอบคำถามความถูกต้องของไฟล์แอป (ผูกกับ TLS session) */
function ensureAttestationResponder(resetOnly: boolean): AttestationResponder {
  attestationResponder ??= new AttestationResponder({
    sendToHost: (type, payload) => ensureStudentClient().sendExamMessage(type, payload),
    getTlsExporter: () => studentClient?.exporter ?? null,
    getSnapshot: () => ensureLocalManifestSnapshot(IS_DEV_BUILD)
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
  const event = {
    eventId: `attest-${failure.challengeId}`,
    code: 'ATTESTATION_VERIFICATION_FAILED',
    severity: 'critical',
    score: 80,
    detectorId: 'attestation-verifier',
    detail: {
      reason: failure.reason,
      challengeId: failure.challengeId.slice(0, 60)
    },
    occurredAtMs: Date.now()
  } as const
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

/** Phase 4: native addon บล็อกปุ่มลัดระดับระบบ (Windows) / fallback ตามแพลตฟอร์ม */
function ensureNativeKeyboardGuard(): NativeKeyboardGuard {
  nativeKeyboardGuard ??= new NativeKeyboardGuard({
    getMainWindow: () => mainWindow,
    emitEvent: (event) => {
      // ปุ่มถูกบล็อก → วิ่งเข้าท่อตรวจจับเดิม (GUARD_EVENT → hash chain → triage → pin-on-critical)
      ensureGuardEngine().pushExternalEvent(event)
    }
  })
  return nativeKeyboardGuard
}

function sendEventToWindow(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // push event ทุกตัวผ่าน Zod validation ก่อนส่งเสมอ
  const schema = IpcEventSchemas[channel as IpcEventChannel]
  const parsed = schema.safeParse(payload)
  if (!parsed.success) return
  mainWindow.webContents.send(channel, parsed.data)
}

function createWindow(): void {
  mainWindow = createMainWindow({
    role: state.role,
    isDev: process.env.NODE_ENV !== 'production'
  })
  enforceKioskInputBlocking(mainWindow)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

void app.whenReady().then(() => {
  const router = new IpcRouter(createElectronIpcRegistrar())
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
    onStudentJoinedRoom: (hostIp, roomId) => {
      lastJoinedHostIp = hostIp
      lastJoinedRoomId = roomId
    }
  })
  const kioskHooks = makeKioskHooks(() => mainWindow, runtime.windowedKiosk)
  registerExamHandlers(router, state, {
    getSessionManager: ensureSessionManager,
    getStudentClient: ensureStudentClient,
    getGuardEngine: () => (state.role === 'student' ? ensureGuardEngine() : null),
    ...kioskHooks,
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
  registerDomainHandlers(router, state, {
    getSessionManager: ensureSessionManager,
    getDocPreview: ensureDocPreview,
    getAllowlist: ensureDomainAllowlist,
    getSessionId: () => roomManager?.room?.roomId ?? null
  })
  registerAuditHandlers(router, state, {
    getSessionManager: ensureSessionManager,
    getTriageService: ensureTriageService
  })
  registerScreenHandlers(router, state, {
    getStreamController: () => (state.role === 'student' ? ensureScreenStreamController() : null),
    getProctorViewService: () => (state.role === 'host' ? ensureProctorViewService() : null)
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
  }

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
  // Phase 4: ปลด native hook + หยุด attestation เสมอ (กันปล่อย keyboard hook ค้างระบบ)
  nativeKeyboardGuard?.stop()
  attestationHost?.stop()
  attestationHost = null
  // Prompt 3c: Zero-Trace — ลบ ring buffer/คีย์ทันทีเมื่อปิดแอป
  screenStreamController?.stopSession('app-quit')
  proctorViewService?.clearAll()
  void roomManager?.closeRoom()
  discovery.stop()
})

app.on('will-quit', () => {
  hostDb?.close()
  hostDb = null
})

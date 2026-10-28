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
    },
    onExamEnded: (roomId, reason) => {
      ensureTriageService().endRoom(roomId, reason)
    },
    // Phase 3c: รายการเซกเมนต์ย้อนหลังจากนักเรียน → ProctorViewService
    onStudentNetMessage: (studentId, type, payload) => {
      if (type !== NetMsgType.ringSegmentList) return false
      ensureProctorViewService().ingestSegmentList(studentId, payload)
      return true
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
      }
    },
    onRoomClosed: () => {
      sendEventToWindow('host:students-updated', { students: [] })
      // Phase 3a-plus: เก็บกวาดของค้างของห้องเก่า (preview + ค่าทับ enforcement)
      docPreview?.close()
      ensureDomainAllowlist().setEnforcementOverride(null)
      // Phase 3c: ล้าง thumbnail store ของห้องเก่า
      proctorViewService?.clearAll()
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
    onConnectionState: forwardConnectionState(sendEventToWindow),
    onBinary: (subType, payload) => {
      ensureScreenStreamController().handleBinaryFrame(subType, payload)
    },
    onMessage: createStudentExamEventForwarder(sendEventToWindow, () => mainWindow, {
      onNetMessage: (type, payload) => {
        // Phase 3c: เปิดเซสชันบันทึกหน้าจอ (คีย์จากเครื่องแม่ผ่านหน่วยความจำ)
        if (type === NetMsgType.screenSession) {
          const session = payload as { screenBufferKey: string; thumbnailIntervalMs: number }
          if (lastJoinedRoomId) {
            ensureScreenStreamController().startSession(lastJoinedRoomId, session)
          }
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
  registerExamHandlers(router, state, {
    getSessionManager: ensureSessionManager,
    getStudentClient: ensureStudentClient,
    getGuardEngine: () => (state.role === 'student' ? ensureGuardEngine() : null),
    ...makeKioskHooks(() => mainWindow, runtime.windowedKiosk)
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
  // Phase 3c: Zero-Trace — ลบ ring buffer/คีย์ทันทีเมื่อปิดแอป
  screenStreamController?.stopSession('app-quit')
  proctorViewService?.clearAll()
  void roomManager?.closeRoom()
  discovery.stop()
})

app.on('will-quit', () => {
  hostDb?.close()
  hostDb = null
})

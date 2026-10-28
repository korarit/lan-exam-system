import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { IpcEventSchemas, type IpcEventChannel } from '@shared/ipc-channels'
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
import { DomainAllowlistService } from './host/domain-allowlist'
import { DocPreviewController } from './host/doc-preview'
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
const discovery = new RoomDiscoveryListener()
let studentClient: ExamTlsClient | null = null
let guardEngine: GuardEngine | null = null
/** IP เครื่องแม่จากการ join ล่าสุด (NetworkInspector ยกเว้นให้เสมอ) */
let lastJoinedHostIp: string | null = null

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
      // พฤติกรรมน่าสงสัยของ exam (จุด cursor ผิด / พยายามดูข้อล่วงหน้า)
      // Phase 3b จะเก็บลง audit hash chain — ตอนนี้แสดง log ของเครื่องแม่ก่อน
      console.warn(`[exam-anomaly] ${source ?? '?'}: ${reason}`)
    },
    // Phase 3a-plus: โดเมนที่ครูอนุมัติ + พฤติกรรมเตือน/บล็อก จากการ์ดเตรียมเอกสาร
    getAllowedDomains: () => {
      const roomId = roomManager?.room?.roomId
      return roomId ? ensureDomainAllowlist().listApproved(roomId) : []
    },
    getDomainEnforcement: () => ensureDomainAllowlist().resolveDomainEnforcement(roomManager?.room?.roomId ?? null)
  })
  return sessionManager
}

function ensureDomainAllowlist(): DomainAllowlistService {
  domainAllowlist ??= new DomainAllowlistService(ensureHostDatabase())
  return domainAllowlist
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
    onStudentsChanged: (students) => sendEventToWindow('host:students-updated', { students }),
    onRoomClosed: () => {
      sendEventToWindow('host:students-updated', { students: [] })
      // Phase 3a-plus: เก็บกวาดของค้างของห้องเก่า (preview + ค่าทับ enforcement)
      docPreview?.close()
      ensureDomainAllowlist().setEnforcementOverride(null)
    },
    onStudentEstablished: (studentId) => {
      // deferred: session manager ยังไม่ถูกสร้าง ณ เวลา create room ก็ยังได้ (late-binding)
      studentEstablishedHandler?.(studentId)
    }
  })
  return roomManager
}

function ensureStudentClient(): ExamTlsClient {
  studentClient ??= new ExamTlsClient({
    onConnectionState: forwardConnectionState(sendEventToWindow),
    onMessage: createStudentExamEventForwarder(sendEventToWindow, () => mainWindow, {
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
    onStudentJoinedRoom: (hostIp) => {
      lastJoinedHostIp = hostIp
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
  void roomManager?.closeRoom()
  discovery.stop()
})

app.on('will-quit', () => {
  hostDb?.close()
  hostDb = null
})

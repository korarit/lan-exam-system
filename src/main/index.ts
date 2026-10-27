import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { IpcEventSchemas, type IpcEventChannel } from '@shared/ipc-channels'
import { parseRuntimeArgs } from './runtime-args'
import { IpcRouter, createElectronIpcRegistrar } from './ipc/router'
import { registerAppHandlers, type AppRuntimeState } from './ipc/app-handlers'
import { registerNetworkHandlers, forwardConnectionState } from './ipc/network-handlers'
import { createMainWindow } from './window'
import { HostDatabase, getDefaultDatabasePath } from './storage/db'
import { HostRoomManager } from './network/host-room'
import { RoomDiscoveryListener } from './network/discovery'
import { ExamTlsClient } from './network/tls-client'

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
const discovery = new RoomDiscoveryListener()
let studentClient: ExamTlsClient | null = null

function ensureHostDatabase(): HostDatabase {
  hostDb ??= new HostDatabase({ filePath: getDefaultDatabasePath(app.getPath('userData')) })
  return hostDb
}

function ensureRoomManager(): HostRoomManager {
  roomManager ??= new HostRoomManager({
    db: ensureHostDatabase(),
    maxStudents: 60,
    onStudentsChanged: (students) => sendEventToWindow('host:students-updated', { students }),
    onRoomClosed: () => {
      sendEventToWindow('host:students-updated', { students: [] })
    }
  })
  return roomManager
}

function ensureStudentClient(): ExamTlsClient {
  studentClient ??= new ExamTlsClient({
    onConnectionState: forwardConnectionState(sendEventToWindow)
  })
  return studentClient
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
    getStudentClient: ensureStudentClient
  })

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

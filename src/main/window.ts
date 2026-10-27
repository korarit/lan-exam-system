import { BrowserWindow, screen, shell } from 'electron'
import path from 'node:path'
import type { AppRole } from '@shared/types/role'

export interface WindowOptions {
  role: AppRole
  isDev: boolean
}

const HOST_SIZE = { width: 1280, height: 800 }
const STUDENT_LOBBY_SIZE = { width: 960, height: 640 }

/**
 * Window Manager:
 * - Host: หน้าต่างปกติขนาด 1280x800 (dev วางชิดซ้ายครึ่งจอ)
 * - Student Lobby: 960x640 (dev วางชิดขวาครึ่งจอ สำหรับทดสอบ side-by-side)
 * - Student Kiosk (เต็มจอ/alwaysOnTop) จะถูกเปิดใช้ตอน "เริ่มสอบจริง" เท่านั้น (Phase 2)
 *   ในเครื่องเดียวกันให้ใช้ flag --windowed-kiosk เพื่อกันการล็อกจอทับหน้าต่างครู
 */
export function createMainWindow(options: WindowOptions): BrowserWindow {
  const isHostWindow = options.role !== 'student'
  const size = isHostWindow ? HOST_SIZE : STUDENT_LOBBY_SIZE

  const { workArea } = screen.getPrimaryDisplay()
  const halfWidth = Math.floor(workArea.width / 2)
  const isSideBySideDev = options.isDev

  const width = Math.min(size.width, isSideBySideDev ? halfWidth : workArea.width)
  const height = Math.min(size.height, workArea.height)

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width,
    height,
    minWidth: 720,
    minHeight: 480,
    title: isHostWindow ? 'ZT-Exam — เครื่องแม่ (ผู้คุมสอบ)' : 'ZT-Exam — นักเรียน',
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: options.isDev,
      spellcheck: false
    }
  }
  if (isSideBySideDev) {
    windowOptions.x = isHostWindow ? workArea.x : workArea.x + halfWidth
    windowOptions.y = workArea.y
  }

  const win = new BrowserWindow(windowOptions)

  // ห้ามเปิดหน้าต่าง/iframe ใหม่จาก renderer (kiosk ต้องคุม surface เดียว)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const appUrl = new URL(win.webContents.getURL() ?? 'file:///')
    const target = new URL(url)
    if (appUrl.origin !== target.origin) {
      event.preventDefault()
      if (target.protocol === 'https:' || target.protocol === 'http:') {
        void shell.openExternal(url)
      }
    }
  })

  if (options.isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** สลับหน้าต่างนักเรียนเข้าโหมด Kiosk เมื่อเริ่มสอบจริง (เรียกจาก Phase 2) */
export function enterKioskMode(win: BrowserWindow): void {
  win.setKiosk(true)
  win.setFullScreen(true)
  win.setAlwaysOnTop(true, 'screen-saver')
}

export function exitKioskMode(win: BrowserWindow): void {
  win.setAlwaysOnTop(false)
  win.setFullScreen(false)
  win.setKiosk(false)
}

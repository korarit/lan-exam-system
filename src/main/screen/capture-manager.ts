import os from 'node:os'

/* ============================================================
 * Phase 3c.1: CaptureManager — ตรวจสิทธิ์/สภาพแวดล้อม
 * และดึงรายการทุก Display (Multi-Monitor) บนเครื่องนักเรียน
 * ============================================================ */

export interface DisplaySourceInfo {
  /** id ของ desktopCapturer source (ใช้กับ getUserMedia chromeMediaSourceId) */
  sourceId: string
  /** display_id จาก Electron screen API (ผูก stream แยกต่อจอ) */
  displayId: string
  displayIndex: number
  displayCount: number
  label: string
  width: number
  height: number
}

export interface CaptureEnvironmentStatus {
  ok: boolean
  platform: NodeJS.Platform
  /** ข้อความที่นักเรียน/เครื่องแม่เห็นได้ (เช่น ต้องเปิดสิทธิ์ macOS) */
  reason?: string
  /** สถานะสิทธิ์แบบข้ามแพลตฟอร์ม ('granted' = จับได้ทันที) */
  permission: 'granted' | 'denied' | 'unknown-session'
}

type ElectronScreenModule = {
  getAllDisplays(): { id: number; bounds: { width: number; height: number } }[]
  matchDisplay?(display: { id: number }): unknown
}

type ElectronDesktopCapturer = {
  getSources(options: { types: string[]; thumbnailSize?: { width: number; height: number } }): Promise<
    { id: string; name: string; display_id?: string }[]
  >
}

export interface ElectronScreenModules {
  screen: ElectronScreenModule
  desktopCapturer: ElectronDesktopCapturer
  systemPreferences?: { getMediaAccessStatus(media: string): string }
}

function loadElectronModules(): ElectronScreenModules {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as ElectronScreenModules
}

export class CaptureManager {
  private readonly loadElectron: () => ElectronScreenModules

  constructor(loadElectron: () => ElectronScreenModules = loadElectronModules) {
    this.loadElectron = loadElectron
  }

  /** ตรวจสิทธิ์/เซสชันก่อนเริ่มสอบ (macOS Screen Recording / Linux X11-Wayland) */
  checkEnvironment(): CaptureEnvironmentStatus {
    const platform = process.platform
    if (platform === 'win32') {
      return { ok: true, platform, permission: 'granted' }
    }
    if (platform === 'darwin') {
      const status = this.loadElectron().systemPreferences?.getMediaAccessStatus('screen') ?? 'unknown'
      if (status === 'granted') return { ok: true, platform, permission: 'granted' }
      return {
        ok: false,
        platform,
        permission: 'denied',
        reason: `macOS ต้องเปิดสิทธิ์ Screen Recording ก่อนเริ่มสอบ (สถานะปัจจุบัน: ${status})`
      }
    }
    // linux
    const sessionType = process.env.XDG_SESSION_TYPE ?? 'x11'
    if (sessionType === 'wayland') {
      return {
        ok: false,
        platform,
        permission: 'unknown-session',
        reason: 'Linux แบบ Wayland จับภาพหน้าจออัตโนมัติไม่ได้ — ต้องใช้ X11 session'
      }
    }
    return { ok: true, platform, permission: 'granted' }
  }

  /** รายการทุกจอ + จับคู่ desktopCapturer source เข้ากับ display_id (จับครบทุกจอ แยก stream) */
  async enumerateDisplaySources(): Promise<DisplaySourceInfo[]> {
    const electron = this.loadElectron()
    const displays = electron.screen.getAllDisplays()
    const sources = await electron.desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 }
    })
    const out: DisplaySourceInfo[] = []
    for (const source of sources) {
      const displayIndex = displays.findIndex((d) => String(d.id) === (source.display_id ?? ''))
      const display = displayIndex >= 0 ? displays[displayIndex] : displays[0]
      if (!display) continue
      out.push({
        sourceId: source.id,
        displayId: String(display.id),
        displayIndex: displayIndex >= 0 ? displayIndex : out.length,
        displayCount: displays.length,
        label: source.name || `Display ${displayIndex + 1}`,
        width: display.bounds.width,
        height: display.bounds.height
      })
    }
    // fallback กรณี display_id ไม่ตรงกันเลย (บาง driver): ใช้ลำดับ source ตรง ๆ
    if (out.length === 0 && sources.length > 0) {
      return sources.map((source, index) => ({
        sourceId: source.id,
        displayId: source.display_id ?? `${index}`,
        displayIndex: index,
        displayCount: sources.length,
        label: source.name || `Display ${index + 1}`,
        width: 0,
        height: 0
      }))
    }
    return out
  }

  /** รายงานชื่อเครื่องไว้ใช้ใน label */
  get machineName(): string {
    return os.hostname().slice(0, 40)
  }
}

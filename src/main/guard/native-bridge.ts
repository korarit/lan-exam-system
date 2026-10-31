import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { DetectionEvent } from '@shared/policy-schema'

/* ============================================================
 * Phase 4.4 — NativeKeyboardGuardBridge
 * - Windows: โหลด `.node` addon (WH_KEYBOARD_LL) → บล็อกปุ่มลัดระดับระบบ
 * - macOS: setKiosk(true) ครอบ Presentation Options ฝั่ง window แล้ว (ผ่ามาสำหรับเจตนาเดียวกัน)
 * - Linux/Fallback: ไม่มี addon → ไม่คร้า แต่ FocusGuard ยังจับการเสียโฟกัสและฟ้องเครื่องแม่ตามหลัก Detect & Report
 * ============================================================ */

export type BlockedShortcutCode =
  | 'win-key'
  | 'alt-tab'
  | 'alt-esc'
  | 'ctrl-esc'
  | 'alt-f4'
  | 'printscreen'
  | 'synthetic-input'

export interface NativeGuardAddon {
  start(callback: (code: string) => void): boolean
  stop(): void
  isRunning(): boolean
  lastBlocked(): string
}

export type NativeGuardMode =
  | 'native-hook' // พร้อมบล็อกจริง (Windows + มี addon)
  | 'kiosk-fallback' // ไม่มี addon — คุมด้วย kiosk/focus ของ Electron เท่านั้น

export interface NativeKeyboardGuardOptions {
  getMainWindow: () => { isDestroyed(): boolean; setKiosk(enable: boolean): void } | null
  /** ส่ง DetectionEvent BLOCKED_SYSTEM_SHORTCUT (ให้ GuardEngine flush ต่อไปเครื่องแม่) */
  emitEvent: (event: DetectionEvent) => void
  now?: () => number
  /** override ตำแหน่ง .node (ทดสอบ) */
  addonPath?: string
  /**
   * VULN-43: อนุญาต env override (`ZTEXAM_NATIVE_ADDON`) เฉพาะ dev
   * production ต้องโหลด addon จากตำแหน่งที่ manifest ครอบเท่านั้น
   */
  allowEnvOverrides?: boolean
}

export class NativeKeyboardGuard {
  private addon: NativeGuardAddon | null = null
  private mode: NativeGuardMode = 'kiosk-fallback'
  private running = false
  private readonly now: () => number
  private readonly lastEventsAtMs = new Map<string, number>()
  /** หน่วงการรายงานซ้ำของปุ่มเดิม (กดค้างจะ leniency ยิง event ถี่) */
  private readonly dedupeWindowMs: number

  constructor(private readonly opts: NativeKeyboardGuardOptions) {
    this.now = opts.now ?? Date.now
    this.dedupeWindowMs = 800
  }

  get currentMode(): NativeGuardMode {
    return this.mode
  }

  get isRunning(): boolean {
    return this.running
  }

  /** โหลด addon (lazy — ไม่เรียกตอน import เพื่อไม่ขวางเวลาในโหมด dev/test) */
  loadAddon(explicitPath?: string): NativeGuardAddon | null {
    if (this.addon) return this.addon
    const resolved = explicitPath ?? this.opts.addonPath ?? this.defaultAddonPath()
    if (resolved && fs.existsSync(resolved)) {
      try {
        const requireNative = createRequire(__filename)
        const loaded = requireNative(resolved) as NativeGuardAddon
        if (typeof loaded?.start === 'function' && typeof loaded?.stop === 'function') {
          this.addon = loaded
          this.mode = 'native-hook'
          return loaded
        }
      } catch {
        // โหลดไม่ได้ (เช่น เวอร์ชัน ABI ไม่ตรง) — ตกไปใช้ fallback เสมอ
      }
    }
    return null
  }

  /** เริ่มโหมดคุมปุ่ม (เรียกเมื่อเข้า Kiosk / เริ่มสอบ) */
  start(): NativeGuardMode {
    if (this.running) return this.mode
    if (process.platform === 'win32') {
      const addon = this.loadAddon()
      if (addon) {
        const started = addon.start((code) => this.onBlockedShortcut(code as BlockedShortcutCode))
        if (started) {
          this.addon = addon
          this.running = true
          return (this.mode = 'native-hook')
        }
      }
    }
    // fallback: คุมด้วย kiosk แล้วฟ้องผ่าน FocusGuard (แพลตฟอร์มอื่นรองรับด้วยวิธีเดียวกัน)
    const win = this.opts.getMainWindow()
    if (win && !win.isDestroyed()) {
      try {
        win.setKiosk(true)
      } catch {
        // Linux บาง WM บล็อก setKiosk — ยอมรับอย่างเงียบ ๆ ให้ระบบหลักตามคุมต่อ
      }
    }
    this.running = true
    return (this.mode = 'kiosk-fallback')
  }

  /** หยุดโหมดคุม (ออกจาก Kiosk / จบสอบ / ปิดแอป) — เรียกได้โดยไม่กังวลระดับ platform */
  stop(): void {
    if (!this.running) return
    if (this.mode === 'native-hook' && this.addon) {
      try {
        this.addon.stop()
      } catch {
        // ยอมริเริ่ม — hook จะถูกปลดโดย flag ของ process อย่างเดียวในทุกกรณี
      }
    }
    this.running = false
    this.mode = 'kiosk-fallback'
  }

  /** โหมดคุม (native-hook = ฝั่ง OS บล็อกจริง, kiosk-fallback = detect & report) */
  onBlockedShortcut(code: BlockedShortcutCode): DetectionEvent {
    const now = this.now()
    const last = this.lastEventsAtMs.get(code) ?? 0
    const occurredAtMs = now
    if (now - last < this.dedupeWindowMs) {
      // เหตุการณ์เดิมช่วงสั้น ๆ — ในระบบจะไม่ยิงผลละครเดิมซ้ำ (โดดแบบไม่บวกซ้ำ)
      return this.toEvent(code, occurredAtMs, true)
    }
    this.lastEventsAtMs.set(code, occurredAtMs)
    const event = this.toEvent(code, occurredAtMs, false)
    this.opts.emitEvent(event)
    return event
  }

  /** รายงานเหตุการณ์ปุ่มถูกบล็อกให้เครื่องแม่ทันที (dedupe เฉพาะปุ่มเดิมที่กดค้าง) */
  private toEvent(code: BlockedShortcutCode, occurredAtMs: number, suppressed: boolean): DetectionEvent {
    // VULN-38/62: อินพุตสังเคราะห์ = macro/automation ไม่ใช่ปุ่มลัด
    if (code === 'synthetic-input') {
      return {
        eventId: randomUUID(),
        code: 'SYNTHETIC_INPUT_INJECTED',
        severity: 'critical',
        score: suppressed ? 0 : 60,
        detectorId: 'native-keyboard-guard',
        detail: {
          synthetic: 'true',
          guardMode: this.mode,
          suppressed: suppressed ? 'true' : 'false'
        },
        occurredAtMs
      }
    }
    return {
      eventId: randomUUID(),
      code: 'BLOCKED_SYSTEM_SHORTCUT',
      severity: 'warning',
      score: suppressed ? 0 : 15,
      detectorId: 'native-keyboard-guard',
      detail: {
        shortcut: code,
        guardMode: this.mode,
        suppressed: suppressed ? 'true' : 'false'
      },
      occurredAtMs
    }
  }

  /** แหล่งที่ .node อยู่: dev = native/build/Release จากโปรเจกต์, package = extraResource */
  private defaultAddonPath(): string | null {
    return resolveNativeAddonPath(this.opts.allowEnvOverrides !== false)
  }
}

/** resolve ตำแหน่ง os_guard.node (ใช้ร่วมกับ process mitigations) */
export function resolveNativeAddonPath(allowEnvOverrides = false): string | null {
  const moduleName = `os_guard_${process.platform}_${process.arch}.node`
  const plainName = 'os_guard.node'
  if (allowEnvOverrides) {
    const explicitEnvironment = process.env.ZTEXAM_NATIVE_ADDON
    if (explicitEnvironment && fs.existsSync(explicitEnvironment)) return explicitEnvironment
  }
  const candidates: string[] = []
  // dev: out/main → native/build/Release/os_guard.node
  candidates.push(path.resolve(__dirname, '../../native/build/Release'))
  if (process.resourcesPath) {
    // package: extraResources native/
    candidates.push(path.join(process.resourcesPath, 'native'))
  }
  for (const dir of candidates) {
    for (const name of [moduleName, plainName]) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

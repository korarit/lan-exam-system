import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { makeDetectionEvent } from './process-inspector'
import { JitteredScheduler } from './scheduler'
import type { DetectionEvent } from '@shared/policy-schema'

/* ============================================================
 * VsCodeController + VsCodeIntegrityWatchdog (Phase 5 — Mode 3)
 * - เปิด VS Code ใน "โปรไฟล์ควบคุม" (user-data-dir / extensions-dir ของเรา)
 *   พร้อม settings.json ที่ล็อก proxy/ปิด AI + ไม่แตะเปิด Marketplace
 * - Watchdog สุ่ม poll 3–6 วินาที:
 *   1. แฮช settings.json ขยับ = ถูกแก้ (เช่นเปลี่ยน http.proxy หลบ)
 *   2. มีไฟล์/โฟลเดอร์ใหม่ใน extensions-dir = แอบติดตั้ง Extension AI
 *   3. มี VS Code instance ที่ไม่ได้ใช้ --user-data-dir ของเรา หรือโปรแกรม
 *      ตระกูล AI IDE (Cursor/Windsurf) = UNAUTHORIZED_IDE_DETECTED
 * ทุกตัวฟ้องเป็น DetectionEvent (critical) เข้าท่อ GUARD_EVENT ของ GuardEngine
 * ============================================================ */

export interface VsCodeControllerOptions {
  emit: (event: DetectionEvent) => void
  now?: () => number
  /** inject สำหรับทดสอบ (default: systeminformation.processes) */
  listProcesses?: () => Promise<RogueProcessSnapshot[]>
}

/** สรุปโปรเซสขั้นต่ำที่ใช้ตรวจ IDE แปลกปลอม */
export interface RogueProcessSnapshot {
  exeName: string
  commandLine: string
}

/** เนื้อค่า settings.json ที่ล็อกไว้ (proxy + ปิด AI ทุกชั้นที่เปิดด้วย setting) */
export function buildLockedSettings(proxyPort: number): string {
  const settings = {
    'http.proxy': `http://127.0.0.1:${proxyPort}`,
    'http.proxyStrictSSL': true,
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'extensions.ignoreRecommendations': true,
    'extensions.enableMarketplace': false,
    'chat.commandCenter.enabled': false,
    'inlineChat.enabled': false,
    'github.copilot.enable': { '*': false },
    'telemetry.telemetryLevel': 'off'
  }
  return JSON.stringify(settings, null, 2)
}

export interface ControlledProfile {
  root: string
  userDataDir: string
  extensionsDir: string
  workspaceDir: string
}

export function findVsCodeBinary(): string | null {
  const override = process.env.ZTEXAM_VSCODE_PATH
  if (override && fs.existsSync(override)) return override
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Microsoft VS Code\\bin\\Code.exe',
          'C:\\Program Files (x86)\\Microsoft VS Code\\bin\\Code.exe',
          path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'bin', 'Code.exe')
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']
        : ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code']
  for (const file of candidates) {
    if (fs.existsSync(file)) return file
  }
  return null
}

export class VsCodeController {
  /** โปรไฟล์ที่เตรียมล่าสุด (ถูกต้องเฉพาะหลัง prepareProfile สำเร็จ) */
  private profile: ControlledProfile | null = null
  private watchdog: VsCodeIntegrityWatchdog | null = null
  readonly now: () => number

  constructor(private readonly opts: VsCodeControllerOptions) {
    this.now = opts.now ?? Date.now
  }

  get isLaunched(): boolean {
    return this.watchdog?.isRunning ?? false
  }

  get profileRootDir(): string | null {
    return this.profile?.root ?? null
  }

  /**
   * เตรียมโปรไฟล์ควบคุมต่อการสอบ:
   * - user-data/User/settings.json (ล็อกค่า)
   * - extensions/ เปล่า หรือคัดลอกจากไลบรารีที่ครูอนุมัติ
   *   (env ZTEXAM_VSCODE_EXTENSIONS_SRC = โฟลเดอร์ Extension ที่ตรวจแฮชแล้ว)
   * - workspace/ สำหรับซอร์สโค้ดของการสอบ
   */
  async prepareProfile(sessionId: string, proxyPort: number): Promise<{ ok: boolean; reason?: string }> {
    this.stop()
    if (proxyPort <= 0) return { ok: false, reason: 'PROXY_NOT_RUNNING' }
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'room'
    const root = path.join(os.tmpdir(), `ztexam-vscode-${safeId}`)
    const userDataDir = path.join(root, 'user-data')
    const extensionsDir = path.join(root, 'extensions')
    const workspaceDir = path.join(root, 'workspace')
    const userDir = path.join(userDataDir, 'User')
    try {
      await fsp.mkdir(userDir, { recursive: true })
      await fsp.mkdir(extensionsDir, { recursive: true })
      await fsp.mkdir(workspaceDir, { recursive: true })
      await fsp.writeFile(path.join(userDir, 'settings.json'), buildLockedSettings(proxyPort), 'utf8')
      // คัดลอก Extension ที่ครูอนุมัติล่วงหน้า (ถ้ามีโฟลเดอร์ไลบรารีระบุไว้)
      const src = process.env.ZTEXAM_VSCODE_EXTENSIONS_SRC
      if (src && fs.existsSync(src) && fs.statSync(src).isDirectory()) {
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const target = path.join(extensionsDir, entry.name)
          const source = path.join(src, entry.name)
          if (entry.isDirectory()) {
            await fsp.cp(source, target, { recursive: true })
          } else {
            await fsp.copyFile(source, target)
          }
        }
      }
    } catch (err) {
      return { ok: false, reason: `PROFILE_PREPARE_FAILED: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}` }
    }
    this.profile = { root, userDataDir, extensionsDir, workspaceDir }
    return { ok: true }
  }

  /** สั่งเปิด VS Code (detached) ในโปรไฟล์ควบคุม + เอนท่อ proxy เท่านั้น */
  async launch(proxyUrl: string): Promise<{ ok: boolean; reason?: string }> {
    const profile = this.profile
    if (!profile) return { ok: false, reason: 'PROFILE_NOT_PREPARED' }
    if (!proxyUrl || !proxyUrl.startsWith('http://127.0.0.1:')) {
      return { ok: false, reason: 'PROXY_NOT_RUNNING' }
    }
    const binary = findVsCodeBinary()
    if (!binary) return { ok: false, reason: 'VSCODE_NOT_INSTALLED' }
    try {
      const child = spawn(
        binary,
        [
          '--new-window',
          profile.workspaceDir,
          `--user-data-dir=${profile.userDataDir}`,
          `--extensions-dir=${profile.extensionsDir}`,
          '--disable-workspace-trust',
          '--disable-crash-reporter',
          '--disable-telemetry'
        ],
        {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            HTTP_PROXY: proxyUrl,
            HTTPS_PROXY: proxyUrl,
            NO_PROXY: 'localhost,127.0.0.1'
          }
        }
      )
      child.unref()
    } catch (err) {
      return { ok: false, reason: `SPAWN_FAILED: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}` }
    }
    this.startWatchdog()
    return { ok: true }
  }

  private startWatchdog(): void {
    if (!this.profile) return
    this.watchdog?.stop()
    const watchdogOpts: {
      getProfile: () => ControlledProfile | null
      emit: (event: DetectionEvent) => void
      listProcesses?: () => Promise<RogueProcessSnapshot[]>
      now?: () => number
    } = {
      getProfile: () => this.profile,
      emit: this.opts.emit,
      now: this.now
    }
    if (this.opts.listProcesses) watchdogOpts.listProcesses = this.opts.listProcesses
    this.watchdog = new VsCodeIntegrityWatchdog(watchdogOpts)
    this.watchdog.start()
  }

  stop(): void {
    this.watchdog?.stop()
    this.watchdog = null
  }
}

/* ============================================================
 * VsCodeIntegrityWatchdog — poll เป็นรอบสุ่ม 3–6 วินาที
 * (ไม่จับใน GuardEngine เพราะอายุการใช้งานผูกกับ VS Code ที่ปล่อยตัว
 * แยกออกไป — เรียก emit ผ่าน GuardEngine.pushExternalEvent ภายนอก)
 * ============================================================ */

interface ProfileSnapshot {
  settingsHash: string
  extensionsTreeHash: string
}

export class VsCodeIntegrityWatchdog {
  private scheduler: JitteredScheduler | null = null
  private baseline: ProfileSnapshot | null = null
  private lastTickAtMs = 0

  constructor(
    private readonly opts: {
      getProfile: () => ControlledProfile | null
      emit: (event: DetectionEvent) => void
      listProcesses?: () => Promise<RogueProcessSnapshot[]>
      now?: () => number
    }
  ) {}

  get isRunning(): boolean {
    return this.scheduler !== null
  }

  start(): void {
    if (this.scheduler) return
    // baseline เชิงเวลาเริ่ม — สถานะที่เพิ่งเตรียมคือสถานะอนุญาต
    this.baseline = null
    this.scheduler = new JitteredScheduler({
      minIntervalMs: 3_000,
      maxIntervalMs: 6_000,
      task: () => {
        void this.scanOnce()
      }
    })
    this.scheduler.start()
  }

  stop(): void {
    this.scheduler?.stop()
    this.scheduler = null
    this.baseline = null
  }

  getLastTickAtMs(): number {
    return this.lastTickAtMs
  }

  /** หนึ่งรอบตรวจ (public เพื่อเทสต์) — baseline เป็น null จะถูกกรอกหลังรอบแรก */
  async scanOnce(): Promise<void> {
    this.lastTickAtMs = this.opts.now?.() ?? Date.now()
    const profile = this.opts.getProfile()
    if (!profile) return
    let snapshot: ProfileSnapshot | null = null
    try {
      snapshot = await computeProfileSnapshot(profile)
    } catch {
      // เก็บแฮชไม่สำเร็จ (ไฟล์ล็อก/ขยับ) — ข้ามรอบนี้ ไม่ฟ้องเล็ก ๆ
      return
    }
    if (snapshot && this.baseline && (this.baseline.settingsHash !== snapshot.settingsHash ||
      this.baseline.extensionsTreeHash !== snapshot.extensionsTreeHash)) {
      let tamperKind = 'unknown'
      if (this.baseline.settingsHash !== snapshot.settingsHash) tamperKind = 'settings-modified'
      else tamperKind = 'extensions-changed'
      this.opts.emit(
        makeDetectionEvent('VSCODE_PROFILE_TAMPERED', 'vscode-watchdog', {
          kind: tamperKind,
          path: profile.root
        }, undefined, this.opts.now)
      )
      // baseline ใหม่เพื่อไม่ฟ้องซ้ำจากของเดิม (Triage correlation ช่วยไว้ด้วย)
      this.baseline = snapshot
    } else if (snapshot && !this.baseline) {
      this.baseline = snapshot
    }
    await this.scanRogueProcesses(profile)
  }

  /** VS Code นอกโปรไฟล์ควบคุม หรือ AI IDE กลุ่ม Cursor/Windsurf */
  private async scanRogueProcesses(profile: ControlledProfile): Promise<void> {
    const list = this.opts.listProcesses
      ?? defaultListProcesses
    let snapshot: RogueProcessSnapshot[]
    try {
      snapshot = await list()
    } catch {
      return
    }
    for (const processEntry of snapshot) {
      const name = processEntry.exeName.toLowerCase()
      const cmd = processEntry.commandLine.toLowerCase()
      // AI Editor กลุ่ม Cursor/Windsurf — ตัดตัวแรกเสมอ (policy ข้ออื่นดักอีกชั้น)
      const isAiIde =
        name === 'cursor.exe' || name === 'windsurf.exe' ||
        cmd.includes('cursor.app') || cmd.includes('windsurf.app')
      if (isAiIde) {
        this.opts.emit(
          makeDetectionEvent('UNAUTHORIZED_IDE_DETECTED', 'vscode-watchdog', {
            processName: name,
            kind: 'ai-editor'
          }, undefined, this.opts.now)
        )
        continue
      }
      const codeName = process.platform === 'win32' ? 'code.exe' : 'code'
      if (name !== codeName) continue
      // VS Code ที่เราเปิดจะมี --user-data-dir ของโปรไฟล์ควบคุมใน command line
      if (cmd.includes(profile.userDataDir.toLowerCase())) continue
      // แอป ZT-Exam เอง (สร้างจาก Electron shell ระหว่าง dev) — ไม่ใช่ VS Code จริง
      if (cmd.includes('ztexam') || cmd.includes('lan-exam-system')) continue
      this.opts.emit(
        makeDetectionEvent('UNAUTHORIZED_IDE_DETECTED', 'vscode-watchdog', {
          processName: name,
          kind: 'vscode-outside-profile'
        }, undefined, this.opts.now)
      )
    }
  }
}

/** hash snapshot ของ profile: settings.json ตรง ๆ + tree รายไฟล์ extensions */
export async function computeProfileSnapshot(profile: ControlledProfile): Promise<ProfileSnapshot> {
  const settingsPath = path.join(profile.userDataDir, 'User', 'settings.json')
  const settingsHash = createHash('sha256').update(await fsp.readFile(settingsPath)).digest('hex')
  // เหตุการณ์ตอนแพ็ก: รายชื่อไฟล์ (relative, sorted) + ขนาด + mtimeMs — แอบติดตั้ง = tree เปลี่ยน
  const parts: string[] = []
  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(profile.extensionsDir, rel)
    const stat = await fsp.stat(abs)
    if (stat.isFile()) {
      parts.push(`${rel}|${stat.size}|${stat.mtimeMs}`)
      return
    }
    parts.push(`${rel}/`)
    for (const entry of (await fsp.readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      await walk(path.join(rel, entry.name))
    }
  }
  for (const entry of (await fsp.readdir(profile.extensionsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    await walk(entry.name)
  }
  const extensionsTreeHash = createHash('sha256').update(parts.sort().join('\n')).digest('hex')
  return { settingsHash, extensionsTreeHash }
}

/** probe ปกติ — ทำงานร่วมกับ systeminformation ที่แอปใช้อยู่ (inject ได้ตอนเทสต์) */
async function defaultListProcesses(): Promise<RogueProcessSnapshot[]> {
  const si = await import('systeminformation')
  const data = await si.default.processes()
  return (data.list ?? [])
    .filter((entry) => typeof entry.pid === 'number' && entry.pid > 0)
    .map((entry) => ({
      exeName: (entry.name ?? '').toLowerCase(),
      commandLine: (entry.command ?? '').toLowerCase()
    }))
}

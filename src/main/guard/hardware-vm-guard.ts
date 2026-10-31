import os from 'node:os'
import fs from 'node:fs'
import type { DetectionEvent, DetectionPolicyBody } from '@shared/policy-schema'
import { makeDetectionEvent } from './process-inspector'
import { runCommand, runPowerShell } from './system-probes'

/* ============================================================
 * HardwareVmGuard — Phase 3a.7
 * 1) VM / Hypervisor fingerprinting (BIOS model, GPU, MAC prefix)
 *    รายงานเป็นสถานะเครื่องตั้งแต่ Lobby ให้ผู้คุมสอบทราบก่อนเริ่ม
 * 2) Display hotplug: เสียบ/ถอดจอระหว่างสอบ (HDMI dummy / capture card)
 * 3) Remote session: RDP ที่ต่างจากตอนเริ่ม
 * ============================================================ */

export const VM_MANUFACTURER_PATTERNS = [
  'vmware',
  'virtualbox',
  'qemu',
  'kvm',
  'bochs',
  'parallels',
  'xen',
  'microsoft corporation' // Hyper-V รายงานเป็น Microsoft
]

export const VM_MODEL_PATTERNS = [
  'vmware',
  'virtualbox',
  'qemu',
  'kvm',
  'bochs',
  'parallels',
  'xen',
  'hyper-v',
  'virtual machine'
]

export const VM_GPU_PATTERNS = [
  'vmware svga',
  'virtualbox graphics',
  'microsoft basic render driver',
  'red hat qxl',
  'cirrus logic',
  'nvidia mcst'
]

export const VM_MAC_PREFIXES = [
  '00:05:69', // VMware
  '00:0c:29', // VMware
  '00:50:56', // VMware
  '08:00:27', // VirtualBox
  '52:54:00', // QEMU/KVM
  '00:15:5d' // Hyper-V
]

export interface VmFingerprint {
  isVm: boolean
  signals: string[]
}

/** วิเคราะห์ VM จากข้อมูลฮาร์ดแวร์ (pure — ทดสอบได้) */
export function analyzeVmFingerprint(input: {
  manufacturer: string
  model: string
  gpuNames: string[]
  macAddresses: string[]
}): VmFingerprint {
  const signals: string[] = []
  const manufacturer = input.manufacturer.toLowerCase()
  const model = input.model.toLowerCase()
  if (VM_MANUFACTURER_PATTERNS.some((p) => manufacturer.includes(p))) {
    signals.push(`manufacturer:${input.manufacturer}`)
  }
  if (VM_MODEL_PATTERNS.some((p) => model.includes(p))) {
    signals.push(`model:${input.model}`)
  }
  for (const gpu of input.gpuNames) {
    if (VM_GPU_PATTERNS.some((p) => gpu.toLowerCase().includes(p))) {
      signals.push(`gpu:${gpu}`)
      break
    }
  }
  for (const mac of input.macAddresses) {
    const prefix = mac.toLowerCase().slice(0, 8)
    if (VM_MAC_PREFIXES.includes(prefix)) {
      signals.push(`mac-prefix:${prefix}`)
      break
    }
  }
  return { isVm: signals.length > 0, signals }
}

/** Windows: ชื่อ session ที่กำลังใช้งานจริง (บรรทัดที่ขึ้นต้นด้วย > จาก query session) */
export async function readActiveSessionNameWindows(): Promise<string | null> {
  const output = await runPowerShell('query session 2>$null')
  for (const line of output.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('>')) continue
    const name = line.replace(/^\s*>/, '').trim().split(/\s+/)[0]
    if (name) return name
  }
  return null
}

/* ============================================================
 * Remote session (RDP/SSH/VNC/Screen Sharing) — ตรวจได้ทุก OS
 * ============================================================ */

export interface RemoteSessionInput {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** ผลดิบ `query session` (Windows) */
  querySession?: string
  /** ผลดิบ `loginctl show-session ... -p Remote -p Type` (Linux) */
  loginctl?: string
  /** ผลดิบ `who` (Linux/macOS) */
  who?: string
}

export interface RemoteSessionVerdict {
  remote: boolean
  source: 'ssh' | 'rdp' | 'session' | 'who' | 'loginctl' | 'none'
  detail: string
}

/**
 * วิเคราะห์ว่า session ปัจจุบันเป็น remote หรือไม่ (pure — ทดสอบได้ทุก OS)
 * ครอบ: SSH env, Windows session name (RDP/RCA), Linux loginctl Remote=yes,
 * และ `who` ที่มี host ในวงเล็บ (SSH/X-forward/VNC)
 */
export function analyzeRemoteSession(input: RemoteSessionInput): RemoteSessionVerdict {
  const env = input.env
  const ssh = env.SSH_CONNECTION ?? env.SSH_CLIENT ?? env.SSH_TTY
  if (ssh) return { remote: true, source: 'ssh', detail: ssh.slice(0, 120) }

  if (input.platform === 'win32') {
    const fromQuery = (input.querySession ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^>\s*(rdp|rca|console)/i.test(line) || /rdp-tcp/i.test(line))
    if (fromQuery) {
      const lower = fromQuery.toLowerCase()
      if (lower.includes('rdp') || lower.includes('rca')) {
        return { remote: true, source: 'rdp', detail: fromQuery.slice(0, 120) }
      }
    }
    const sessionName = env.SESSIONNAME
    if (sessionName && /^rdp/i.test(sessionName)) {
      return { remote: true, source: 'rdp', detail: sessionName }
    }
  }

  if (input.loginctl) {
    const remoteLine = input.loginctl.split(/\r?\n/).find((line) => /^Remote=/i.test(line.trim()))
    if (remoteLine && /remote=yes/i.test(remoteLine)) {
      return { remote: true, source: 'loginctl', detail: input.loginctl.replace(/\s+/g, ' ').slice(0, 120) }
    }
  }

  const whoLine = (input.who ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => {
      const match = /\(([^)]+)\)\s*$/.exec(line)
      if (!match) return false
      const host = match[1]!.trim()
      return host.length > 0 && host.toLowerCase() !== 'console' && host.toLowerCase() !== ':0'
    })
  if (whoLine) return { remote: true, source: 'who', detail: whoLine.slice(0, 120) }

  return { remote: false, source: 'none', detail: '' }
}

async function readRemoteSessionVerdict(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env
): Promise<RemoteSessionVerdict> {
  if (platform === 'win32') {
    const querySession = await runPowerShell('query session 2>$null')
    return analyzeRemoteSession({ platform, env, querySession })
  }
  if (platform === 'linux') {
    const who = await runCommand('who', [])
    const sessionId = env.XDG_SESSION_ID
    const loginctl =
      sessionId !== undefined && sessionId !== ''
        ? await runCommand('loginctl', [
            'show-session',
            sessionId,
            '-p',
            'Remote',
            '-p',
            'Type'
          ])
        : ''
    return analyzeRemoteSession({ platform, env, who, loginctl })
  }
  // macOS: who แสดง remote login พร้อม host ในวงเล็บ
  const who = await runCommand('/usr/bin/who', [])
  return analyzeRemoteSession({ platform, env, who })
}

/* ============================================================
 * Hypervisor signals (Linux systemd-detect-virt / DMI, macOS sysctl)
 * ============================================================ */

export async function readHypervisorSignals(
  platform: NodeJS.Platform = process.platform
): Promise<string[]> {
  if (platform === 'darwin') {
    const out = await runCommand('/usr/sbin/sysctl', ['-n', 'kern.hv_vmm_present'])
    return out.trim() === '1' ? ['sysctl:kern.hv_vmm_present'] : []
  }
  if (platform === 'linux') {
    const detected = (await runCommand('systemd-detect-virt', ['--vm'])).trim()
    if (detected !== '' && detected !== 'none') return [`systemd-detect-virt:${detected}`]
    try {
      const vendor = fs.readFileSync('/sys/class/dmi/id/sys_vendor', 'utf8').trim()
      const product = fs.readFileSync('/sys/class/dmi/id/product_name', 'utf8').trim()
      const joined = `${vendor} ${product}`.toLowerCase()
      if (/qemu|kvm|vmware|virtualbox|innotek|xen|bochs|parallels|hyper-v/.test(joined)) {
        return [`dmi:${vendor} ${product}`.trim()]
      }
    } catch {
      // ไม่มี DMI (container/WSL บางแบบ) — ปล่อยผ่าน
    }
  }
  return []
}

export interface DisplaySnapshot {
  id: number
  label: string
}

export interface HardwareVmGuardOptions {
  getPolicy: () => DetectionPolicyBody | null
  emit: (event: DetectionEvent) => void
  /** ต่อ display เมื่อเกิด hotplug (จาก electron screen module) */
  onDisplayChanged?: (change: 'added' | 'removed' | 'metrics-changed') => void
  /** ชื่อ session ที่ใช้งานอยู่ (inject ได้เพื่อทดสอบ) */
  getActiveSessionName?: () => Promise<string | null>
  /** ตรวจ remote session แบบเต็ม (inject ได้เพื่อทดสอบ) */
  getRemoteSessionVerdict?: () => Promise<RemoteSessionVerdict>
  now?: () => number
}

export class HardwareVmGuard {
  readonly detectorId = 'hardware-vm-guard'
  private readonly now: () => number
  private started = false
  private lastTickAtMs = 0
  private displayCount = 0
  private unsubscribeDisplay: (() => void) | null = null
  private lastVmScanAtMs = 0
  private remoteReported = false
  private lastSessionCheckAtMs = 0
  private cachedSessionName: string | null = null
  private cachedRemoteVerdict: RemoteSessionVerdict | null = null
  private readonly getActiveSessionName: (() => Promise<string | null>) | null
  private readonly getRemoteSessionVerdict: () => Promise<RemoteSessionVerdict>
  private readonly useSessionNameProbe: boolean
  private static readonly VM_SCAN_INTERVAL_MS = 5 * 60_000
  private static readonly SESSION_CHECK_INTERVAL_MS = 15_000

  constructor(private readonly opts: HardwareVmGuardOptions) {
    this.now = opts.now ?? Date.now
    this.useSessionNameProbe = opts.getActiveSessionName !== undefined
    this.getActiveSessionName =
      opts.getActiveSessionName ??
      (process.platform === 'win32'
        ? readActiveSessionNameWindows
        : null)
    this.getRemoteSessionVerdict =
      opts.getRemoteSessionVerdict ??
      (() => readRemoteSessionVerdict(process.platform, process.env))
  }

  getLastTickAtMs(): number {
    return this.lastTickAtMs
  }

  start(): void {
    this.started = true
    this.lastTickAtMs = this.now()
  }

  stop(): void {
    this.started = false
    this.unsubscribeDisplay?.()
    this.unsubscribeDisplay = null
  }

  /** ตรวจ VM ครั้งเดียวตอนเข้า Lobby (รายงานสถานะ ไม่ใช่การตัดสิน) */
  async scanVmEnvironment(): Promise<DetectionEvent | null> {
    const event = await this.detectVmEnvironment()
    if (event) this.opts.emit(event)
    return event
  }

  private async detectVmEnvironment(): Promise<DetectionEvent | null> {
    try {
      const si = (await import('systeminformation')).default
      const [system, graphics] = await Promise.all([si.system(), si.graphics()])
      const macs = Object.values(os.networkInterfaces())
        .flat()
        .filter((n) => n?.mac)
        .map((n) => n!.mac)
      const fingerprint = analyzeVmFingerprint({
        manufacturer: system.manufacturer ?? '',
        model: system.model ?? '',
        gpuNames: (graphics.controllers ?? []).map((c) => c.model ?? ''),
        macAddresses: macs
      })
      // สัญญาณ hypervisor/VM จาก OS (Linux systemd-detect-virt/DMI, macOS sysctl)
      const hypervisorSignals = await readHypervisorSignals()
      for (const signal of hypervisorSignals) fingerprint.signals.push(signal)
      if (hypervisorSignals.length > 0) fingerprint.isVm = true
      if (!fingerprint.isVm) return null
      return makeDetectionEvent(
        'VM_ENVIRONMENT_DETECTED',
        this.detectorId,
        { signals: fingerprint.signals.join(';') },
        undefined,
        this.now
      )
    } catch {
      return null
    }
  }

  /** electron screen → เรียกเมื่อจอเปลี่ยน (กัน hotplug ระหว่างสอบ) */
  handleDisplayChanged(change: 'added' | 'removed' | 'metrics-changed', newCount: number): void {
    if (!this.started) return
    const baselineCount = this.displayCount
    this.displayCount = newCount
    // จอแรกตอน start ไม่ถือเป็นการเปลี่ยนแปลง
    if (baselineCount === 0) return
    this.opts.emit(
      makeDetectionEvent('DISPLAY_CONFIG_CHANGED', this.detectorId, {
        change,
        displayCount: String(newCount)
      })
    )
  }

  /** ตรวจ remote session และสภาพแวดล้อมเสมือนเป็นระยะ */
  async scanOnce(): Promise<DetectionEvent[]> {
    this.lastTickAtMs = this.now()
    const events: DetectionEvent[] = []
    let remote = false
    let remoteDetail = ''
    let remoteSource = 'none'
    if (
      this.lastSessionCheckAtMs === 0 ||
      this.now() - this.lastSessionCheckAtMs >= HardwareVmGuard.SESSION_CHECK_INTERVAL_MS
    ) {
      this.lastSessionCheckAtMs = this.now()
      if (this.useSessionNameProbe && this.getActiveSessionName) {
        try {
          this.cachedSessionName = await this.getActiveSessionName()
        } catch {
          this.cachedSessionName = null
        }
        const current = this.cachedSessionName ?? process.env.SESSIONNAME ?? null
        this.cachedRemoteVerdict = null
        if (current && /^rdp/i.test(current)) {
          remote = true
          remoteSource = 'session'
          remoteDetail = current
        }
      } else {
        try {
          this.cachedRemoteVerdict = await this.getRemoteSessionVerdict()
        } catch {
          this.cachedRemoteVerdict = null
        }
      }
    }
    if (!this.useSessionNameProbe) {
      const verdict = this.cachedRemoteVerdict
      if (verdict?.remote) {
        remote = true
        remoteSource = verdict.source
        remoteDetail = verdict.detail
      }
    }
    // รายงานครั้งเดียวต่อการเปลี่ยนสถานะ remote (กัน event ซ้ำ)
    if (remote) {
      if (!this.remoteReported) {
        this.remoteReported = true
        events.push(
          makeDetectionEvent('REMOTE_SESSION_SUSPECTED', this.detectorId, {
            source: remoteSource,
            detail: remoteDetail.slice(0, 200)
          })
        )
      }
    } else {
      this.remoteReported = false
    }
    if (this.now() - this.lastVmScanAtMs >= HardwareVmGuard.VM_SCAN_INTERVAL_MS) {
      this.lastVmScanAtMs = this.now()
      const vmEvent = await this.detectVmEnvironment()
      if (vmEvent) events.push(vmEvent)
    }
    for (const event of events) this.opts.emit(event)
    return events
  }

  /** ผูก electron screen events (main เรียกตอนสร้าง engine) */
  static wireElectronScreen(
    guard: HardwareVmGuard,
    screen: import('electron').Screen
  ): () => void {
    const initial = screen.getAllDisplays().length
    // บันทึกจำนวนจอเริ่มต้น (baseCount) ผ่าน handleDisplayChanged ครั้งแรก
    guard.handleDisplayChanged('metrics-changed', initial)
    const onAdded = (): void => guard.handleDisplayChanged('added', screen.getAllDisplays().length)
    const onRemoved = (): void => guard.handleDisplayChanged('removed', screen.getAllDisplays().length)
    screen.on('display-added', onAdded)
    screen.on('display-removed', onRemoved)
    return () => {
      screen.off('display-added', onAdded)
      screen.off('display-removed', onRemoved)
    }
  }
}

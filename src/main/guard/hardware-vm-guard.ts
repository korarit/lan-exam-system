import os from 'node:os'
import type { DetectionEvent, DetectionPolicyBody } from '@shared/policy-schema'
import { makeDetectionEvent } from './process-inspector'
import { runPowerShell } from './system-probes'

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
  private readonly getActiveSessionName: () => Promise<string | null>
  private static readonly VM_SCAN_INTERVAL_MS = 5 * 60_000
  private static readonly SESSION_CHECK_INTERVAL_MS = 15_000

  constructor(private readonly opts: HardwareVmGuardOptions) {
    this.now = opts.now ?? Date.now
    this.getActiveSessionName =
      opts.getActiveSessionName ??
      (process.platform === 'win32'
        ? readActiveSessionNameWindows
        : async () => process.env.SESSIONNAME ?? null)
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
    if (
      this.lastSessionCheckAtMs === 0 ||
      this.now() - this.lastSessionCheckAtMs >= HardwareVmGuard.SESSION_CHECK_INTERVAL_MS
    ) {
      this.lastSessionCheckAtMs = this.now()
      try {
        this.cachedSessionName = await this.getActiveSessionName()
      } catch {
        this.cachedSessionName = null
      }
    }
    const current = this.cachedSessionName ?? process.env.SESSIONNAME ?? null
    // ตรวจ session ที่ขึ้นต้นด้วย RDP (รายงานครั้งเดียวต่อรอบการตรวจจับ)
    if (current && current.toLowerCase().startsWith('rdp')) {
      if (!this.remoteReported) {
        this.remoteReported = true
        events.push(
          makeDetectionEvent('REMOTE_SESSION_SUSPECTED', this.detectorId, {
            sessionName: current
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

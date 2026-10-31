import type { DetectionEvent } from '@shared/policy-schema'
import { makeDetectionEvent } from './process-inspector'
import { runCommand, runPowerShellStrict } from './system-probes'
import { resolveTrustedExecutable } from './trusted-binary'

/* ============================================================
 * AccessibilityGuard (VULN-38)
 * - Windows: UiaClientsAreListening + SPI_GETSCREENREADER + ชื่อโปรเซสที่รู้จัก
 * - Linux: toolkit-accessibility / AT-SPI / orca
 * - macOS: VoiceOver / universal access
 * - ระหว่างสอบ: ปิด accessibility tree ของ Electron และรายงานถ้ามี client
 * หมายเหตุ: accessibility API เป็นช่องอ่านข้อความที่ไม่ต้องจับภาพหน้าจอ
 * ============================================================ */

export interface AccessibilitySnapshot {
  platform: NodeJS.Platform
  /** มี UIA client ใด ๆ กำลังฟังอยู่ (Windows) */
  uiaClientsListening?: boolean
  /** SPI_GETSCREENREADER (Windows) */
  screenReaderFlag?: boolean
  /** ชื่อโปรเซสที่ตรงกับรายการที่รู้จัก (lowercase) */
  processes: string[]
  /** Linux: gsettings toolkit-accessibility = true */
  toolkitAccessibility?: boolean
  /** macOS: VoiceOver เปิดอยู่ */
  voiceOver?: boolean
  /** accessibility tree ของ Electron ถูกเปิดอยู่หรือไม่ */
  treeEnabled?: boolean
}

export interface AccessibilityFinding {
  code: 'ACCESSIBILITY_EXFILTRATION_DETECTED' | 'ACCESSIBILITY_CLIENT_DETECTED'
  reason: string
  detail: Record<string, string>
}

const KNOWN_ASSISTIVE_PROCESSES = [
  'narrator',
  'nvda',
  'jaws',
  'windoweyes',
  'zoomtext',
  'dragon',
  'voiceaccess',
  'orca',
  'voiceover',
  'speechd',
  'speech-dispatcher'
]

export function normalizeProcessName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name
  return base.toLowerCase().replace(/\.exe$/, '').trim()
}

export function matchAssistiveProcesses(names: readonly string[]): string[] {
  const matched = new Set<string>()
  for (const name of names) {
    const normalized = normalizeProcessName(name)
    if (normalized === '') continue
    if (KNOWN_ASSISTIVE_PROCESSES.includes(normalized)) matched.add(normalized)
  }
  return [...matched]
}

/** วิเคราะห์ snapshot แบบ pure */
export function analyzeAccessibilitySnapshot(
  snapshot: AccessibilitySnapshot
): AccessibilityFinding[] {
  const findings: AccessibilityFinding[] = []
  const matched = matchAssistiveProcesses(snapshot.processes)
  const strongSignal =
    matched.length > 0 ||
    snapshot.screenReaderFlag === true ||
    snapshot.toolkitAccessibility === true ||
    snapshot.voiceOver === true

  if (strongSignal) {
    findings.push({
      code: 'ACCESSIBILITY_EXFILTRATION_DETECTED',
      reason: snapshot.screenReaderFlag === true ? 'screen-reader-flag' : 'assistive-client',
      detail: {
        detail: matched.join(',') || (snapshot.voiceOver === true ? 'voiceover' : ''),
        processName: matched[0] ?? '',
        platform: snapshot.platform
      }
    })
  } else if (snapshot.uiaClientsListening === true || snapshot.treeEnabled === true) {
    // UIA client ทั่วไป (อาจเป็นเครื่องมือ automation ที่ไม่ปรากฏชื่อ) → เตือนให้ครูตรวจ
    findings.push({
      code: 'ACCESSIBILITY_CLIENT_DETECTED',
      reason: snapshot.treeEnabled === true ? 'accessibility-tree-enabled' : 'uia-listening',
      detail: {
        platform: snapshot.platform,
        treeEnabled: snapshot.treeEnabled === true ? 'true' : 'false'
      }
    })
  }
  return findings
}

/* ============================================================
 * Platform probes
 * ============================================================ */

function buildWindowsAccessibilityScript(): string {
  return [
    `Add-Type -TypeDefinition @'`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public static class ZTA11y {`,
    `  [DllImport("UIAutomationCore.dll")] public static extern bool UiaClientsAreListening();`,
    `  [DllImport("user32.dll", SetLastError=true)] public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, out int pvParam, uint fWinIni);`,
    `}`,
    `'@`,
    `$uia = $false`,
    `try { $uia = [ZTA11y]::UiaClientsAreListening() } catch {}`,
    `$sr = 0`,
    `try { $null = [ZTA11y]::SystemParametersInfo(0x0046, 0, [ref]$sr, 0) } catch {}`,
    `$names = @('narrator','nvda','jaws','windoweyes','zoomtext','dragon','voiceaccess','orca','voiceover','speechd','speech-dispatcher')`,
    `$procs = @()`,
    `try {`,
    `  $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.ProcessName.ToLower() } | Select-Object -ExpandProperty ProcessName -Unique`,
    `} catch {}`,
    `[pscustomobject]@{ uiaClientsListening = $uia; screenReaderFlag = ($sr -ne 0); processes = @($procs) } | ConvertTo-Json -Compress`
  ].join('\n')
}

async function readWindowsSnapshot(): Promise<AccessibilitySnapshot | null> {
  const result = await runPowerShellStrict(buildWindowsAccessibilityScript(), 8_000)
  if (!result.ok) return null
  try {
    const parsed = JSON.parse(result.stdout) as {
      uiaClientsListening?: unknown
      screenReaderFlag?: unknown
      processes?: unknown
    }
    const processList = Array.isArray(parsed.processes)
      ? parsed.processes.filter((value): value is string => typeof value === 'string')
      : typeof parsed.processes === 'string'
        ? [parsed.processes]
        : []
    return {
      platform: 'win32',
      uiaClientsListening: parsed.uiaClientsListening === true,
      screenReaderFlag: parsed.screenReaderFlag === true,
      processes: processList
    }
  } catch {
    return null
  }
}

async function readLinuxSnapshot(): Promise<AccessibilitySnapshot | null> {
  const [settings, psOutput] = await Promise.all([
    runCommand(resolveTrustedExecutable('gsettings'), ['get', 'org.gnome.desktop.interface', 'toolkit-accessibility'], 4_000),
    runCommand(resolveTrustedExecutable('ps'), ['-axo', 'comm='], 4_000)
  ])
  const processes = psOutput
    .split(/\r?\n/)
    .map((line) => normalizeProcessName(line))
    .filter((name) => name !== '')
  const toolkitAccessibility = /true/i.test(settings) || Boolean(process.env.AT_SPI_BUS || process.env.AT_SPI_BUS_ADDRESS)
  return {
    platform: 'linux',
    processes,
    toolkitAccessibility
  }
}

async function readMacSnapshot(): Promise<AccessibilitySnapshot | null> {
  const [defaults, psOutput] = await Promise.all([
    runCommand(resolveTrustedExecutable('defaults'), ['read', 'com.apple.universalaccess', 'voiceOverOn'], 4_000),
    runCommand(resolveTrustedExecutable('ps'), ['-axo', 'comm='], 4_000)
  ])
  const processes = psOutput
    .split(/\r?\n/)
    .map((line) => normalizeProcessName(line))
    .filter((name) => name !== '')
  const voiceOver = /1|true|yes/i.test(defaults) || processes.includes('voiceover')
  return {
    platform: 'darwin',
    processes,
    voiceOver
  }
}

export async function collectAccessibilitySnapshot(
  platform: NodeJS.Platform = process.platform
): Promise<AccessibilitySnapshot | null> {
  if (platform === 'win32') return readWindowsSnapshot()
  if (platform === 'linux') return readLinuxSnapshot()
  if (platform === 'darwin') return readMacSnapshot()
  return null
}

/* ============================================================
 * Guard
 * ============================================================ */

export interface AccessibilityGuardOptions {
  emit: (event: DetectionEvent) => void
  readSnapshot?: () => Promise<AccessibilitySnapshot | null>
  /** Electron: accessibility tree ถูกเปิดอยู่หรือไม่ (ปกติต้องปิดระหว่างสอบ) */
  isAccessibilityTreeEnabled?: () => boolean
  platform?: NodeJS.Platform
  /** ระยะห่างขั้นต่ำระหว่าง probe จริง (PowerShell มีต้นทุน) */
  minScanIntervalMs?: number
  now?: () => number
}

export class AccessibilityGuard {
  readonly detectorId = 'accessibility-guard'
  private readonly platform: NodeJS.Platform
  private readonly readSnapshot: () => Promise<AccessibilitySnapshot | null>
  private readonly now: () => number
  private readonly minScanIntervalMs: number
  private readonly reported = new Map<string, number>()
  private readonly probeFailures = new Map<string, number>()
  private lastTickAtMs = 0
  private lastRealScanAtMs = 0

  constructor(private readonly opts: AccessibilityGuardOptions) {
    this.platform = opts.platform ?? process.platform
    this.readSnapshot = opts.readSnapshot ?? (() => collectAccessibilitySnapshot(this.platform))
    this.minScanIntervalMs = opts.minScanIntervalMs ?? 15_000
    this.now = opts.now ?? Date.now
  }

  getLastTickAtMs(): number {
    return this.lastTickAtMs
  }

  start(): void {
    this.lastTickAtMs = this.now()
  }

  stop(): void {}

  async scanOnce(): Promise<DetectionEvent[]> {
    this.lastTickAtMs = this.now()
    if (this.lastRealScanAtMs !== 0 && this.now() - this.lastRealScanAtMs < this.minScanIntervalMs) {
      return []
    }
    this.lastRealScanAtMs = this.now()
    let snapshot: AccessibilitySnapshot | null
    try {
      snapshot = await this.readSnapshot()
    } catch (error) {
      this.reportProbeFailure(error instanceof Error ? error.message : 'snapshot-failed')
      return []
    }
    if (!snapshot) {
      this.reportProbeFailure('snapshot-empty')
      return []
    }
    this.probeFailures.delete('accessibility-snapshot')
    let treeEnabled = false
    try {
      treeEnabled = this.opts.isAccessibilityTreeEnabled?.() === true
    } catch {
      treeEnabled = false
    }
    const findings = analyzeAccessibilitySnapshot({ ...snapshot, treeEnabled })
    const events: DetectionEvent[] = []
    for (const finding of findings) {
      const signature = `${finding.code}:${finding.reason}`
      // warning ทั่วไป (UIA client) ไม่ควรยิงถี่ — ลด alert fatigue
      const cooldownMs = finding.code === 'ACCESSIBILITY_CLIENT_DETECTED' ? 300_000 : 60_000
      if (!this.shouldReport(signature, cooldownMs)) continue
      events.push(makeDetectionEvent(finding.code, this.detectorId, finding.detail, undefined, this.now))
    }
    for (const event of events) this.opts.emit(event)
    return events
  }

  private shouldReport(signature: string, cooldownMs: number): boolean {
    const last = this.reported.get(signature)
    if (last !== undefined && this.now() - last < cooldownMs) return false
    this.reported.set(signature, this.now())
    return true
  }

  private reportProbeFailure(reason: string): void {
    const count = (this.probeFailures.get('accessibility-snapshot') ?? 0) + 1
    this.probeFailures.set('accessibility-snapshot', count)
    if (count === 2 || (count > 2 && count % 10 === 0)) {
      this.opts.emit(
        makeDetectionEvent(
          'GUARD_PROBE_FAILED',
          this.detectorId,
          {
            probe: 'accessibility-snapshot',
            consecutiveFailures: String(count),
            reason: reason.slice(0, 300)
          },
          undefined,
          this.now
        )
      )
    }
  }
}

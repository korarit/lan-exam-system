import fs from 'node:fs'
import path from 'node:path'
import type { DetectionEvent } from '@shared/policy-schema'
import { runCommand, runPowerShell } from './system-probes'
import { makeDetectionEvent } from './process-inspector'

/* ============================================================
 * SelfIntegrityGuard — Phase 3a.6
 * 1) Debugger attachment: IsDebuggerPresent / CheckRemoteDebuggerPresent
 *    (Windows), TracerPid (/proc/self/status), P_TRACED (macOS sysctl)
 * 2) Injected module scan: frida-agent / speedhack / dll จาก Temp-Downloads
 * ============================================================ */

export const FOREIGN_MODULE_PATTERNS = [
  'frida-agent',
  'frida-gum',
  'vehdebug',
  'speedhack',
  'minhook',
  'detours',
  'cheatengine'
]

export function isForeignModulePath(modulePath: string): boolean {
  const lower = modulePath.toLowerCase()
  if (FOREIGN_MODULE_PATTERNS.some((pattern) => lower.includes(pattern))) return true
  // โมดูลที่ถูกโหลดจาก Temp/Downloads ของผู้ใช้ = พฤติกรรมฉีด DLL ทั่วไป
  const temp = path.join(process.env.TEMP ?? '', '').toLowerCase()
  if (temp && lower.startsWith(temp)) return true
  if (lower.includes('\\downloads\\') || lower.includes('/downloads/')) return true
  return false
}

/** Linux: ตรวจ TracerPid จาก /proc/self/status (คืน pid ของ tracer หรือ 0) */
export async function readLinuxTracerPid(): Promise<number> {
  try {
    const status = await fs.promises.readFile('/proc/self/status', 'utf8')
    const match = status.match(/^TracerPid:\s+(\d+)/m)
    return match ? Number(match[1]) : 0
  } catch {
    return 0
  }
}

async function checkDebuggerWindows(): Promise<boolean> {
  const script = [
    `Add-Type -TypeDefinition @"`,
    `using System; using System.Runtime.InteropServices;`,
    `public static class ZTDbg {`,
    `  [DllImport("kernel32.dll")] public static extern bool IsDebuggerPresent();`,
    `  [DllImport("kernel32.dll")] public static extern bool CheckRemoteDebuggerPresent(IntPtr h, ref bool b);`,
    `}`,
    `"@`,
    `$remote = $false`,
    `[void][ZTDbg]::CheckRemoteDebuggerPresent([System.Diagnostics.Process]::GetCurrentProcess().Handle, [ref]$remote)`,
    `if ([ZTDbg]::IsDebuggerPresent() -or $remote) { 'DEBUGGER' }`
  ].join('\n')
  const output = await runPowerShell(script, 4_000)
  return output.includes('DEBUGGER')
}

async function checkDebuggerMac(): Promise<boolean> {
  const output = await runCommand(
    '/usr/sbin/sysctl',
    [`-n`, `kern.proc.pid.${process.pid}`],
    3_000
  )
  // ผลลัพธ์เป็น struct เลขฐาน 16 — flag P_TRACED = 0x00000400 ใน p_flag (offset ใกล้ท้าย)
  if (!output) return false
  return /04 00/.test(output)
}

async function listForeignModulesWindows(): Promise<string[]> {
  const script = `(Get-Process -Id ${process.pid} -Module -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FileName)`
  const output = await runPowerShell(script, 5_000)
  return output
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isForeignModulePath(s))
}

async function listForeignModulesLinux(): Promise<string[]> {
  try {
    const maps = await fs.promises.readFile('/proc/self/maps', 'utf8')
    const paths = new Set<string>()
    for (const line of maps.split('\n')) {
      const file = line.slice(line.lastIndexOf(' ') + 1).trim()
      if (!file.startsWith('/')) continue
      if (isForeignModulePath(file)) paths.add(file)
    }
    return [...paths]
  } catch {
    return []
  }
}

export interface SelfIntegrityGuardOptions {
  emit: (event: DetectionEvent) => void
  checkDebugger?: () => Promise<boolean>
  listForeignModules?: () => Promise<string[]>
  now?: () => number
}

export class SelfIntegrityGuard {
  readonly detectorId = 'self-integrity-guard'
  private readonly now: () => number
  private readonly checkDebugger: () => Promise<boolean>
  private readonly listForeignModules: () => Promise<string[]>
  private lastTickAtMs = 0

  constructor(private readonly opts: SelfIntegrityGuardOptions) {
    this.now = opts.now ?? Date.now
    this.checkDebugger =
      opts.checkDebugger ??
      (process.platform === 'win32'
        ? checkDebuggerWindows
        : process.platform === 'linux'
          ? async () => (await readLinuxTracerPid()) !== 0
          : process.platform === 'darwin'
            ? checkDebuggerMac
            : async () => false)
    this.listForeignModules =
      opts.listForeignModules ??
      (process.platform === 'win32'
        ? listForeignModulesWindows
        : process.platform === 'linux'
          ? listForeignModulesLinux
          : async () => [])
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
    const events: DetectionEvent[] = []

    /* ---------- Debugger ---------- */
    try {
      const attached = await this.checkDebugger()
      if (attached) {
        events.push(
          makeDetectionEvent('DEBUGGER_ATTACHED', this.detectorId, {
            method: process.platform === 'linux' ? 'TracerPid' : process.platform
          })
        )
      }
    } catch {
      // ตรวจไม่ได้ — ข้าม
    }

    /* ---------- Injected modules ---------- */
    try {
      const modules = await this.listForeignModules()
      for (const modulePath of modules.slice(0, 10)) {
        events.push(
          makeDetectionEvent('FOREIGN_MODULE_INJECTED', this.detectorId, {
            modulePath
          })
        )
      }
    } catch {
      // สแกนไม่ได้ — ข้าม
    }

    for (const event of events) this.opts.emit(event)
    return events
  }
}

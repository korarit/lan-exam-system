import fs from 'node:fs'
import path from 'node:path'
import type { DetectionEvent } from '@shared/policy-schema'
import { makeDetectionEvent } from './process-inspector'
import { isForeignModulePath } from './self-integrity-guard'
import { runCommand, runPowerShellStrict } from './system-probes'
import { resolveTrustedExecutable } from './trusted-binary'

/* ============================================================
 * RuntimeIntegrityGuard (VULN-05 / VULN-16 / VULN-38)
 * - ตรวจว่า process ที่รันอยู่ "เป็น build ที่ควรเป็น" ไม่ใช่ wrapper
 *   ที่รันโค้ดจากที่อื่นแต่เก็บ app.asar ตัวจริงไว้ให้ attestation ผ่าน
 * - ตรวจโมดูลที่โหลดเข้ามา (รวม macOS ที่เดิมไม่มี probe)
 * - ตรวจเธรดที่เริ่มทำงานนอกโมดูลของแอป (CreateRemoteThread / manual map)
 * ทำงานแบบ Detect & Report — ส่ง event ให้เครื่องแม่ตัดสิน
 * ============================================================ */

export interface RuntimeModule {
  path: string
  baseAddress?: number
  size?: number
}

export interface RuntimeThread {
  id: number
  startAddress?: number
}

export interface RuntimeSnapshot {
  platform: NodeJS.Platform
  executablePath: string
  commandLine: string
  resourcesPath: string
  addonPath?: string | null
  defaultApp: boolean
  packaged: boolean
  modules: RuntimeModule[]
  threads: RuntimeThread[]
}

export interface RuntimeExpectation {
  packaged: boolean
  /** ชื่อไฟล์ executable ที่คาดหวัง (ตัวพิมพ์ไม่สำคัญ) */
  executableName?: string
  /** resources root ที่คาดหวัง */
  resourcesPath?: string
  /** path ของ native addon ที่ manifest ครอบ */
  addonPath?: string | null
  /** root เพิ่มเติมที่อนุญาต (เช่น project root ใน dev) */
  allowedRoots?: string[]
}

export interface RuntimeFinding {
  code: 'RUNTIME_PATH_TAMPERED' | 'FOREIGN_MODULE_INJECTED' | 'INJECTED_THREAD_DETECTED'
  reason: string
  detail: Record<string, string>
}

const DANGEROUS_RUNTIME_FLAGS = [
  '--app',
  '--user-data-dir',
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--remote-allow-origins',
  '--inspect',
  '--inspect-brk',
  '--inspect-port',
  '--load-extension',
  '--disable-extensions-except',
  '--disable-web-security',
  '--allow-running-insecure-content',
  '--allow-file-access-from-files',
  '--host-resolver-rules',
  '--proxy-server',
  '--proxy-bypass-list',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--js-flags',
  '--unsafely-treat-insecure-origin-as-secure'
]

const USER_WRITABLE_MARKERS = [
  '\\appdata\\',
  '\\temp\\',
  '\\downloads\\',
  '\\desktop\\',
  '\\users\\',
  '\\programdata\\',
  '/appdata/',
  '/temp/',
  '/downloads/',
  '/desktop/',
  '/users/',
  '/programdata/',
  '/tmp/',
  '/home/',
  '/private/var/folders/',
  '/var/tmp/'
]

const SYSTEM_MODULE_MARKERS: Partial<Record<NodeJS.Platform, string[]>> = {
  win32: [
    // เขียนได้เฉพาะ admin — standard user วางโมดูลเองไม่ได้
    '/windows/',
    '/program files/',
    '/program files (x86)/'
  ],
  darwin: ['/system/', '/usr/lib/', '/library/apple/'],
  linux: ['/usr/lib/', '/usr/lib64/', '/lib/', '/lib64/']
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

function hasPathMarker(value: string, markers: string[]): boolean {
  const normalized = normalizePath(value)
  return markers.some((marker) => normalized.includes(normalizePath(marker)))
}

/** อยู่ใต้ root หรือไม่ (เทียบแบบ boundary ไม่ใช่ substring) */
export function isPathInside(candidate: string, root: string): boolean {
  if (!candidate || !root) return false
  const c = normalizePath(candidate).replace(/\/+$/, '')
  const r = normalizePath(root).replace(/\/+$/, '')
  if (r === '') return false
  return c === r || c.startsWith(`${r}/`)
}

export function isUserWritableModulePath(modulePath: string): boolean {
  return hasPathMarker(modulePath, USER_WRITABLE_MARKERS)
}

function isSystemModulePath(modulePath: string, platform: NodeJS.Platform): boolean {
  const normalized = normalizePath(modulePath)
  const markers = SYSTEM_MODULE_MARKERS[platform] ?? []
  return markers.some((marker) => normalized.includes(marker))
}

/** แยก argv จาก command line แบบหยาบ (รองรับ quote เดี่ยว/คู่) */
export function parseCommandLineArgs(commandLine: string): string[] {
  const args: string[] = []
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of commandLine.matchAll(regex)) {
    const value = match[1] ?? match[2] ?? match[3] ?? ''
    if (value !== '') args.push(value)
  }
  return args
}

export function findDangerousRuntimeFlags(commandLine: string): string[] {
  const args = parseCommandLineArgs(commandLine)
  const found = new Set<string>()
  for (const arg of args) {
    if (!arg.startsWith('--')) continue
    const bare = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (DANGEROUS_RUNTIME_FLAGS.includes(bare)) found.add(bare)
  }
  return [...found]
}

function looksLikePath(value: string): boolean {
  if (!value || value.startsWith('-')) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\') || value.includes('\\')
}

/** macOS: /Applications/ZT-Exam.app/Contents/MacOS/ZT-Exam → /Applications/ZT-Exam.app */
function deriveMacBundleRoot(executablePath: string): string | null {
  const marker = '.app/'
  const index = executablePath.toLowerCase().indexOf(marker)
  if (index < 0) return null
  return executablePath.slice(0, index + marker.length - 1)
}

function isAllowedRuntimePath(value: string, snapshot: RuntimeSnapshot, expectation: RuntimeExpectation): boolean {
  const roots = new Set<string>()
  if (snapshot.resourcesPath) roots.add(snapshot.resourcesPath)
  if (snapshot.executablePath) {
    roots.add(path.dirname(snapshot.executablePath))
    const bundleRoot = deriveMacBundleRoot(snapshot.executablePath)
    if (bundleRoot) roots.add(bundleRoot)
  }
  if (snapshot.addonPath) roots.add(path.dirname(snapshot.addonPath))
  for (const root of expectation.allowedRoots ?? []) roots.add(root)
  return [...roots].some((root) => isPathInside(value, root))
}

/** หาโมดูลที่ครอบ address (ใช้ตรวจ injected thread) */
function moduleForAddress(
  address: number,
  modules: RuntimeModule[]
): RuntimeModule | null {
  for (const module of modules) {
    if (module.baseAddress === undefined || module.size === undefined) continue
    if (address >= module.baseAddress && address < module.baseAddress + module.size) return module
  }
  return null
}

/**
 * วิเคราะห์ snapshot แบบ pure — คืน finding ทั้งหมดที่ควรแจ้งเครื่องแม่
 */
export function analyzeRuntimeSnapshot(
  snapshot: RuntimeSnapshot,
  expectation: RuntimeExpectation
): RuntimeFinding[] {
  const findings: RuntimeFinding[] = []
  const push = (finding: RuntimeFinding): void => {
    const duplicate = findings.some(
      (existing) => existing.code === finding.code && existing.reason === finding.reason
    )
    if (!duplicate) findings.push(finding)
  }

  /* ---------- 1) ตัว process เองถูกรันจากที่อื่นหรือไม่ ---------- */
  if (expectation.packaged && !snapshot.packaged) {
    push({
      code: 'RUNTIME_PATH_TAMPERED',
      reason: 'unpackaged-runtime',
      detail: { executablePath: snapshot.executablePath.slice(0, 300) }
    })
  }
  if (expectation.packaged && snapshot.defaultApp) {
    push({
      code: 'RUNTIME_PATH_TAMPERED',
      reason: 'default-app',
      detail: { executablePath: snapshot.executablePath.slice(0, 300) }
    })
  }
  if (expectation.executableName) {
    const actual = path.basename(snapshot.executablePath).toLowerCase()
    if (actual !== expectation.executableName.toLowerCase()) {
      push({
        code: 'RUNTIME_PATH_TAMPERED',
        reason: 'executable-name',
        detail: {
          expected: expectation.executableName.slice(0, 120),
          actual: actual.slice(0, 120)
        }
      })
    }
  }
  if (expectation.resourcesPath && snapshot.resourcesPath) {
    if (normalizePath(expectation.resourcesPath) !== normalizePath(snapshot.resourcesPath)) {
      push({
        code: 'RUNTIME_PATH_TAMPERED',
        reason: 'resources-path',
        detail: {
          expected: expectation.resourcesPath.slice(0, 300),
          actual: snapshot.resourcesPath.slice(0, 300)
        }
      })
    }
  }
  // ตรวจ command line เฉพาะ packaged build (dev มี flag ของ toolchain ปนได้)
  if (expectation.packaged) {
    for (const flag of findDangerousRuntimeFlags(snapshot.commandLine)) {
      push({
        code: 'RUNTIME_PATH_TAMPERED',
        reason: `command-line-flag:${flag}`,
        detail: { flag, commandLine: snapshot.commandLine.slice(0, 400) }
      })
    }

    // wrapper ที่รันโค้ดจากที่อื่น: มี path ของ .asar/.js นอก resources root
    for (const rawArg of parseCommandLineArgs(snapshot.commandLine)) {
      let candidate = rawArg
      if (candidate.startsWith('--')) {
        const eq = candidate.indexOf('=')
        if (eq < 0) continue
        candidate = candidate.slice(eq + 1).replace(/^["']|["']$/g, '')
      }
      if (!looksLikePath(candidate)) continue
      if (candidate === snapshot.executablePath) continue
      if (!/\.(asar|js|mjs|cjs|ts)$/i.test(candidate)) continue
      if (isAllowedRuntimePath(candidate, snapshot, expectation)) continue
      push({
        code: 'RUNTIME_PATH_TAMPERED',
        reason: 'external-app-path',
        detail: { argument: candidate.slice(0, 300) }
      })
    }
  }

  /* ---------- 2) โมดูลที่โหลดเข้ามา ---------- */
  const seenModules = new Set<string>()
  for (const module of snapshot.modules) {
    const modulePath = module.path ?? ''
    if (modulePath === '') {
      push({
        code: 'FOREIGN_MODULE_INJECTED',
        reason: 'unbacked-module',
        detail: {}
      })
      continue
    }
    const key = normalizePath(modulePath)
    if (seenModules.has(key)) continue
    seenModules.add(key)
    if (modulePath.toLowerCase().includes(' (deleted)')) {
      push({
        code: 'FOREIGN_MODULE_INJECTED',
        reason: 'deleted-module',
        detail: { modulePath: modulePath.slice(0, 300) }
      })
      continue
    }
    if (isForeignModulePath(modulePath)) {
      push({
        code: 'FOREIGN_MODULE_INJECTED',
        reason: 'known-injection-pattern',
        detail: { modulePath: modulePath.slice(0, 300) }
      })
      continue
    }
    if (isUserWritableModulePath(modulePath)) {
      push({
        code: 'FOREIGN_MODULE_INJECTED',
        reason: 'user-writable-module',
        detail: { modulePath: modulePath.slice(0, 300) }
      })
      continue
    }
    const insideApp = isAllowedRuntimePath(modulePath, snapshot, expectation)
    if (!insideApp && !isSystemModulePath(modulePath, snapshot.platform)) {
      push({
        code: 'FOREIGN_MODULE_INJECTED',
        reason: 'outside-app-root',
        detail: { modulePath: modulePath.slice(0, 300) }
      })
    }
  }

  /* ---------- 3) เธรดที่เริ่มนอกโมดูล = injected thread ---------- */
  for (const thread of snapshot.threads) {
    if (thread.startAddress === undefined) continue
    const owner = moduleForAddress(thread.startAddress, snapshot.modules)
    if (!owner) {
      // ไม่มีช่วง address ของโมดูลให้เทียบ (เช่น Linux) — ข้ามเพื่อกัน false positive
      if (snapshot.modules.some((m) => m.baseAddress !== undefined && m.size !== undefined)) {
        push({
          code: 'INJECTED_THREAD_DETECTED',
          reason: 'unbacked-thread',
          detail: {
            threadId: String(thread.id),
            startAddress: `0x${thread.startAddress.toString(16)}`
          }
        })
      }
      continue
    }
    if (isUserWritableModulePath(owner.path) || isForeignModulePath(owner.path)) {
      push({
        code: 'INJECTED_THREAD_DETECTED',
        reason: 'thread-in-foreign-module',
        detail: {
          threadId: String(thread.id),
          modulePath: owner.path.slice(0, 300)
        }
      })
    }
  }

  return findings
}

/* ============================================================
 * Platform probes
 * ============================================================ */

function buildWindowsProbeScript(pid: number): string {
  return [
    `$targetPid = ${pid}`,
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue`,
    `$modules = @()`,
    `try {`,
    `  $modules = Get-Process -Id $targetPid -Module -ErrorAction SilentlyContinue | ForEach-Object {`,
    `    [pscustomobject]@{ path = $_.FileName; baseAddress = $_.BaseAddress.ToInt64(); size = $_.ModuleMemorySize }`,
    `  }`,
    `} catch {}`,
    `$threads = @()`,
    `try {`,
    `  $threads = (Get-Process -Id $targetPid -ErrorAction SilentlyContinue).Threads | ForEach-Object {`,
    `    $addr = $null`,
    `    try { $addr = $_.StartAddress.ToInt64() } catch {}`,
    `    [pscustomobject]@{ id = $_.Id; startAddress = $addr }`,
    `  }`,
    `} catch {}`,
    `[pscustomobject]@{`,
    `  executablePath = $p.ExecutablePath`,
    `  commandLine = $p.CommandLine`,
    `  modules = @($modules)`,
    `  threads = @($threads)`,
    `} | ConvertTo-Json -Depth 5 -Compress`
  ].join('\n')
}

interface WindowsProbeResult {
  executablePath?: string
  commandLine?: string
  modules?: unknown
  threads?: unknown
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

function parseWindowsModules(value: unknown): RuntimeModule[] {
  const modules: RuntimeModule[] = []
  for (const item of asArray(value)) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const modulePath = typeof record.path === 'string' ? record.path : ''
    const baseAddress = typeof record.baseAddress === 'number' ? record.baseAddress : undefined
    const size = typeof record.size === 'number' ? record.size : undefined
    modules.push({
      path: modulePath,
      ...(baseAddress !== undefined ? { baseAddress } : {}),
      ...(size !== undefined ? { size } : {})
    })
  }
  return modules
}

function parseWindowsThreads(value: unknown): RuntimeThread[] {
  const threads: RuntimeThread[] = []
  for (const item of asArray(value)) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'number' ? record.id : Number(record.id)
    if (!Number.isInteger(id)) continue
    const startAddress = typeof record.startAddress === 'number' ? record.startAddress : undefined
    threads.push({
      id,
      ...(startAddress !== undefined ? { startAddress } : {})
    })
  }
  return threads
}

async function readWindowsSnapshot(): Promise<RuntimeSnapshot | null> {
  const result = await runPowerShellStrict(buildWindowsProbeScript(process.pid), 8_000)
  if (!result.ok) return null
  let parsed: WindowsProbeResult
  try {
    parsed = JSON.parse(result.stdout) as WindowsProbeResult
  } catch {
    return null
  }
  return {
    platform: 'win32',
    executablePath: typeof parsed.executablePath === 'string' ? parsed.executablePath : process.execPath,
    commandLine: typeof parsed.commandLine === 'string' ? parsed.commandLine : process.argv.join(' '),
    resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
    defaultApp: process.defaultApp === true,
    packaged: process.defaultApp !== true,
    modules: parseWindowsModules(parsed.modules),
    threads: parseWindowsThreads(parsed.threads)
  }
}

function parseLinuxMaps(maps: string): RuntimeModule[] {
  const byPath = new Map<string, { base: number; end: number }>()
  for (const line of maps.split('\n')) {
    const match = /^([0-9a-f]+)-([0-9a-f]+)\s+\S+\s+\S+\s+\S+\s+(.*)$/i.exec(line)
    if (!match) continue
    const start = Number.parseInt(match[1] ?? '', 16)
    const end = Number.parseInt(match[2] ?? '', 16)
    const file = (match[3] ?? '').trim()
    if (!file.startsWith('/')) continue
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const existing = byPath.get(file)
    if (existing) {
      existing.base = Math.min(existing.base, start)
      existing.end = Math.max(existing.end, end)
    } else {
      byPath.set(file, { base: start, end })
    }
  }
  return [...byPath.entries()].map(([modulePath, range]) => ({
    path: modulePath,
    baseAddress: range.base,
    size: range.end - range.base
  }))
}

async function readLinuxSnapshot(): Promise<RuntimeSnapshot | null> {
  try {
    const [exeLink, cmdlineRaw, maps] = await Promise.all([
      fs.promises.readlink('/proc/self/exe'),
      fs.promises.readFile('/proc/self/cmdline', 'utf8'),
      fs.promises.readFile('/proc/self/maps', 'utf8')
    ])
    const commandLine = cmdlineRaw.split('\0').filter((part) => part !== '').join(' ')
    return {
      platform: 'linux',
      executablePath: exeLink,
      commandLine,
      resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
      defaultApp: process.defaultApp === true,
      packaged: process.defaultApp !== true,
      modules: parseLinuxMaps(maps),
      threads: []
    }
  } catch {
    return null
  }
}

function parseMacVmmap(output: string): RuntimeModule[] {
  const modules = new Map<string, RuntimeModule>()
  for (const line of output.split('\n')) {
    // path อยู่ท้ายบรรทัด หลังช่องว่าง — ระวัง "r-x/r-x" ที่มี slash อยู่กลาง
    const match = /\s(\/[^\s].*)$/.exec(line)
    if (!match) continue
    const candidate = (match[1] ?? '').trim()
    if (!candidate.startsWith('/')) continue
    if (!/\.(dylib|so|node)(\s|$)/i.test(candidate) && !/\.framework(\/|$)/i.test(candidate)) continue
    modules.set(candidate, { path: candidate })
  }
  return [...modules.values()]
}

async function readMacSnapshot(): Promise<RuntimeSnapshot | null> {
  const [psOutput, vmmapOutput] = await Promise.all([
    runCommand(resolveTrustedExecutable('ps'), ['-p', String(process.pid), '-o', 'command='], 4_000),
    runCommand('/usr/bin/vmmap', ['-w', String(process.pid)], 8_000)
  ])
  if (psOutput === '' && vmmapOutput === '') return null
  return {
    platform: 'darwin',
    executablePath: process.execPath,
    commandLine: psOutput.trim() || process.argv.join(' '),
    resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
    defaultApp: process.defaultApp === true,
    packaged: process.defaultApp !== true,
    modules: parseMacVmmap(vmmapOutput),
    threads: []
  }
}

export async function collectRuntimeSnapshot(
  platform: NodeJS.Platform = process.platform
): Promise<RuntimeSnapshot | null> {
  if (platform === 'win32') return readWindowsSnapshot()
  if (platform === 'linux') return readLinuxSnapshot()
  if (platform === 'darwin') return readMacSnapshot()
  return null
}

/* ============================================================
 * Guard
 * ============================================================ */

export interface RuntimeIntegrityGuardOptions {
  emit: (event: DetectionEvent) => void
  getExpectation: () => RuntimeExpectation
  readSnapshot?: () => Promise<RuntimeSnapshot | null>
  platform?: NodeJS.Platform
  /** ระยะห่างขั้นต่ำระหว่าง probe จริง (PowerShell/vmmap มีต้นทุน) */
  minScanIntervalMs?: number
  now?: () => number
}

export class RuntimeIntegrityGuard {
  readonly detectorId = 'runtime-integrity-guard'
  private readonly platform: NodeJS.Platform
  private readonly readSnapshot: () => Promise<RuntimeSnapshot | null>
  private readonly now: () => number
  private readonly minScanIntervalMs: number
  private readonly reported = new Map<string, number>()
  private readonly probeFailures = new Map<string, number>()
  private lastTickAtMs = 0
  private lastRealScanAtMs = 0

  constructor(private readonly opts: RuntimeIntegrityGuardOptions) {
    this.platform = opts.platform ?? process.platform
    this.readSnapshot = opts.readSnapshot ?? (() => collectRuntimeSnapshot(this.platform))
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
    let snapshot: RuntimeSnapshot | null
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
    this.probeFailures.delete('runtime-snapshot')
    const expectation = this.opts.getExpectation()
    const findings = analyzeRuntimeSnapshot(snapshot, expectation)
    const events: DetectionEvent[] = []
    for (const finding of findings) {
      const signature = `${finding.code}:${finding.reason}:${finding.detail.modulePath ?? finding.detail.threadId ?? ''}`
      if (!this.shouldReport(signature, 60_000)) continue
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
    const count = (this.probeFailures.get('runtime-snapshot') ?? 0) + 1
    this.probeFailures.set('runtime-snapshot', count)
    if (count === 2 || (count > 2 && count % 10 === 0)) {
      this.opts.emit(
        makeDetectionEvent(
          'GUARD_PROBE_FAILED',
          this.detectorId,
          { probe: 'runtime-snapshot', consecutiveFailures: String(count), reason: reason.slice(0, 300) },
          undefined,
          this.now
        )
      )
    }
  }
}

/** ใช้ใน test/integration: อ่าน command line จาก /proc แบบ pure */
export function parseLinuxCommandLine(raw: string): string {
  return raw.split('\0').filter((part) => part !== '').join(' ')
}

/** ใช้ใน test: แปลงผล vmmap เป็น paths */
export function parseMacVmmapPaths(output: string): string[] {
  return parseMacVmmap(output).map((module) => module.path)
}

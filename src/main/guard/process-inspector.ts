import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import type { DetectionPolicyBody, DetectionEvent, DetectionEventCode, ProcessSignatureRule, ProcessAllowlistEntry } from '@shared/policy-schema'
import { DetectionEventCatalog } from '@shared/policy-schema'
import { createPlatformMetadataReader, BinaryMetadataCache, readPeVersionInfoBatch, hashFileSha256, statFile, type BinaryMetadata } from './binary-metadata'
import { parseJsonLines } from './system-probes'

/* ============================================================
 * ProcessInspector — ตรวจโปรเซสเชิงลึก (Phase 3a.2)
 * 1) Blacklist ตามนโยบาย (ชื่อ exe / cmdline / พอร์ต / metadata)
 * 2) Renamed binary: OriginalFilename ตรง rule แต่ชื่อไฟล์ไม่ตรง
 *    → DISGUISED_PROCESS_DETECTED (คะแนน x2)
 * 3) Ephemeral process: trace การสร้างโปรเซสแบบ real-time
 * 4) Local AI ports + compute spike
 * ============================================================ */

export interface ProcessSnapshot {
  pid: number
  /** ชื่อไฟล์ executable lowercase เช่น 'ollama.exe' */
  exeName: string
  exePath: string
  commandLine: string
  memBytes: number
  cpuPercent: number
}

export interface ListeningPort {
  port: number
  pid: number
  processName: string
}

export interface EphemeralProcess {
  pid: number
  /** ชื่อโปรเซส lowercase เช่น 'curl.exe' */
  name: string
  ppid: number
}

export interface RuleMatch {
  rule: ProcessSignatureRule
  /** true = ตรวจจับผ่าน metadata ทั้งที่ชื่อไฟล์ไม่ตรง (เจตนาเปลี่ยนชื่อหนี) */
  disguised: boolean
}

export function normalizeExeName(name: string): string {
  return name.toLowerCase().trim()
}

const USER_WRITABLE_MARKERS = [
  '\\appdata\\',
  '\\temp\\',
  '\\downloads\\',
  '\\desktop\\',
  '\\users\\public\\'
]

/** ไฟล์ที่ผู้ใช้ทั่วไปเขียนทับได้ (ใช้เป็นสัญญาณประกอบการตรวจโปรเซสใหม่) */
export function isUserWritablePath(filePath: string): boolean {
  if (!filePath) return false
  const lower = filePath.toLowerCase()
  return USER_WRITABLE_MARKERS.some((marker) => lower.includes(marker))
}

function normalizePathForMatch(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase()
}

/**
 * โปรเซสนี้อยู่ใน allowlist ที่ครูอนุมัติหรือไม่ (pure)
 * - exeNames: เทียบชื่อไฟล์ (ตัวพิมพ์ไม่สำคัญ)
 * - pathPrefixes: path ขึ้นต้นด้วย prefix (รองรับทั้ง / และ \)
 * - sha256Hashes: hash ที่อนุมัติ
 */
export function isAllowlistedProcess(
  snapshot: Pick<ProcessSnapshot, 'exeName' | 'exePath'>,
  metadata: BinaryMetadata | null,
  allowlist: readonly ProcessAllowlistEntry[] | undefined
): boolean {
  if (!allowlist || allowlist.length === 0) return false
  const exe = normalizeExeName(snapshot.exeName)
  const path = normalizePathForMatch(snapshot.exePath)
  const hash = (metadata?.sha256 ?? '').toLowerCase()
  for (const entry of allowlist) {
    if (entry.exeNames?.some((name) => name.toLowerCase() === exe)) return true
    if (
      path !== '' &&
      entry.pathPrefixes?.some((prefix) => {
        const p = normalizePathForMatch(prefix).replace(/\/+$/, '')
        return p !== '' && (path === p || path.startsWith(`${p}/`))
      })
    ) {
      return true
    }
    if (hash !== '' && entry.sha256Hashes?.some((h) => h.toLowerCase() === hash)) return true
  }
  return false
}

function textMatches(haystack: string | undefined, needles: string[] | undefined): boolean {  if (!haystack || !needles || needles.length === 0) return false
  const lower = haystack.toLowerCase()
  return needles.some((n) => lower.includes(n.toLowerCase()))
}

function exactMatches(haystack: string | undefined, needles: string[] | undefined): boolean {
  if (!haystack || !needles || needles.length === 0) return false
  const lower = haystack.toLowerCase()
  return needles.some((n) => lower === n.toLowerCase())
}

/**
 * ตรวจว่า rule ตรงกับโปรเซสหรือไม่ (pure — ทดสอบได้ไม่พึ่ง OS)
 * disguised = ตรวจได้จาก metadata/hash แต่ชื่อไฟล์ปัจจุบันไม่ตรง exeNames ของ rule
 */
export function matchProcessRules(
  snapshot: Pick<ProcessSnapshot, 'exeName' | 'commandLine'>,
  metadata: BinaryMetadata | null,
  rules: ProcessSignatureRule[],
  extra?: { listeningPorts?: number[]; windowTitle?: string }
): RuleMatch[] {
  const matches: RuleMatch[] = []
  for (const rule of rules) {
    const m = rule.matchers
    const exeMatch = exactMatches(snapshot.exeName, m.exeNames)
    const cmdMatch = textMatches(snapshot.commandLine, m.cmdSubstrings)
    const windowMatch = extra?.windowTitle ? textMatches(extra.windowTitle, m.windowTitles) : false
    const portMatch =
      extra?.listeningPorts?.length && m.localPorts?.length
        ? extra.listeningPorts.some((p) => m.localPorts!.includes(p))
        : false
    const originalMatch = exactMatches(metadata?.originalFilename, m.originalFilenames)
    const productMatch =
      exactMatches(metadata?.productName, m.productNames) ||
      exactMatches(metadata?.bundleId, m.bundleIds)
    const hashMatch =
      metadata?.sha256 && m.sha256Hashes?.length
        ? m.sha256Hashes.includes(metadata.sha256.toLowerCase())
        : false

    const matched = exeMatch || cmdMatch || windowMatch || portMatch || originalMatch || productMatch || hashMatch
    if (!matched) continue
    // เจตนาหลบ: ตัวตนถูกจับจากหลักฐานที่เปลี่ยนชื่อไฟล์ไม่ได้ แต่ชื่อไฟล์กลับไม่ตรง
    const disguised = !exeMatch && (originalMatch || productMatch || hashMatch)
    matches.push({ rule, disguised })
  }
  return matches
}

export function makeDetectionEvent(
  code: DetectionEventCode,
  detectorId: string,
  detail: Record<string, string>,
  scoreOverride?: number,
  now = Date.now
): DetectionEvent {
  const entry = DetectionEventCatalog[code]
  return {
    eventId: `${code}-${now()}-${Math.random().toString(36).slice(2, 8)}`,
    code,
    severity: entry.severity,
    score: scoreOverride ?? entry.score,
    detectorId,
    detail,
    occurredAtMs: now()
  }
}

/* ---------- OS adapters (default probes) ---------- */

interface SiProcessEntry {
  pid: number
  name?: string
  command?: string
  mem?: number
  cpu?: number
  path?: string
}

async function listProcessesWithSi(): Promise<ProcessSnapshot[]> {
  const si = (await import('systeminformation')).default
  const data = await si.processes()
  return (data.list ?? [])
    .filter((p: SiProcessEntry) => typeof p.pid === 'number' && p.pid > 0)
    .map((p: SiProcessEntry) => ({
      pid: p.pid,
      exeName: (p.name ?? '').toLowerCase(),
      exePath: p.path ?? '',
      commandLine: p.command ?? '',
      memBytes: p.mem ?? 0,
      cpuPercent: p.cpu ?? 0
    }))
}

interface SiConnectionEntry {
  localPort?: number | string
  state?: string
  pid?: number | string
  process?: string
}

async function listListeningPortsWithSi(): Promise<ListeningPort[]> {
  const si = (await import('systeminformation')).default
  const connections = await si.networkConnections()
  const ports: ListeningPort[] = []
  for (const c of connections as SiConnectionEntry[]) {
    const state = (c.state ?? '').toUpperCase()
    if (!state.startsWith('LISTEN')) continue
    const port = Number(c.localPort)
    if (!Number.isInteger(port) || port <= 0) continue
    ports.push({
      port,
      pid: Number(c.pid) || 0,
      processName: (c.process ?? '').toLowerCase()
    })
  }
  return ports
}

/**
 * Windows: subscribe Win32_ProcessStartTrace ผ่าน PowerShell —
 * โปรเซสที่เปิดแล้วปิดในเสี้ยววินาทีก็เข้าคิวทันที (ETW-based)
 */
function startWindowsProcessTrace(
  onProcess: (p: EphemeralProcess) => void
): (() => void) | null {
  if (process.platform !== 'win32') return null
  const script = [
    `$null = Register-CimIndicationEvent -Query "SELECT * FROM Win32_ProcessStartTrace"`,
    `while ($true) {`,
    `  $evt = Wait-Event`,
    `  $n = $evt.SourceEventArgs.NewEvent`,
    `  @{ pid = $n.ProcessID; name = $n.ProcessName; ppid = $n.ParentProcessID } | ConvertTo-Json -Compress`,
    `  Remove-Event -EventIdentifier $evt.EventIdentifier`,
    `}`
  ].join('\n')
  let stopped = false
  let child: ChildProcess | null = null
  let restartTimer: NodeJS.Timeout | null = null

  const scheduleRestart = (): void => {
    if (stopped || restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      launch()
    }, 2_000)
  }

  const launch = (): void => {
    if (stopped) return
    let proc: ChildProcess
    try {
      proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      )
    } catch {
      child = null
      scheduleRestart()
      return
    }
    child = proc
    let buffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const p of parseJsonLines<EphemeralProcess>(lines.join('\n'))) {
        if (typeof p.pid === 'number' && typeof p.name === 'string') {
          onProcess({ pid: p.pid, name: p.name.toLowerCase(), ppid: p.ppid ?? 0 })
        }
      }
    })
    const handleGone = (): void => {
      if (child === proc) child = null
      scheduleRestart()
    }
    proc.once('exit', handleGone)
    proc.once('error', handleGone)
  }

  launch()
  return () => {
    stopped = true
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = null
    try {
      child?.kill()
    } catch {
      // ปล่อยผ่าน
    }
    child = null
  }
}

/* ============================================================
 * Inspector
 * ============================================================ */

export interface ProcessInspectorOptions {
  detectorId?: string
  getPolicy: () => DetectionPolicyBody | null
  emit: (event: DetectionEvent) => void
  /** Phase 9.5: pid ลูกที่ code-ide sandbox สั่งรันเอง — ข้ามการฟ้องทั้งหมด (รู้ pid แน่ชัดจึงปลอดภัย) */
  isAuthorizedPid?: (pid: number) => boolean
  listProcesses?: () => Promise<ProcessSnapshot[]>
  listListeningPorts?: () => Promise<ListeningPort[]>
  startProcessTrace?: (onProcess: (p: EphemeralProcess) => void) => (() => void) | null
  /** อุณหภูมิ RAM/CPU ขั้นต่ำก่อนฟ้อง compute spike */
  spikeMemBytes?: number
  spikeCpuPercent?: number
  now?: () => number
}

export class ProcessInspector {
  readonly detectorId: string
  private readonly metadataCache: BinaryMetadataCache
  private readonly listProcesses: () => Promise<ProcessSnapshot[]>
  private readonly listListeningPorts: () => Promise<ListeningPort[]>
  private readonly startProcessTrace: (onProcess: (p: EphemeralProcess) => void) => (() => void) | null
  private readonly spikeMemBytes: number
  private readonly spikeCpuPercent: number
  private readonly now: () => number
  private stopTrace: (() => void) | null = null
  /** hash ที่แจ้งไปแล้ว กันยิง event เดิมซ้ำรัว ๆ */
  private readonly reportedSignatures = new Map<string, number>()
  private baselineProcesses: Set<string> | null = null
  private traceEnabled = false
  private lastScanAtMs = 0

  constructor(private readonly opts: ProcessInspectorOptions) {
    this.detectorId = opts.detectorId ?? 'process-inspector'
    this.metadataCache = new BinaryMetadataCache(createPlatformMetadataReader())
    this.listProcesses = opts.listProcesses ?? listProcessesWithSi
    this.listListeningPorts = opts.listListeningPorts ?? listListeningPortsWithSi
    this.startProcessTrace = opts.startProcessTrace ?? startWindowsProcessTrace
    this.spikeMemBytes = opts.spikeMemBytes ?? 1.5 * 1024 * 1024 * 1024
    this.spikeCpuPercent = opts.spikeCpuPercent ?? 70
    this.now = opts.now ?? Date.now
  }

  getLastTickAtMs(): number {
    return this.lastScanAtMs
  }

  start(): void {
    this.baselineProcesses = null
    if (this.traceEnabled) return
    this.traceEnabled = true
    const stop = this.startProcessTrace((p) => this.handleEphemeralProcess(p))
    this.stopTrace = stop
  }

  stop(): void {
    this.traceEnabled = false
    this.stopTrace?.()
    this.stopTrace = null
  }

  /**
   * เริ่ม baseline ใหม่ (เรียกตอนเริ่มสอบจริง) — โปรเซสที่รันอยู่ก่อนเริ่มสอบ
   * จะไม่ถูกนับเป็น "โปรเซสใหม่", ตัวที่เพิ่งโผล่หลังเริ่มสอบจะถูกจับ
   */
  resetBaseline(): void {
    this.baselineProcesses = null
  }

  /** รายงาน metadata ที่อ่านแล้วสำหรับ hash matching (ใช้ใน test) */
  async primeMetadata(entries: Array<{ snapshot: ProcessSnapshot; metadata: BinaryMetadata | null }>): Promise<void> {
    for (const { snapshot, metadata } of entries) {
      if (!metadata) continue
      this.metadataCache.prime(snapshot.exePath, metadata)
    }
  }

  /** สแกนเต็มระบบหนึ่งรอบ (เรียกโดย JitteredScheduler) */
  async scanOnce(): Promise<DetectionEvent[]> {
    this.lastScanAtMs = this.now()
    const policy = this.opts.getPolicy()
    if (!policy) return []
    const events: DetectionEvent[] = []
    const portByPid = new Map<number, number[]>()
    try {
      for (const lp of await this.listListeningPorts()) {
        const list = portByPid.get(lp.pid) ?? []
        list.push(lp.port)
        portByPid.set(lp.pid, list)
      }
    } catch {
      // สแกนพอร์ตไม่ได้ (สิทธิ์จำกัด) — ยังตรวจชื่อโปรเซสได้
    }

    let processes: ProcessSnapshot[]
    try {
      processes = await this.listProcesses()
    } catch {
      return []
    }

    const captureBaseline = this.baselineProcesses === null
    if (captureBaseline) {
      this.baselineProcesses = new Set(processes.map((p) => p.exeName))
    }

    // Windows: อ่าน PE VersionInfo ของ path ที่ยังไม่เคยแคชทีเดียว (batch)
    const uncached = processes
      .filter((p) => p.exePath && !this.metadataCache.hasCached(p.exePath))
      .map((p) => p.exePath)
    if (uncached.length > 0 && process.platform === 'win32') {
      const batch = await readPeVersionInfoBatch([...new Set(uncached)].slice(0, 128))
      for (const [key, metadata] of batch) this.metadataCache.prime(key, metadata)
    }

    for (const snapshot of processes) {
      // ไม่ตรวจโปรเซสของตัวเอง
      if (snapshot.pid === process.pid) continue
      // โปรเซสลูกของ sandbox: ข้ามการเทียบรายชื่อ
      const authorized = this.opts.isAuthorizedPid?.(snapshot.pid) === true
      const metadata =
        !authorized && snapshot.exePath && process.platform === 'win32'
          ? await this.metadataCache.get(snapshot.exePath, statFile(snapshot.exePath))
          : null
      // allowlist ที่ครูอนุมัติ: ตรวจ hash ก่อนถ้ามีรายการ hash
      if (
        !authorized &&
        metadata &&
        !metadata.sha256 &&
        snapshot.exePath &&
        policy.processAllowlist.some((entry) => (entry.sha256Hashes?.length ?? 0) > 0)
      ) {
        const sha = await this.verifyFileHash(snapshot.exePath)
        if (sha) metadata.sha256 = sha
      }
      const allowlisted =
        !authorized && isAllowlistedProcess(snapshot, metadata, policy.processAllowlist)
      const ports = portByPid.get(snapshot.pid)
      const matches = authorized || allowlisted
        ? []
        : matchProcessRules(
            snapshot,
            metadata,
            policy.rules,
            ports?.length ? { listeningPorts: ports } : undefined
          )
      for (const { rule, disguised } of matches) {
        const signature = `${rule.ruleId}:${snapshot.exeName}:${disguised ? 'd' : 'n'}`
        if (this.shouldReport(signature, disguised ? 30_000 : 15_000)) {
          events.push(
            makeDetectionEvent(
              disguised ? 'DISGUISED_PROCESS_DETECTED' : 'BLACKLISTED_PROCESS_DETECTED',
              this.detectorId,
              {
                pid: String(snapshot.pid),
                processName: snapshot.exeName,
                ruleId: rule.ruleId,
                category: rule.category,
                originalFilename: metadata?.originalFilename ?? '',
                productName: metadata?.productName ?? '',
                signature: metadata?.signatureStatus ?? 'unknown',
                listeningPorts: ports?.join(',') ?? ''
              },
              disguised ? rule.scoreWeight * 2 : rule.scoreWeight,
              this.now
            )
          )
        }
      }
      // Local AI spike (Mode closed เท่านั้น)
      if (
        !allowlisted &&
        policy.examMode === 'closed' &&
        snapshot.memBytes > this.spikeMemBytes &&
        snapshot.cpuPercent > this.spikeCpuPercent
      ) {
        const signature = `spike:${snapshot.exeName}`
        if (this.shouldReport(signature, 20_000)) {
          events.push(
            makeDetectionEvent(
              'SUSPICIOUS_COMPUTE_SPIKE',
              this.detectorId,
              {
                processName: snapshot.exeName,
                memMb: String(Math.round(snapshot.memBytes / (1024 * 1024))),
                cpuPercent: String(Math.round(snapshot.cpuPercent))
              },
              undefined,
              this.now
            )
          )
        }
      }
      if (
        !authorized &&
        !allowlisted &&
        !captureBaseline &&
        this.baselineProcesses &&
        !this.baselineProcesses.has(snapshot.exeName) &&
        isUserWritablePath(snapshot.exePath)
      ) {
        const signature = `unlisted:${snapshot.exePath.toLowerCase()}`
        if (this.shouldReport(signature, 60_000)) {
          events.push(
            makeDetectionEvent(
              'UNLISTED_PROCESS_DETECTED',
              this.detectorId,
              {
                pid: String(snapshot.pid),
                processName: snapshot.exeName,
                path: snapshot.exePath.slice(0, 300),
                signature: metadata?.signatureStatus ?? 'unknown'
              },
              metadata?.signatureStatus === 'valid' ? 10 : undefined,
              this.now
            )
          )
          this.baselineProcesses.add(snapshot.exeName)
        }
      }
    }
    for (const event of events) this.opts.emit(event)
    return events
  }

  private handleEphemeralProcess(p: EphemeralProcess): void {
    const policy = this.opts.getPolicy()
    if (!policy) return
    if (p.pid === process.pid) return
    if (this.opts.isAuthorizedPid?.(p.pid) === true) return
    if (isAllowlistedProcess({ exeName: p.name, exePath: '' }, null, policy.processAllowlist)) {
      return
    }
    const matches = matchProcessRules({ exeName: p.name, commandLine: p.name }, null, policy.rules)
    for (const { rule } of matches) {
      this.opts.emit(
        makeDetectionEvent(
          'BLACKLISTED_PROCESS_DETECTED',
          this.detectorId,
          {
            pid: String(p.pid),
            processName: p.name,
            ppid: String(p.ppid),
            ruleId: rule.ruleId,
            category: rule.category,
            ephemeral: 'true'
          },
          rule.scoreWeight,
          this.now
        )
      )
    }
  }

  private shouldReport(signature: string, cooldownMs: number): boolean {
    const last = this.reportedSignatures.get(signature) ?? 0
    if (this.now() - last < cooldownMs) return false
    this.reportedSignatures.set(signature, this.now())
    return true
  }

  /** ตรวจ hash ของไฟล์หนึ่ง (ใช้ใน test กับ policy ที่มี sha256Hashes) */
  async verifyFileHash(filePath: string): Promise<string | null> {
    return hashFileSha256(filePath)
  }

  /** linux: ตรวจ /proc รอบสั้นเพื่อหา PID burst จาก shell */
  static async listUnixProcesses(): Promise<ProcessSnapshot[]> {
    if (process.platform === 'linux') {
      const result: ProcessSnapshot[] = []
      let entries: string[]
      try {
        entries = await fs.promises.readdir('/proc')
      } catch {
        return []
      }
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue
        try {
          const comm = (await fs.promises.readFile(`/proc/${entry}/comm`, 'utf8')).trim()
          const cmdline = (await fs.promises.readFile(`/proc/${entry}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim()
          result.push({
            pid: Number(entry),
            exeName: comm.toLowerCase(),
            exePath: '',
            commandLine: cmdline || comm,
            memBytes: 0,
            cpuPercent: 0
          })
        } catch {
          // โปรเซสปิดไปแล้ว — ข้าม
        }
      }
      return result
    }
    return listProcessesWithSi()
  }
}

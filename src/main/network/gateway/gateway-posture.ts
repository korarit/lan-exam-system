import fs from 'node:fs'
import { powershellExecutable, resolveTrustedExecutable } from '../../guard/trusted-binary'
import { runCommandStrict } from '../../guard/system-probes'
import type { GatewayPosture } from '@shared/gateway'

/* ============================================================
 * Gateway posture — ตรวจ (และพยายามปิด) IP forwarding / ICS
 * - Windows: Get-NetIPInterface + registry + SharedAccess service
 * - Linux: /proc/sys/net/ipv4|ipv6
 * - macOS: sysctl net.inet.ip.forwarding / net.inet.ip6.forwarding
 *
 * สำคัญ: DHCPv4 gateway ไม่ได้หยุด IPv6 Router Advertisement
 * ถ้า IPv6 forwarding ยังเปิดหรือ VLAN ยังมี RA → นักเรียน bypass ได้
 * ============================================================ */

export interface PostureExecResult {
  ok: boolean
  stdout: string
  stderr?: string
}

export type PostureExec = (
  file: string,
  args: string[],
  timeoutMs?: number
) => Promise<PostureExecResult>

export interface GatewayPostureOptions {
  platform?: NodeJS.Platform
  exec?: PostureExec
  readFile?: (filePath: string) => Promise<string>
  writeFile?: (filePath: string, data: string) => Promise<void>
  timeoutMs?: number
  /** พยายามปิด forwarding (ต้องมีสิทธิ์ Administrator/root) */
  attemptDisable?: boolean
  /** หยุดบริการ SharedAccess ด้วย — ค่าเริ่มต้น false เพราะอาจกระทบการแชร์เน็ตของเจ้าของเครื่อง */
  disableIcs?: boolean
}

const DEFAULT_TIMEOUT_MS = 6_000
const LINUX_IPV4_FORWARD = '/proc/sys/net/ipv4/ip_forward'
const LINUX_IPV6_FORWARD = '/proc/sys/net/ipv6/conf/all/forwarding'

function defaultExec(
  file: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<PostureExecResult> {
  return runCommandStrict(file, args, timeoutMs)
}

async function defaultReadFile(filePath: string): Promise<string> {
  return fs.promises.readFile(filePath, 'utf8')
}

async function defaultWriteFile(filePath: string, data: string): Promise<void> {
  await fs.promises.writeFile(filePath, data, 'utf8')
}

/* ---------- pure parsers (ทดสอบได้โดยไม่รันคำสั่งจริง) ---------- */

export function parseForwardingTokens(tokens: string | null | undefined): boolean | null {
  if (tokens === null || tokens === undefined) return null
  const values = tokens
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
  if (values.length === 0) return null
  if (values.some((value) => value === 'enabled' || value === 'true' || value === '1')) return true
  if (values.some((value) => value === 'disabled' || value === 'false' || value === '0')) return false
  return null
}

export function parseForwardingFlag(raw: string | null | undefined): boolean | null {
  if (raw === null || raw === undefined) return null
  const value = raw.trim()
  if (value === '1') return true
  if (value === '0') return false
  return null
}

export function parseSysctlForwarding(output: string): boolean | null {
  const match = output.match(/:\s*([01])\s*$/m)
  if (match) return match[1] === '1'
  return parseForwardingFlag(output)
}

export interface WindowsPostureParse {
  ipv4Forwarding: boolean | null
  ipv6Forwarding: boolean | null
  icsEnabled: boolean | null
}

function combineForwarding(a: boolean | null, b: boolean | null): boolean | null {
  if (a === true || b === true) return true
  if (a === false || b === false) return false
  return null
}

/** parse ผล JSON จาก PowerShell (Get-NetIPInterface + registry + SharedAccess) */
export function parseWindowsPostureOutput(output: string): WindowsPostureParse {
  const trimmed = output.trim().replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('{')) {
    return { ipv4Forwarding: null, ipv6Forwarding: null, icsEnabled: null }
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return { ipv4Forwarding: null, ipv6Forwarding: null, icsEnabled: null }
  }
  const ipv4Interface = parseForwardingTokens(
    typeof raw['v4'] === 'string' ? (raw['v4'] as string) : null
  )
  const ipv6Interface = parseForwardingTokens(
    typeof raw['v6'] === 'string' ? (raw['v6'] as string) : null
  )
  const routerRaw = typeof raw['router'] === 'string' ? (raw['router'] as string).trim() : ''
  const routerFlag =
    routerRaw === '1' ? true : routerRaw === '0' ? false : parseForwardingFlag(routerRaw)
  const icsRaw = typeof raw['ics'] === 'string' ? (raw['ics'] as string).trim().toLowerCase() : ''
  const icsEnabled =
    icsRaw.length === 0
      ? null
      : icsRaw === 'running' || icsRaw === 'startpending'
        ? true
        : icsRaw === 'stopped' || icsRaw === 'stoppending'
          ? false
          : null
  return {
    ipv4Forwarding: combineForwarding(ipv4Interface, routerFlag),
    ipv6Forwarding: ipv6Interface,
    icsEnabled
  }
}

export interface WindowsDisableParse {
  changes: string[]
  errors: string[]
}

export function parseWindowsDisableOutput(output: string): WindowsDisableParse {
  const trimmed = output.trim().replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('{')) return { changes: [], errors: [] }
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>
    const changes = Array.isArray(raw['changes'])
      ? (raw['changes'] as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 16)
      : []
    const errors = Array.isArray(raw['errors'])
      ? (raw['errors'] as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 16)
      : []
    return { changes, errors }
  } catch {
    return { changes: [], errors: [] }
  }
}

/* ---------- Windows scripts ---------- */

function windowsReadScript(): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$v4 = @(Get-NetIPInterface -AddressFamily IPv4 | Select-Object -ExpandProperty Forwarding)',
    '$v6 = @(Get-NetIPInterface -AddressFamily IPv6 | Select-Object -ExpandProperty Forwarding)',
    '$ics = Get-Service -Name SharedAccess -ErrorAction SilentlyContinue',
    '$router = $null',
    "try { $router = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters' -Name IPEnableRouter -ErrorAction SilentlyContinue).IPEnableRouter } catch {}",
    '[pscustomobject]@{ v4 = ($v4 -join ","); v6 = ($v6 -join ","); ics = $(if ($null -ne $ics) { [string]$ics.Status } else { "" }); router = $(if ($null -ne $router) { [string]$router } else { "" }) } | ConvertTo-Json -Compress'
  ].join('; ')
}

function windowsDisableScript(disableIcs: boolean): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$changes = @()',
    '$errors = @()',
    'try { Set-NetIPInterface -AddressFamily IPv4 -Forwarding Disabled -ErrorAction Stop; $changes += "Set-NetIPInterface IPv4 Forwarding=Disabled" } catch { $errors += ("IPv4 forwarding: " + $_.Exception.Message) }',
    'try { Set-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters" -Name IPEnableRouter -Value 0 -ErrorAction Stop; $changes += "registry IPEnableRouter=0" } catch { $errors += ("registry IPEnableRouter: " + $_.Exception.Message) }',
    'try { Set-NetIPInterface -AddressFamily IPv6 -Forwarding Disabled -ErrorAction Stop; $changes += "Set-NetIPInterface IPv6 Forwarding=Disabled" } catch { $errors += ("IPv6 forwarding: " + $_.Exception.Message) }',
    disableIcs
      ? 'try { Stop-Service -Name SharedAccess -Force -ErrorAction Stop; $changes += "Stop-Service SharedAccess" } catch { $errors += ("SharedAccess: " + $_.Exception.Message) }'
      : '',
    '[pscustomobject]@{ changes = $changes; errors = $errors } | ConvertTo-Json -Compress'
  ]
    .filter((part) => part.length > 0)
    .join('; ')
}

function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
}

/* ---------- posture assembly ---------- */

function finalizePosture(
  values: Pick<GatewayPosture, 'ipv4Forwarding' | 'ipv6Forwarding' | 'icsEnabled'>,
  changed: string[],
  extraWarnings: string[]
): GatewayPosture {
  const warnings: string[] = [...extraWarnings]
  const { ipv4Forwarding, ipv6Forwarding, icsEnabled } = values
  if (ipv4Forwarding === true) {
    warnings.push(
      'IPv4 forwarding ยังเปิดอยู่ — เครื่องแม่อาจ forward ทราฟฟิกออกอินเทอร์เน็ต ต้องปิดด้วย Administrator/root'
    )
  }
  if (ipv4Forwarding === null) {
    warnings.push('อ่านสถานะ IPv4 forwarding ไม่ได้ — ตรวจสอบด้วยคำสั่งของ OS ก่อนเริ่มสอบ')
  }
  if (ipv6Forwarding === true) {
    warnings.push(
      'IPv6 forwarding ยังเปิดอยู่ — DHCPv4 gateway ไม่หยุด IPv6/RA นักเรียนอาจ bypass ได้ ต้องปิด IPv6 ใน VLAN นักเรียน'
    )
  }
  if (ipv6Forwarding === null) {
    warnings.push('อ่านสถานะ IPv6 forwarding ไม่ได้ — ต้องปิด IPv6 ใน VLAN นักเรียนเพื่อกันการ bypass')
  }
  if (icsEnabled === true) {
    warnings.push(
      'Internet Connection Sharing (SharedAccess) เปิดอยู่ — ICS อาจ NAT ทราฟฟิกนักเรียนออกเน็ต ต้องปิด ICS'
    )
  }
  return {
    ipv4Forwarding,
    ipv6Forwarding,
    icsEnabled,
    canDisable: ipv4Forwarding !== true && ipv6Forwarding !== true && icsEnabled !== true,
    changed,
    warnings: [...new Set(warnings)].slice(0, 32)
  }
}

async function safeRead(
  readFile: (filePath: string) => Promise<string>,
  filePath: string
): Promise<string | null> {
  try {
    return await readFile(filePath)
  } catch {
    return null
  }
}

/** อ่าน posture ปัจจุบันเท่านั้น (ไม่แก้ระบบ) */
export async function readGatewayPosture(
  options: GatewayPostureOptions = {}
): Promise<GatewayPosture> {
  const platform = options.platform ?? process.platform
  const exec = options.exec ?? defaultExec
  const readFile = options.readFile ?? defaultReadFile
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (platform === 'win32') {
    const result = await exec(
      powershellExecutable('win32'),
      powershellArgs(windowsReadScript()),
      timeoutMs
    )
    const parsed = parseWindowsPostureOutput(result.stdout)
    return finalizePosture(
      parsed,
      [],
      result.ok ? [] : ['เรียก PowerShell เพื่ออ่าน forwarding ไม่สำเร็จ']
    )
  }

  if (platform === 'darwin') {
    const sysctl = resolveTrustedExecutable('sysctl', 'darwin')
    const v4 = await exec(sysctl, ['-n', 'net.inet.ip.forwarding'], timeoutMs)
    const v6 = await exec(sysctl, ['-n', 'net.inet.ip6.forwarding'], timeoutMs)
    const warnings: string[] = []
    if (!v4.ok) warnings.push('อ่าน sysctl net.inet.ip.forwarding ไม่สำเร็จ')
    if (!v6.ok) warnings.push('อ่าน sysctl net.inet.ip6.forwarding ไม่สำเร็จ')
    return finalizePosture(
      {
        ipv4Forwarding: v4.ok ? parseForwardingFlag(v4.stdout) : null,
        ipv6Forwarding: v6.ok ? parseForwardingFlag(v6.stdout) : null,
        icsEnabled: null
      },
      [],
      warnings
    )
  }

  // linux / อื่น ๆ: อ่าน procfs
  const v4Raw = await safeRead(readFile, LINUX_IPV4_FORWARD)
  const v6Raw = await safeRead(readFile, LINUX_IPV6_FORWARD)
  const warnings: string[] = []
  if (v4Raw === null) warnings.push(`อ่าน ${LINUX_IPV4_FORWARD} ไม่ได้`)
  if (v6Raw === null) warnings.push(`อ่าน ${LINUX_IPV6_FORWARD} ไม่ได้`)
  return finalizePosture(
    {
      ipv4Forwarding: v4Raw === null ? null : parseForwardingFlag(v4Raw),
      ipv6Forwarding: v6Raw === null ? null : parseForwardingFlag(v6Raw),
      icsEnabled: null
    },
    [],
    warnings
  )
}

async function disableWindows(
  options: GatewayPostureOptions
): Promise<DisableAttempt> {
  const exec = options.exec ?? defaultExec
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const result = await exec(
    powershellExecutable('win32'),
    powershellArgs(windowsDisableScript(options.disableIcs === true)),
    timeoutMs
  )
  const parsed = parseWindowsDisableOutput(result.stdout)
  const warnings = parsed.errors.map((message) => `ปิด forwarding ไม่สำเร็จ: ${message}`)
  if (!result.ok && parsed.errors.length === 0) {
    warnings.push('เรียก PowerShell เพื่อปิด forwarding ไม่สำเร็จ (ต้องมีสิทธิ์ Administrator)')
  }
  return { changed: parsed.changes, warnings }
}

interface DisableAttempt {
  changed: string[]
  warnings: string[]
}

async function disableLinux(
  options: GatewayPostureOptions,
  posture: GatewayPosture
): Promise<DisableAttempt> {
  const writeFile = options.writeFile ?? defaultWriteFile
  const changed: string[] = []
  const warnings: string[] = []
  const targets: Array<{ path: string; enabled: boolean | null }> = [
    { path: LINUX_IPV4_FORWARD, enabled: posture.ipv4Forwarding },
    { path: LINUX_IPV6_FORWARD, enabled: posture.ipv6Forwarding }
  ]
  for (const target of targets) {
    if (target.enabled !== true) continue
    try {
      await writeFile(target.path, '0\n')
      changed.push(`write ${target.path}=0`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error'
      warnings.push(`เขียน ${target.path} ไม่สำเร็จ (ต้องสิทธิ์ root): ${message}`)
    }
  }
  return { changed, warnings }
}

async function disableMac(
  options: GatewayPostureOptions,
  posture: GatewayPosture
): Promise<DisableAttempt> {
  const exec = options.exec ?? defaultExec
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sysctl = resolveTrustedExecutable('sysctl', 'darwin')
  const changed: string[] = []
  const warnings: string[] = []
  const targets: Array<{ key: string; enabled: boolean | null }> = [
    { key: 'net.inet.ip.forwarding', enabled: posture.ipv4Forwarding },
    { key: 'net.inet.ip6.forwarding', enabled: posture.ipv6Forwarding }
  ]
  for (const target of targets) {
    if (target.enabled !== true) continue
    const result = await exec(sysctl, ['-w', `${target.key}=0`], timeoutMs)
    if (result.ok) {
      changed.push(`sysctl ${target.key}=0`)
    } else {
      warnings.push(`sysctl ${target.key}=0 ไม่สำเร็จ (ต้องรันด้วย sudo/root)`)
    }
  }
  return { changed, warnings }
}

/**
 * อ่าน posture แล้วพยายามปิด forwarding
 * - คืน changed[] ว่าแก้อะไรจริง และ warnings[] ว่าอะไรยังต้องทำเอง
 * - ไม่เรียกคำสั่ง privileged ใน test (inject exec/readFile/writeFile)
 */
export async function disableGatewayForwarding(
  options: GatewayPostureOptions = {}
): Promise<GatewayPosture> {
  const platform = options.platform ?? process.platform
  const before = await readGatewayPosture(options)
  if (before.canDisable && before.changed.length === 0) {
    return before
  }

  let attempt: DisableAttempt = { changed: [], warnings: [] }
  if (platform === 'win32') attempt = await disableWindows(options)
  else if (platform === 'darwin') attempt = await disableMac(options, before)
  else attempt = await disableLinux(options, before)

  const after = await readGatewayPosture(options)
  const remainingWarnings = [...attempt.warnings]
  if (after.ipv4Forwarding === true) {
    remainingWarnings.push('IPv4 forwarding ยังเปิดหลังพยายามปิด — ต้องปิดเองด้วย Administrator/root')
  }
  if (after.ipv6Forwarding === true) {
    remainingWarnings.push('IPv6 forwarding ยังเปิดหลังพยายามปิด — ต้องปิดเองหรือปิด IPv6 ใน VLAN นักเรียน')
  }
  if (after.icsEnabled === true) {
    remainingWarnings.push('SharedAccess (ICS) ยังทำงานอยู่ — ต้องปิด ICS เอง')
  }
  return {
    ...after,
    changed: [...new Set([...attempt.changed, ...after.changed])].slice(0, 32),
    warnings: [...new Set([...after.warnings, ...remainingWarnings])].slice(0, 32)
  }
}

/** entry point ที่ gateway-service ใช้: attemptDisable=true → พยายามปิดให้ด้วย */
export async function probeGatewayPosture(
  options: GatewayPostureOptions = {}
): Promise<GatewayPosture> {
  return options.attemptDisable === true
    ? disableGatewayForwarding(options)
    : readGatewayPosture(options)
}

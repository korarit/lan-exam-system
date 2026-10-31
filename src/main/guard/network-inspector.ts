import os from 'node:os'
import type { DetectionEvent, DetectionPolicyBody } from '@shared/policy-schema'
import { runPowerShellStrict } from './system-probes'
import { makeDetectionEvent } from './process-inspector'
import { isDomainAllowed } from '../host/domain-recorder'

/* ============================================================
 * NetworkInspector — จับทางเดินทางออกนอก (Phase 3a.4)
 * 1) OS DNS Resolver Cache diffing: โดเมนต้องห้ามโผล่ระหว่างสอบ
 *    = มีการติดต่อภายนอกแม้ปิดการเชื่อมต่อในเสี้ยววินาที
 * 2) Per-process active sockets เทียบกับโหมดข้อสอบ
 * 3) Virtual NIC / VPN tunnel interface ที่เกิดขึ้นใหม่
 * ============================================================ */

/** ชื่อ interface จำพวก VPN/TUN/TAP/VM ที่มักใช้หลบการตรวจ */
export const TUNNEL_NIC_PATTERNS = [
  'wintun',
  'wireguard',
  'tap-',
  'tun',
  'tailscale',
  'zerotier',
  'warp',
  'clash',
  'v2ray',
  'openvpn',
  'utun',
  'taptun',
  'virtualbox',
  'vmware network adapter',
  'vethernet'
]

export interface SocketInfo {
  pid: number
  processName: string
  protocol: string
  localAddress: string
  localPort: number
  peerAddress: string
  peerPort: number
  state: string
}

export function isLoopback(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '0.0.0.0' ||
    address === '::' ||
    address.startsWith('127.')
  )
}

/**
 * VULN-60: probe ต้องมีเพดานเวลา — ถ้า systeminformation/WMI ค้าง
 * ต้องรายงานว่าล้ม ไม่ใช่ปล่อยให้ detector แขวนเงียบ
 */
export async function withProbeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`PROBE_TIMEOUT:${label}`)), timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** เดาชื่อโดเมนที่ forbidden: ตรงกันเป๊ะหรือเป็น subdomain ลูกของรายการ */
export function matchForbiddenDomain(
  hostname: string,
  forbiddenDomains: string[],
  allowedDomains: string[]
): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  for (const allowed of allowedDomains) {
    if (host === allowed.toLowerCase() || host.endsWith(`.${allowed.toLowerCase()}`)) return null
  }
  for (const forbidden of forbiddenDomains) {
    const f = forbidden.toLowerCase()
    if (host === f || host.endsWith(`.${f}`)) return f
  }
  return null
}

/**
 * DNS cache diff (pure): โดเมนใหม่ที่ไม่อยู่ใน baseline ระหว่างสอบ
 * - อยู่ใน allowedDomains (รวม subdomain ลูก) → ไม่ฟ้อง
 * - ตรง forbiddenDomains → FORBIDDEN_DNS_QUERY_DETECTED
 * - อื่น ๆ ที่ไม่อนุมัติ (default-deny) → UNAUTHORIZED_DOMAIN_DETECTED (Phase 3a-plus)
 */
export function diffDnsCache(
  baseline: Set<string>,
  current: string[],
  policy: Pick<DetectionPolicyBody, 'forbiddenDomains' | 'allowedDomains' | 'domainEnforcement'>
): DetectionEvent[] {
  const events: DetectionEvent[] = []
  for (const entry of current) {
    const host = entry.toLowerCase().trim()
    if (!host || baseline.has(host)) continue
    if (isDomainAllowed(host, policy.allowedDomains)) continue
    const matched = matchForbiddenDomain(host, policy.forbiddenDomains, policy.allowedDomains)
    if (matched) {
      events.push(
        makeDetectionEvent('FORBIDDEN_DNS_QUERY_DETECTED', 'network-inspector', {
          domain: host,
          matchedRule: matched
        })
      )
    } else {
      // DNS layer เป็นการเตือนคู่ขนาน — บล็อกจริงทำได้เฉพาะ webRequest layer ของ WebContentsView
      events.push(
        makeDetectionEvent('UNAUTHORIZED_DOMAIN_DETECTED', 'network-inspector', {
          domain: host,
          enforcement: policy.domainEnforcement
        })
      )
    }
  }
  return events
}

/** Virtual NIC ที่เกิดขึ้นใหม่เทียบ baseline */
export function diffNetworkInterfaces(
  baseline: Set<string>,
  currentNames: string[]
): string[] {
  const suspicious: string[] = []
  for (const name of currentNames) {
    const lower = name.toLowerCase()
    if (baseline.has(lower)) continue
    if (TUNNEL_NIC_PATTERNS.some((pattern) => lower.includes(pattern))) {
      suspicious.push(name)
    }
  }
  return suspicious
}

/** Windows: อ่าน OS DNS Resolver Cache ด้วย Get-DnsClientCache */
export async function readDnsCacheWindows(): Promise<string[]> {
  const result = await runPowerShellStrict(
    'Get-DnsClientCache -ErrorAction SilentlyContinue | Select-Object -Unique -ExpandProperty Entry'
  )
  // แยก "คำสั่งล้ม" (ถูกจำกัด/ไม่มี PowerShell) ออกจาก "cache ว่างจริง"
  if (!result.ok) throw new Error('DNS_CACHE_PROBE_FAILED')
  return result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 3)
}

async function listConnectionsWithSi(): Promise<SocketInfo[]> {
  const si = (await import('systeminformation')).default
  const connections = await si.networkConnections()
  const result: SocketInfo[] = []
  for (const c of connections) {
    const localPort = Number(c.localPort)
    const peerPort = Number(c.peerPort)
    result.push({
      pid: Number(c.pid) || 0,
      processName: (c.process ?? '').toLowerCase(),
      protocol: c.protocol ?? '',
      localAddress: c.localAddress ?? '',
      localPort: Number.isInteger(localPort) ? localPort : 0,
      peerAddress: c.peerAddress ?? '',
      peerPort: Number.isInteger(peerPort) ? peerPort : 0,
      state: (c.state ?? '').toUpperCase()
    })
  }
  return result
}

export interface NetworkInspectorOptions {
  getPolicy: () => DetectionPolicyBody | null
  /** IP ของเครื่องแม่ (อนุญาตเฉพาะพอร์ตสอบ — ดู getHostPort) */
  getHostIp: () => string | null
  /** พอร์ต TLS ของห้องสอบ (null = ยังไม่รู้ → ยกเว้น host IP ตามเดิม) */
  getHostPort?: () => number | null
  /** พอร์ต local proxy (Mode 3) — 0 = ไม่มี */
  getLocalProxyPort: () => number
  /** Phase 9.5: pid ลูกที่ code-ide sandbox สั่งรันเอง — loopback อนุญาต, ออกนอกฟ้องรหัสเฉพาะ */
  isAuthorizedPid?: (pid: number) => boolean
  emit: (event: DetectionEvent) => void
  listDnsCache?: () => Promise<string[]>
  listSockets?: () => Promise<SocketInfo[]>
  /** ค่า default gateway ปัจจุบัน (inject ได้เพื่อทดสอบ) */
  getDefaultGateway?: () => Promise<string | null>
  /** เพดานเวลาต่อ probe (default 4s) — กัน probe ค้างแล้ว watchdog มองไม่เห็น */
  probeTimeoutMs?: number
  now?: () => number
}

export class NetworkInspector {
  readonly detectorId = 'network-inspector'
  private readonly now: () => number
  private readonly listDnsCache: () => Promise<string[]>
  private readonly listSockets: () => Promise<SocketInfo[]>
  private readonly getDefaultGateway: () => Promise<string | null>
  private dnsBaseline: Set<string> | null = null
  private nicBaseline: Set<string> | null = null
  private gatewayBaseline: string | null = null
  private readonly reportedDomains = new Map<string, number>()
  /** นับ probe ที่ล้มติดกัน — กัน "ตรวจไม่ได้" ถูกตีความว่า "ไม่พบ" */
  private readonly probeFailures = new Map<string, number>()
  private readonly probeTimeoutMs: number
  /** เวลาที่สแกนจริงรอบล่าสุด (VULN-60: ห้ามคืนเวลาปัจจุบันหลอก watchdog) */
  private lastScanAtMs = 0

  constructor(private readonly opts: NetworkInspectorOptions) {
    this.now = opts.now ?? Date.now
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 4_000
    this.listDnsCache =
      opts.listDnsCache ??
      (process.platform === 'win32' ? readDnsCacheWindows : async () => [])
    this.listSockets = opts.listSockets ?? listConnectionsWithSi
    this.getDefaultGateway =
      opts.getDefaultGateway ??
      (async () => {
        try {
          const si = (await import('systeminformation')).default
          const gateway = await si.networkGatewayDefault()
          return typeof gateway === 'string' && gateway.length > 0 ? gateway : null
        } catch {
          return null
        }
      })
  }

  getLastTickAtMs(): number {
    return this.lastScanAtMs
  }

  private reportProbeFailure(probe: string, reason: string): void {
    const count = (this.probeFailures.get(probe) ?? 0) + 1
    this.probeFailures.set(probe, count)
    if (count === 2 || (count > 2 && count % 10 === 0)) {
      this.opts.emit(
        makeDetectionEvent(
          'GUARD_PROBE_FAILED',
          this.detectorId,
          {
            probe,
            consecutiveFailures: String(count),
            reason: reason.slice(0, 300)
          },
          undefined,
          this.now
        )
      )
    }
  }

  private clearProbeFailure(probe: string): void {
    this.probeFailures.delete(probe)
  }

  start(): void {
    // จับ baseline ตอนเริ่มสอบ
    this.dnsBaseline = null
    this.nicBaseline = new Set(Object.keys(os.networkInterfaces()).map((n) => n.toLowerCase()))
    this.gatewayBaseline = null
    void this.getDefaultGateway()
      .then((gateway) => {
        this.gatewayBaseline = gateway
      })
      .catch(() => {
        this.gatewayBaseline = null
      })
    void this.listDnsCache()
      .then((entries) => {
        this.dnsBaseline = new Set(entries.map((e) => e.toLowerCase()))
      })
      .catch(() => {
        this.dnsBaseline = null
      })
  }

  stop(): void {}

  async scanOnce(): Promise<DetectionEvent[]> {
    this.lastScanAtMs = this.now()
    const policy = this.opts.getPolicy()
    if (!policy) return []
    const events: DetectionEvent[] = []

    /* ---------- 1) DNS cache diffing ---------- */
    try {
      const current = await withProbeTimeout(this.listDnsCache(), this.probeTimeoutMs, 'dns-cache')
      this.clearProbeFailure('dns-cache')
      if (this.dnsBaseline) {
        for (const event of diffDnsCache(this.dnsBaseline, current, policy)) {
          const last = this.reportedDomains.get(event.detail.domain ?? '') ?? 0
          if (this.now() - last > 30_000) {
            this.reportedDomains.set(event.detail.domain ?? '', this.now())
            events.push(event)
          }
        }
      } else {
        this.dnsBaseline = new Set(current.map((e) => e.toLowerCase()))
      }
    } catch (error) {
      // อ่าน DNS cache ไม่ได้ — รายงานว่า probe ล้ม ไม่ใช่ "ไม่พบโดเมน"
      this.reportProbeFailure('dns-cache', error instanceof Error ? error.message : 'unknown')
    }

    /* ---------- 2) Virtual NIC / tunnel ใหม่ ---------- */
    const currentNics = os.networkInterfaces()
    for (const name of diffNetworkInterfaces(this.nicBaseline ?? new Set(), Object.keys(currentNics))) {
      events.push(
        makeDetectionEvent('NETWORK_TUNNEL_OR_PROXY_TAMPER', this.detectorId, {
          interface: name
        })
      )
    }
    if (!this.nicBaseline) {
      this.nicBaseline = new Set(Object.keys(currentNics).map((n) => n.toLowerCase()))
    }
    /* ---------- 2b) เส้นทางออกหลักเปลี่ยน ---------- */
    try {
      const gateway = await withProbeTimeout(
        this.getDefaultGateway(),
        this.probeTimeoutMs,
        'default-gateway'
      )
      this.clearProbeFailure('default-gateway')
      if (gateway && this.gatewayBaseline && gateway !== this.gatewayBaseline) {
        events.push(
          makeDetectionEvent('NETWORK_TUNNEL_OR_PROXY_TAMPER', this.detectorId, {
            gateway,
            baseline: this.gatewayBaseline
          })
        )
        // อัปเดตค่าอ้างอิงหลังรายงาน เพื่อไม่ให้ยิงซ้ำทุกรอบเมื่อเส้นทางเปลี่ยนถาวร
        this.gatewayBaseline = gateway
      } else if (!this.gatewayBaseline && gateway) {
        this.gatewayBaseline = gateway
      }
    } catch (error) {
      // อ่าน gateway ไม่ได้ — รายงาน probe ล้ม
      this.reportProbeFailure('default-gateway', error instanceof Error ? error.message : 'unknown')
    }
    /* ---------- 3) Active sockets รายโปรเซส ---------- */
    try {
      const sockets = await withProbeTimeout(this.listSockets(), this.probeTimeoutMs, 'socket-list')
      this.clearProbeFailure('socket-list')
      const hostIp = this.opts.getHostIp()
      const hostPort = this.opts.getHostPort?.() ?? null
      const proxyPort = this.opts.getLocalProxyPort()
      for (const socket of sockets) {
        if (socket.pid === process.pid) continue
        const established = socket.state.startsWith('ESTABLISH')
        if (!established) continue
        if (isLoopback(socket.peerAddress)) continue
        // เครื่องแม่อนุญาตเฉพาะพอร์ตสอบ (ไม่ยกเว้นทั้ง IP จนเข้าบริการอื่นได้)
        if (hostIp && socket.peerAddress === hostIp && (hostPort === null || socket.peerPort === hostPort)) continue
        // VULN-55: ยกเว้นเฉพาะท่อที่ไปยัง proxy บน loopback — ไม่ยกเว้นพอร์ตเดียวกันบนเครื่องปลายทางอื่น
        if (
          proxyPort > 0 &&
          socket.peerPort === proxyPort &&
          isLoopback(socket.peerAddress)
        ) {
          continue
        }
        // Phase 9.5: โปรเซสลูกของ code-ide sandbox (เซิร์ฟเวอร์ backend / CLI run)
        // หลุดออกนอก loopback = ฟ้องรหัสเฉพาะ STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL ทันที
        if (this.opts.isAuthorizedPid?.(socket.pid) === true) {
          events.push(
            makeDetectionEvent('STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL', this.detectorId, {
              pid: String(socket.pid),
              processName: socket.processName,
              peer: `${socket.peerAddress}:${socket.peerPort}`,
              origin: 'student-code-sandbox'
            })
          )
          continue
        }
        if (policy.examMode === 'closed') {
          events.push(
            makeDetectionEvent('DIRECT_SOCKET_PROXY_BYPASS', this.detectorId, {
              pid: String(socket.pid),
              processName: socket.processName,
              peer: `${socket.peerAddress}:${socket.peerPort}`,
              mode: 'closed'
            })
          )
        } else if (
          policy.examMode === 'external-tools' &&
          [80, 443, 8080, 8443].includes(socket.peerPort)
        ) {
          events.push(
            makeDetectionEvent('DIRECT_SOCKET_PROXY_BYPASS', this.detectorId, {
              pid: String(socket.pid),
              processName: socket.processName,
              peer: `${socket.peerAddress}:${socket.peerPort}`,
              mode: 'external-tools'
            })
          )
        }
      }
    } catch (error) {
      // สแกน sockets ไม่ได้ — รายงาน probe ล้ม
      this.reportProbeFailure('socket-list', error instanceof Error ? error.message : 'unknown')
    }

    const seen = new Set<string>()
    const unique = events.filter((event) => {
      const key = `${event.code}:${event.detail.pid ?? ''}:${event.detail.domain ?? ''}:${event.detail.interface ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    for (const event of unique) this.opts.emit(event)
    return unique
  }
}

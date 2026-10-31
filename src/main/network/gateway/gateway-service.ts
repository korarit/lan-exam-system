import os from 'node:os'
import {
  GATEWAY_DNS_PORT,
  MAX_GATEWAY_DNS_LOG,
  MAX_GATEWAY_LEASES,
  GatewayStartRequestSchema,
  ipv4ToInt,
  isIpv4,
  parseCidr,
  type GatewayDnsLogEntry,
  type GatewayInterfaceInfo,
  type GatewayLease,
  type GatewayPosture,
  type GatewayStartRequest,
  type GatewayStatus
} from '@shared/gateway'
import type { AppRole } from '@shared/types/role'
import {
  DhcpServer,
  normalizeMac,
  type DhcpServerConfig
} from './dhcp-server'
import { DnsSinkholeServer, type DnsSinkholeConfig } from './dns-sinkhole'
import { probeGatewayPosture } from './gateway-posture'

/* ============================================================
 * GatewayService — orchestrate DHCP + DNS sinkhole + posture
 *
 * สัญญาความปลอดภัย (MVP):
 * - เครื่องแม่เป็น default gateway ผ่าน DHCP โดยไม่ทำ forwarding/NAT
 * - เครื่องแม่จึงยังออกอินเทอร์เน็ตได้เอง แต่นักเรียนออกไม่ได้
 * - ถ้าปิด forwarding ไม่สำเร็จ → degraded + critical warning (ไม่กล่าวอ้างว่าบังคับได้)
 * - static IP/gateway หรือ IPv6 RA ยัง bypass ได้ถ้าห้องไม่คุม switch/VLAN
 * ============================================================ */

export interface GatewayDhcpLike {
  start(): Promise<void>
  stop(): void
  getLeases(): GatewayLease[]
}

export interface GatewayDnsLike {
  start(): Promise<void>
  stop(): void
  getLog(): GatewayDnsLogEntry[]
}

export interface GatewayServiceDeps {
  getRole: () => AppRole
  listInterfaces?: () => GatewayInterfaceInfo[]
  probePosture?: (options: { attemptDisable: boolean }) => Promise<GatewayPosture>
  createDhcp?: (config: DhcpServerConfig) => GatewayDhcpLike
  createDns?: (config: DnsSinkholeConfig) => GatewayDnsLike
  now?: () => number
  onStatus?: (status: GatewayStatus) => void
  onDnsQuery?: (entry: GatewayDnsLogEntry) => void
  /** eventCode/summary/evidence สำหรับ audit hash chain ของเครื่องแม่ */
  onAudit?: (eventCode: string, summaryText: string, evidence: Record<string, unknown>) => void
}

export interface GatewayRuntimeConfig {
  request: GatewayStartRequest
  allowlist: string[]
}

function prefixFromNetmask(netmask: string): number | null {
  if (!isIpv4(netmask)) return null
  let value = ipv4ToInt(netmask)
  let prefix = 0
  while (prefix < 32 && (value & 0x80000000) !== 0) {
    prefix += 1
    value = (value << 1) >>> 0
  }
  if (value !== 0) return null // non-contiguous mask
  return prefix
}

/** รับเฉพาะ IPv4 ที่ไม่ใช่ internal — ใช้ให้ UI เลือก interface */
export function listGatewayInterfaces(): GatewayInterfaceInfo[] {
  const results: GatewayInterfaceInfo[] = []
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const prefix = prefixFromNetmask(entry.netmask)
      if (prefix === null) continue
      const mac = entry.mac && entry.mac !== '00:00:00:00:00:00' ? normalizeMac(entry.mac) : null
      results.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        cidr: `${entry.address}/${prefix}`,
        mac
      })
    }
  }
  return results.sort((a, b) => (a.name === b.name ? ipv4ToInt(a.address) - ipv4ToInt(b.address) : a.name.localeCompare(b.name)))
}

function stoppedStatus(): GatewayStatus {
  return {
    state: 'stopped',
    running: false,
    interfaceName: null,
    hostIp: null,
    subnetCidr: null,
    poolStart: null,
    poolEnd: null,
    leaseCount: 0,
    posture: null,
    warnings: [],
    lastError: null,
    startedAtMs: null
  }
}

export class GatewayService {
  private dhcp: GatewayDhcpLike | null = null
  private dns: GatewayDnsLike | null = null
  private runtime: GatewayRuntimeConfig | null = null
  private readonly dnsLog: GatewayDnsLogEntry[] = []
  private status: GatewayStatus = stoppedStatus()
  private readonly now: () => number

  constructor(private readonly deps: GatewayServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  get running(): boolean {
    return this.dhcp !== null && this.dns !== null
  }

  listInterfaces(): GatewayInterfaceInfo[] {
    return (this.deps.listInterfaces ?? listGatewayInterfaces)()
  }

  getStatus(): GatewayStatus {
    const leases = this.dhcp?.getLeases() ?? []
    return {
      ...this.status,
      running: this.running,
      leaseCount: leases.length
    }
  }

  getLeases(): GatewayLease[] {
    return (this.dhcp?.getLeases() ?? []).slice(0, MAX_GATEWAY_LEASES)
  }

  getDnsLog(): GatewayDnsLogEntry[] {
    return [...this.dnsLog]
  }

  /** เริ่ม gateway — เฉพาะ role=host, เฉพาะโหมด closed, ค่าเริ่มต้นคือหยุดอยู่ */
  async start(input: GatewayStartRequest): Promise<GatewayStatus> {
    if (this.deps.getRole() !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    if (this.running) throw new Error('GATEWAY_ALREADY_RUNNING')

    const parsed = GatewayStartRequestSchema.safeParse(input)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(`GATEWAY_INVALID_CONFIG: ${issue ? issue.message : 'invalid input'}`)
    }
    const request = parsed.data
    if (request.examMode !== 'closed') {
      throw new Error('GATEWAY_CLOSED_MODE_ONLY: โหมดนี้ใช้กับข้อสอบแบบ closed เท่านั้น')
    }

    const cidr = parseCidr(request.subnetCidr)
    if (!cidr) throw new Error('GATEWAY_INVALID_SUBNET')
    if (!isIpInCidrRange(request.hostIp, cidr.network, cidr.broadcast)) {
      throw new Error('GATEWAY_HOST_OUTSIDE_SUBNET')
    }
    const poolStartInt = ipv4ToInt(request.poolStart)
    const poolEndInt = ipv4ToInt(request.poolEnd)
    const networkInt = ipv4ToInt(cidr.network)
    const broadcastInt = ipv4ToInt(cidr.broadcast)
    if (poolStartInt > poolEndInt) throw new Error('GATEWAY_POOL_RANGE_INVALID')
    if (poolStartInt <= networkInt || poolEndInt >= broadcastInt) {
      throw new Error('GATEWAY_POOL_MUST_EXCLUDE_NETWORK_AND_BROADCAST')
    }
    if (poolStartInt < networkInt || poolEndInt > broadcastInt) {
      throw new Error('GATEWAY_POOL_OUTSIDE_SUBNET')
    }

    const interfaces = this.listInterfaces()
    const iface = interfaces.find(
      (entry) => entry.name === request.interfaceName && entry.address === request.hostIp
    )
    if (!iface) {
      const sameName = interfaces.find((entry) => entry.name === request.interfaceName)
      if (!sameName) throw new Error('GATEWAY_INTERFACE_NOT_FOUND')
      throw new Error('GATEWAY_HOST_IP_NOT_ON_INTERFACE')
    }

    const allowlist = request.allowlistDomains
      .map((domain) => domain.trim())
      .filter((domain) => domain.length > 0)
      .slice(0, 512)

    let posture: GatewayPosture
    try {
      posture = await (this.deps.probePosture ?? ((options) => probeGatewayPosture(options)))({
        attemptDisable: true
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown posture error'
      posture = {
        ipv4Forwarding: null,
        ipv6Forwarding: null,
        icsEnabled: null,
        canDisable: false,
        changed: [],
        warnings: [`ตรวจสอบ forwarding posture ไม่สำเร็จ: ${message}`]
      }
    }

    const warnings = [...posture.warnings]
    if (!posture.canDisable && warnings.length === 0) {
      warnings.push('ไม่สามารถปิด forwarding ได้ — โหมดนี้ทำงานแบบ degraded ไม่ได้บังคับตัดเน็ต')
    }

    const dhcpConfig: DhcpServerConfig = {
      interfaceName: request.interfaceName,
      hostIp: request.hostIp,
      subnetCidr: request.subnetCidr,
      poolStart: request.poolStart,
      poolEnd: request.poolEnd,
      leaseTimeSeconds: request.leaseTimeSeconds,
      serverIdentifier: request.hostIp,
      onLeasesChanged: () => this.emitStatus()
    }
    if (iface.mac) dhcpConfig.serverMac = iface.mac
    if (this.deps.createDhcp === undefined) dhcpConfig.onError = (error) => console.warn(`[gateway-dhcp] ${error.message}`)

    const dnsConfig: DnsSinkholeConfig = {
      allowlist,
      upstream: { address: request.upstreamDns, port: GATEWAY_DNS_PORT },
      onQuery: (entry) => this.handleDnsQuery(entry),
      onError: (error) => console.warn(`[gateway-dns] ${error.message}`)
    }

    const dhcp = (this.deps.createDhcp ?? ((config) => new DhcpServer(config)))(dhcpConfig)
    const dns = (this.deps.createDns ?? ((config) => new DnsSinkholeServer(config)))(dnsConfig)

    try {
      await dhcp.start()
      await dns.start()
    } catch (error) {
      try {
        dhcp.stop()
      } catch {
        // ข้าม
      }
      try {
        dns.stop()
      } catch {
        // ข้าม
      }
      const message = error instanceof Error ? error.message : 'unknown gateway start error'
      this.status = {
        ...this.status,
        state: 'error',
        running: false,
        interfaceName: request.interfaceName,
        hostIp: request.hostIp,
        subnetCidr: request.subnetCidr,
        poolStart: request.poolStart,
        poolEnd: request.poolEnd,
        leaseCount: 0,
        posture,
        warnings,
        lastError: message,
        startedAtMs: null
      }
      this.emitStatus()
      throw new Error(`GATEWAY_START_FAILED: ${message}`)
    }

    this.dhcp = dhcp
    this.dns = dns
    this.runtime = { request, allowlist }
    this.dnsLog.length = 0
    this.status = {
      state: posture.canDisable ? 'running' : 'degraded',
      running: true,
      interfaceName: request.interfaceName,
      hostIp: request.hostIp,
      subnetCidr: request.subnetCidr,
      poolStart: request.poolStart,
      poolEnd: request.poolEnd,
      leaseCount: 0,
      posture,
      warnings,
      lastError: null,
      startedAtMs: this.now()
    }
    this.emitStatus()
    this.deps.onAudit?.('GATEWAY_STARTED', 'เริ่ม Network Gateway (host-as-gateway)', {
      interfaceName: request.interfaceName,
      hostIp: request.hostIp,
      subnetCidr: request.subnetCidr,
      pool: `${request.poolStart}-${request.poolEnd}`,
      leaseTimeSeconds: request.leaseTimeSeconds,
      allowlistDomains: allowlist,
      upstreamDns: request.upstreamDns,
      degraded: !posture.canDisable,
      posture
    })
    return this.getStatus()
  }

  /** หยุด gateway — ปลอดภัยเมื่อเรียกซ้ำ */
  stop(): GatewayStatus {
    const wasRunning = this.running
    const runtime = this.runtime
    try {
      this.dhcp?.stop()
    } catch {
      // ข้าม
    }
    try {
      this.dns?.stop()
    } catch {
      // ข้าม
    }
    this.dhcp = null
    this.dns = null
    this.runtime = null
    this.status = {
      ...this.status,
      state: 'stopped',
      running: false,
      leaseCount: 0,
      warnings: [],
      lastError: null,
      startedAtMs: null
    }
    if (wasRunning) {
      this.deps.onAudit?.('GATEWAY_STOPPED', 'หยุด Network Gateway', {
        interfaceName: runtime?.request.interfaceName ?? null,
        hostIp: runtime?.request.hostIp ?? null,
        subnetCidr: runtime?.request.subnetCidr ?? null
      })
    }
    this.emitStatus()
    return this.getStatus()
  }

  /* ---------- internals ---------- */

  private handleDnsQuery(entry: GatewayDnsLogEntry): void {
    this.dnsLog.push(entry)
    if (this.dnsLog.length > MAX_GATEWAY_DNS_LOG) {
      this.dnsLog.splice(0, this.dnsLog.length - MAX_GATEWAY_DNS_LOG)
    }
    this.deps.onDnsQuery?.(entry)
  }

  private emitStatus(): void {
    this.deps.onStatus?.(this.getStatus())
  }
}

function isIpInCidrRange(ip: string, network: string, broadcast: string): boolean {
  if (!isIpv4(ip)) return false
  const value = ipv4ToInt(ip)
  return value >= ipv4ToInt(network) && value <= ipv4ToInt(broadcast)
}

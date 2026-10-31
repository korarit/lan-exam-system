import { describe, expect, it } from 'vitest'
import { GatewayService, type GatewayDhcpLike, type GatewayDnsLike } from './gateway-service'
import type { DhcpServerConfig } from './dhcp-server'
import type { DnsSinkholeConfig } from './dns-sinkhole'
import type { AppRole } from '@shared/types/role'
import type {
  GatewayDnsLogEntry,
  GatewayInterfaceInfo,
  GatewayLease,
  GatewayPosture,
  GatewayStartRequest
} from '@shared/gateway'

const INTERFACES: GatewayInterfaceInfo[] = [
  {
    name: 'eth-test',
    address: '192.168.50.10',
    netmask: '255.255.255.0',
    cidr: '192.168.50.10/24',
    mac: '02:00:00:00:00:10'
  }
]

const REQUEST: GatewayStartRequest = {
  interfaceName: 'eth-test',
  hostIp: '192.168.50.10',
  subnetCidr: '192.168.50.0/24',
  poolStart: '192.168.50.100',
  poolEnd: '192.168.50.150',
  leaseTimeSeconds: 3600,
  allowlistDomains: ['school.test'],
  upstreamDns: '1.1.1.1',
  examMode: 'closed'
}

const OK_POSTURE: GatewayPosture = {
  ipv4Forwarding: false,
  ipv6Forwarding: false,
  icsEnabled: false,
  canDisable: true,
  changed: [],
  warnings: []
}

class FakeDhcp implements GatewayDhcpLike {
  started = false
  stopped = false
  failed = false
  leases: GatewayLease[] = []
  constructor(readonly config: DhcpServerConfig) {}
  async start(): Promise<void> {
    if (this.failed) throw new Error('DHCP_BIND_FAILED: address in use')
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
  getLeases(): GatewayLease[] {
    return this.leases
  }
}

class FakeDns implements GatewayDnsLike {
  started = false
  stopped = false
  log: GatewayDnsLogEntry[] = []
  constructor(readonly config: DnsSinkholeConfig) {}
  async start(): Promise<void> {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
  getLog(): GatewayDnsLogEntry[] {
    return this.log
  }
  emit(entry: GatewayDnsLogEntry): void {
    this.log.push(entry)
    this.config.onQuery?.(entry)
  }
}

function makeLease(index: number): GatewayLease {
  return {
    mac: `AA:BB:CC:DD:EE:${String(index % 100).padStart(2, '0')}`,
    ip: `192.168.50.${100 + (index % 100)}`,
    hostname: `pc-${index}`,
    startedAtMs: 1,
    expiresAtMs: 2
  }
}

function makeDnsEntry(domain: string, allowed: boolean): GatewayDnsLogEntry {
  return {
    atMs: 1,
    domain,
    qtype: 1,
    qclass: 1,
    clientIp: '192.168.50.100',
    allowed,
    action: allowed ? 'forwarded' : 'blocked',
    responseCode: allowed ? 0 : 3,
    upstream: allowed ? '1.1.1.1:53' : null
  }
}

function setup(overrides: { posture?: GatewayPosture; dhcpFails?: boolean } = {}) {
  let role: AppRole = 'host'
  let dhcp: FakeDhcp | null = null
  let dns: FakeDns | null = null
  const dnsQueries: GatewayDnsLogEntry[] = []
  const audits: string[] = []
  let postureCalls = 0
  const service = new GatewayService({
    getRole: () => role,
    listInterfaces: () => INTERFACES,
    probePosture: async () => {
      postureCalls += 1
      return overrides.posture ?? OK_POSTURE
    },
    createDhcp: (config) => {
      dhcp = new FakeDhcp(config)
      dhcp.failed = overrides.dhcpFails === true
      return dhcp
    },
    createDns: (config) => {
      dns = new FakeDns(config)
      return dns
    },
    onDnsQuery: (entry) => dnsQueries.push(entry),
    onAudit: (eventCode) => audits.push(eventCode)
  })
  return {
    service,
    setRole: (next: AppRole) => {
      role = next
    },
    dhcp: () => dhcp,
    dns: () => dns,
    dnsQueries,
    audits,
    postureCalls: () => postureCalls
  }
}

describe('GatewayService', () => {
  it('starts and stops DHCP + DNS only for the host role', async () => {
    const harness = setup()
    const started = await harness.service.start(REQUEST)
    expect(started.state).toBe('running')
    expect(started.running).toBe(true)
    expect(harness.dhcp()?.started).toBe(true)
    expect(harness.dns()?.started).toBe(true)
    expect(harness.postureCalls()).toBe(1)
    expect(harness.audits).toContain('GATEWAY_STARTED')

    const stopped = harness.service.stop()
    expect(stopped.state).toBe('stopped')
    expect(stopped.running).toBe(false)
    expect(harness.dhcp()?.stopped).toBe(true)
    expect(harness.dns()?.stopped).toBe(true)
    expect(harness.audits).toContain('GATEWAY_STOPPED')
  })

  it('refuses to start for the student role', async () => {
    const harness = setup()
    harness.setRole('student')
    await expect(harness.service.start(REQUEST)).rejects.toThrow('HOST_ROLE_REQUIRED')
    expect(harness.dhcp()).toBeNull()
    expect(harness.postureCalls()).toBe(0)
  })

  it('refuses non-closed exam modes', async () => {
    const harness = setup()
    await expect(harness.service.start({ ...REQUEST, examMode: 'in-app-docs' })).rejects.toThrow(
      'GATEWAY_CLOSED_MODE_ONLY'
    )
  })

  it('starts in degraded mode when forwarding cannot be disabled', async () => {
    const harness = setup({
      posture: {
        ipv4Forwarding: true,
        ipv6Forwarding: true,
        icsEnabled: false,
        canDisable: false,
        changed: [],
        warnings: ['IPv4 forwarding still enabled']
      }
    })
    const status = await harness.service.start(REQUEST)
    expect(status.state).toBe('degraded')
    expect(status.running).toBe(true)
    expect(status.warnings).toContain('IPv4 forwarding still enabled')
  })

  it('rejects an interface that does not own the host IP', async () => {
    const harness = setup()
    await expect(harness.service.start({ ...REQUEST, hostIp: '192.168.50.99' })).rejects.toThrow(
      'GATEWAY_HOST_IP_NOT_ON_INTERFACE'
    )
  })

  it('exposes leases and DNS log accessors with caps', async () => {
    const harness = setup()
    await harness.service.start(REQUEST)
    const leases = Array.from({ length: 300 }, (_, index) => makeLease(index))
    harness.dhcp()!.leases = leases
    expect(harness.service.getLeases()).toHaveLength(256)

    for (let index = 0; index < 505; index += 1) {
      harness.dns()!.emit(makeDnsEntry(`blocked-${index}.test`, false))
    }
    expect(harness.service.getDnsLog()).toHaveLength(500)
    expect(harness.dnsQueries).toHaveLength(505)
  })

  it('records a start error and cleans up when DHCP binding fails', async () => {
    const harness = setup({ dhcpFails: true })
    await expect(harness.service.start(REQUEST)).rejects.toThrow('GATEWAY_START_FAILED')
    const status = harness.service.getStatus()
    expect(status.state).toBe('error')
    expect(status.running).toBe(false)
    expect(status.lastError).toContain('DHCP_BIND_FAILED')
    expect(harness.dhcp()?.stopped).toBe(true)
    expect(harness.dns()?.started).toBe(false)
  })
})

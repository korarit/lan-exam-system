import { z } from 'zod'

/* ============================================================
 * Host-as-Gateway (security item 2)
 * - เครื่องแม่ทำ DHCPv4 + DNS sinkhole และ "ไม่ forward" ทราฟฟิก
 * - ค่าเริ่มต้นคือ deny-all สำหรับ DNS; ต้องมี allowlist เอง
 * - นี่เป็น network configuration control ไม่ใช่ hardware root of trust
 * ============================================================ */

export const GATEWAY_DHCP_PORT = 67
export const GATEWAY_DNS_PORT = 53
export const MAX_GATEWAY_LEASES = 256
export const MAX_GATEWAY_DNS_LOG = 500

export function isIpv4(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (part.length === 0 || part.length > 3) return false
    if (!/^\d+$/.test(part)) return false
    const n = Number(part)
    return n >= 0 && n <= 255
  })
}

export function ipv4ToInt(address: string): number {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return 0
  }
  // eslint-disable-next-line no-bitwise
  return (((parts[0]! << 24) >>> 0) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

export function intToIpv4(value: number): string {
  const v = value >>> 0
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.')
}

export interface ParsedCidr {
  address: string
  prefix: number
  network: string
  broadcast: string
  netmask: string
}

export function parseCidr(cidr: string): ParsedCidr | null {
  const [address, prefixRaw] = cidr.split('/')
  if (!address || prefixRaw === undefined || !isIpv4(address)) return null
  const prefix = Number(prefixRaw)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const ip = ipv4ToInt(address)
  const network = (ip & mask) >>> 0
  const broadcast = (network | (~mask >>> 0)) >>> 0
  return {
    address,
    prefix,
    network: intToIpv4(network),
    broadcast: intToIpv4(broadcast),
    netmask: intToIpv4(mask)
  }
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr)
  if (!parsed || !isIpv4(ip)) return false
  const value = ipv4ToInt(ip)
  const network = ipv4ToInt(parsed.network)
  const broadcast = ipv4ToInt(parsed.broadcast)
  return value >= network && value <= broadcast
}

/** แนะนำ pool แบบ /24-friendly โดยเว้นที่อยู่ของ host ไว้ */
export function suggestPool(hostIp: string, cidr: string): { poolStart: string; poolEnd: string } {
  const parsed = parseCidr(cidr)
  if (!parsed || !isIpv4(hostIp)) return { poolStart: '192.168.50.100', poolEnd: '192.168.50.200' }
  const network = ipv4ToInt(parsed.network)
  const broadcast = ipv4ToInt(parsed.broadcast)
  const firstUsable = network + 2
  const lastUsable = Math.max(firstUsable, broadcast - 1)
  const host = ipv4ToInt(hostIp)
  let start = Math.min(network + 100, lastUsable)
  if (start < firstUsable) start = firstUsable
  if (start === host) start += 1
  let end = Math.min(network + 200, lastUsable)
  if (end < start) end = start
  if (end === host) end = Math.min(lastUsable, end + 1)
  return { poolStart: intToIpv4(start), poolEnd: intToIpv4(end) }
}

export const GatewayStateSchema = z.enum(['stopped', 'running', 'degraded', 'error'])
export type GatewayState = z.infer<typeof GatewayStateSchema>

export const GatewayInterfaceSchema = z
  .object({
    name: z.string().min(1).max(80),
    address: z.string().min(7).max(15),
    netmask: z.string().min(7).max(15),
    cidr: z.string().min(9).max(18),
    mac: z.string().max(32).nullable()
  })
  .strict()
export type GatewayInterfaceInfo = z.infer<typeof GatewayInterfaceSchema>

export const GatewayPostureSchema = z
  .object({
    ipv4Forwarding: z.boolean().nullable(),
    ipv6Forwarding: z.boolean().nullable(),
    icsEnabled: z.boolean().nullable(),
    canDisable: z.boolean(),
    changed: z.array(z.string().max(200)).max(32),
    warnings: z.array(z.string().max(500)).max(32)
  })
  .strict()
export type GatewayPosture = z.infer<typeof GatewayPostureSchema>

const ipv4Field = z
  .string()
  .min(7)
  .max(15)
  .refine(isIpv4, { message: 'invalid IPv4 address' })

const cidrField = z
  .string()
  .min(9)
  .max(18)
  .refine((value) => parseCidr(value) !== null, { message: 'invalid IPv4 CIDR' })

export const GatewayStartRequestSchema = z
  .object({
    interfaceName: z.string().min(1).max(80),
    hostIp: ipv4Field,
    subnetCidr: cidrField,
    poolStart: ipv4Field,
    poolEnd: ipv4Field,
    leaseTimeSeconds: z.number().int().min(300).max(604_800),
    allowlistDomains: z.array(z.string().min(1).max(253)).max(512),
    upstreamDns: ipv4Field,
    examMode: z.enum(['closed', 'in-app-docs', 'external-tools'])
  })
  .strict()
export type GatewayStartRequest = z.infer<typeof GatewayStartRequestSchema>

export const GatewayLeaseSchema = z
  .object({
    mac: z.string().min(11).max(32),
    ip: z.string().min(7).max(15),
    hostname: z.string().max(120).nullable(),
    startedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative()
  })
  .strict()
export type GatewayLease = z.infer<typeof GatewayLeaseSchema>

export const GatewayDnsLogEntrySchema = z
  .object({
    atMs: z.number().int().nonnegative(),
    domain: z.string().max(253),
    qtype: z.number().int().nonnegative(),
    qclass: z.number().int().nonnegative(),
    clientIp: z.string().max(45),
    allowed: z.boolean(),
    action: z.enum(['forwarded', 'blocked', 'servfail', 'malformed']),
    responseCode: z.number().int().min(0).max(15),
    upstream: z.string().max(80).nullable()
  })
  .strict()
export type GatewayDnsLogEntry = z.infer<typeof GatewayDnsLogEntrySchema>

export const GatewayStatusSchema = z
  .object({
    state: GatewayStateSchema,
    running: z.boolean(),
    interfaceName: z.string().max(80).nullable(),
    hostIp: z.string().max(15).nullable(),
    subnetCidr: z.string().max(18).nullable(),
    poolStart: z.string().max(15).nullable(),
    poolEnd: z.string().max(15).nullable(),
    leaseCount: z.number().int().nonnegative(),
    posture: GatewayPostureSchema.nullable(),
    warnings: z.array(z.string().max(500)).max(32),
    lastError: z.string().max(500).nullable(),
    startedAtMs: z.number().int().nonnegative().nullable()
  })
  .strict()
export type GatewayStatus = z.infer<typeof GatewayStatusSchema>

export const GatewayInterfacesResponseSchema = z
  .object({ interfaces: z.array(GatewayInterfaceSchema).max(64) })
  .strict()
export const GatewayLeasesResponseSchema = z
  .object({ leases: z.array(GatewayLeaseSchema).max(MAX_GATEWAY_LEASES) })
  .strict()
export const GatewayDnsLogResponseSchema = z
  .object({ entries: z.array(GatewayDnsLogEntrySchema).max(MAX_GATEWAY_DNS_LOG) })
  .strict()

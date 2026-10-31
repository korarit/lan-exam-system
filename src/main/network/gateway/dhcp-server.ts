import dgram from 'node:dgram'
import {
  GATEWAY_DHCP_PORT,
  intToIpv4,
  ipv4ToInt,
  isIpv4,
  parseCidr,
  type GatewayLease
} from '@shared/gateway'

/* ============================================================
 * Minimal DHCPv4 server (node:dgram)
 * - DISCOVER -> OFFER, REQUEST -> ACK/NAK, RELEASE
 * - Same L2 only (giaddr = 0.0.0.0)
 * - ไม่ทำ relay / ไม่แจก option ที่ไม่จำเป็น
 * - ไม่มี dependency ภายนอก — pure encode/parse แยกไว้ให้ test
 * ============================================================ */

export const DHCP_MAGIC_COOKIE = 0x63825363

export const DHCP_OPTION = {
  subnetMask: 1,
  router: 3,
  dns: 6,
  hostname: 12,
  broadcast: 28,
  requestedIp: 50,
  leaseTime: 51,
  messageType: 53,
  serverIdentifier: 54
} as const

export const DHCP_MESSAGE_TYPE = {
  discover: 1,
  offer: 2,
  request: 3,
  decline: 4,
  ack: 5,
  nak: 6,
  release: 7,
  inform: 8
} as const

export type DhcpReplyType = 'offer' | 'ack' | 'nak'

export interface ParsedDhcpPacket {
  op: number
  htype: number
  hlen: number
  hops: number
  xid: number
  secs: number
  flags: number
  ciaddr: string
  yiaddr: string
  siaddr: string
  giaddr: string
  /** 16-byte chaddr field ตามสเปก (ใช้ echo กลับ) */
  chaddrField: Buffer
  mac: string
  options: Map<number, Buffer>
  messageType: number | null
  hostname: string | null
  requestedIp: string | null
  serverIdentifier: string | null
}

export interface DhcpServerConfig {
  interfaceName: string
  /** ที่อยู่ bind (default 0.0.0.0 เพื่อรับ broadcast) */
  bindAddress?: string
  hostIp: string
  subnetCidr: string
  poolStart: string
  poolEnd: string
  leaseTimeSeconds: number
  /** default = hostIp */
  serverIdentifier?: string
  /** MAC ของเครื่องแม่ — ใช้ตัด packet ของตัวเอง (default = MAC ของ interface) */
  serverMac?: string
  /** พอร์ต server (default 67) — test เท่านั้นที่ควรเปลี่ยน */
  port?: number
  /** พอร์ต client (default 68) */
  clientPort?: number
  /** override broadcast ปลายทาง (test ใช้ 127.0.0.1) */
  broadcastAddress?: string
  now?: () => number
  onError?: (error: Error) => void
  onLeasesChanged?: (leases: GatewayLease[]) => void
}

interface LeaseRecord {
  mac: string
  ip: string
  hostname: string | null
  startedAtMs: number
  expiresAtMs: number
}

const BROADCAST_FLAG = 0x8000

/** MAC → รูปแบบ AA:BB:CC:DD:EE:FF (คืนค่าเดิมถ้า parse ไม่ได้) */
export function normalizeMac(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (hex.length < 12) return value.toUpperCase()
  const bytes: string[] = []
  for (let i = 0; i < 12; i += 2) bytes.push(hex.slice(i, i + 2))
  return bytes.join(':')
}

function readIpv4(buf: Buffer, offset: number): string {
  return [buf[offset]!, buf[offset + 1]!, buf[offset + 2]!, buf[offset + 3]!].join('.')
}

function ipv4Buffer(address: string): Buffer {
  const value = ipv4ToInt(address)
  const buf = Buffer.allocUnsafe(4)
  buf.writeUInt32BE(value >>> 0, 0)
  return buf
}

/**
 * Parse DHCP/BOOTP packet — คืน null เมื่อ malformed
 * รองรับเฉพาะ option ที่โหมดนี้ใช้ (ไม่ parse overload)
 */
export function parseDhcpPacket(buffer: Buffer): ParsedDhcpPacket | null {
  if (buffer.length < 240) return null
  if (buffer.readUInt32BE(236) !== DHCP_MAGIC_COOKIE) return null
  const op = buffer.readUInt8(0)
  const htype = buffer.readUInt8(1)
  const hlen = buffer.readUInt8(2)
  if (hlen < 1 || hlen > 16) return null
  const hops = buffer.readUInt8(3)
  const xid = buffer.readUInt32BE(4)
  const secs = buffer.readUInt16BE(8)
  const flags = buffer.readUInt16BE(10)
  const ciaddr = readIpv4(buffer, 12)
  const yiaddr = readIpv4(buffer, 16)
  const siaddr = readIpv4(buffer, 20)
  const giaddr = readIpv4(buffer, 24)
  const chaddrField = Buffer.from(buffer.subarray(28, 44))
  const mac = hlen === 6 ? normalizeMac(chaddrField.subarray(0, 6).toString('hex')) : ''

  const options = new Map<number, Buffer>()
  let offset = 240
  while (offset < buffer.length) {
    const code = buffer.readUInt8(offset)
    offset += 1
    if (code === 0) continue // pad
    if (code === 255) break // end
    if (offset >= buffer.length) return null
    const length = buffer.readUInt8(offset)
    offset += 1
    if (offset + length > buffer.length) return null
    options.set(code, Buffer.from(buffer.subarray(offset, offset + length)))
    offset += length
  }

  const typeOption = options.get(DHCP_OPTION.messageType)
  const messageType = typeOption && typeOption.length >= 1 ? typeOption.readUInt8(0) : null
  const hostnameOption = options.get(DHCP_OPTION.hostname)
  const hostname =
    hostnameOption && hostnameOption.length > 0
      ? hostnameOption.toString('utf8').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || null
      : null
  const requestedIpOption = options.get(DHCP_OPTION.requestedIp)
  const requestedIp =
    requestedIpOption && requestedIpOption.length === 4 ? readIpv4(requestedIpOption, 0) : null
  const serverIdOption = options.get(DHCP_OPTION.serverIdentifier)
  const serverIdentifier =
    serverIdOption && serverIdOption.length === 4 ? readIpv4(serverIdOption, 0) : null

  return {
    op,
    htype,
    hlen,
    hops,
    xid,
    secs,
    flags,
    ciaddr,
    yiaddr,
    siaddr,
    giaddr,
    chaddrField,
    mac,
    options,
    messageType,
    hostname,
    requestedIp,
    serverIdentifier
  }
}

export interface BuildDhcpReplyInput {
  request: ParsedDhcpPacket
  type: DhcpReplyType
  serverIp: string
  yiaddr: string
  subnetMask: string
  router: string
  dns: string
  broadcast: string
  leaseTimeSeconds: number
  includeHostname?: boolean
}

/** สร้าง reply packet แบบ pure (ใช้ทั้ง server และ test) */
export function buildDhcpReply(input: BuildDhcpReplyInput): Buffer {
  const { request } = input
  const header = Buffer.alloc(240)
  header.writeUInt8(2, 0) // BOOTREPLY
  header.writeUInt8(request.htype, 1)
  header.writeUInt8(request.hlen, 2)
  header.writeUInt8(0, 3)
  header.writeUInt32BE(request.xid, 4)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(request.flags, 10)
  const ciaddr = input.type === 'ack' && request.ciaddr !== '0.0.0.0' ? request.ciaddr : '0.0.0.0'
  ipv4Buffer(ciaddr).copy(header, 12)
  ipv4Buffer(input.type === 'nak' ? '0.0.0.0' : input.yiaddr).copy(header, 16)
  ipv4Buffer(input.serverIp).copy(header, 20)
  ipv4Buffer(request.giaddr).copy(header, 24)
  request.chaddrField.copy(header, 28, 0, 16)
  header.writeUInt32BE(DHCP_MAGIC_COOKIE, 236)

  const options: Buffer[] = []
  const push = (code: number, data: Buffer): void => {
    options.push(Buffer.from([code, data.length]), data)
  }
  const messageType =
    input.type === 'offer'
      ? DHCP_MESSAGE_TYPE.offer
      : input.type === 'ack'
        ? DHCP_MESSAGE_TYPE.ack
        : DHCP_MESSAGE_TYPE.nak
  push(DHCP_OPTION.messageType, Buffer.from([messageType]))
  push(DHCP_OPTION.serverIdentifier, ipv4Buffer(input.serverIp))

  if (input.type !== 'nak') {
    const lease = Buffer.allocUnsafe(4)
    lease.writeUInt32BE(input.leaseTimeSeconds >>> 0, 0)
    push(DHCP_OPTION.leaseTime, lease)
    push(DHCP_OPTION.subnetMask, ipv4Buffer(input.subnetMask))
    push(DHCP_OPTION.router, ipv4Buffer(input.router))
    push(DHCP_OPTION.dns, ipv4Buffer(input.dns))
    push(DHCP_OPTION.broadcast, ipv4Buffer(input.broadcast))
    if (input.includeHostname && request.hostname) {
      push(DHCP_OPTION.hostname, Buffer.from(request.hostname.slice(0, 120), 'utf8'))
    }
  }
  options.push(Buffer.from([255]))
  return Buffer.concat([header, ...options])
}

/**
 * DHCPv4 server — in-memory lease table (MAC → IP)
 *
 * ความปลอดภัย: โหมดนี้ไม่ได้ทำ NAT/forwarding เอง
 * การตัดเน็ตเกิดจากเครื่องแม่ "ไม่ forward" + posture ที่ปิด forwarding
 */
export class DhcpServer {
  private socket: dgram.Socket | null = null
  private cleanupTimer: NodeJS.Timeout | null = null
  private readonly leases = new Map<string, LeaseRecord>()
  private readonly now: () => number
  private readonly serverIp: string
  private readonly serverMac: string
  private readonly serverIdentifier: string
  private readonly cidr
  private readonly networkInt: number
  private readonly broadcastInt: number
  private readonly poolStartInt: number
  private readonly poolEndInt: number
  private readonly port: number
  private readonly clientPort: number
  private readonly bindAddress: string
  private readonly broadcastAddress: string

  constructor(private readonly config: DhcpServerConfig) {
    this.now = config.now ?? Date.now
    this.serverIp = config.hostIp
    this.serverMac = normalizeMac(config.serverMac ?? '')
    this.serverIdentifier = config.serverIdentifier ?? config.hostIp
    const cidr = parseCidr(config.subnetCidr)
    if (!cidr) throw new Error('DHCP_INVALID_SUBNET')
    if (!isIpv4(config.hostIp)) throw new Error('DHCP_INVALID_HOST_IP')
    if (!isIpv4(config.poolStart) || !isIpv4(config.poolEnd)) throw new Error('DHCP_INVALID_POOL')
    if (!cidrUtilsContains(cidr.network, cidr.broadcast, config.poolStart)) throw new Error('DHCP_POOL_OUTSIDE_SUBNET')
    if (!cidrUtilsContains(cidr.network, cidr.broadcast, config.poolEnd)) throw new Error('DHCP_POOL_OUTSIDE_SUBNET')
    if (!cidrUtilsContains(cidr.network, cidr.broadcast, config.hostIp)) throw new Error('DHCP_HOST_OUTSIDE_SUBNET')
    this.poolStartInt = ipv4ToInt(config.poolStart)
    this.poolEndInt = ipv4ToInt(config.poolEnd)
    if (this.poolStartInt > this.poolEndInt) throw new Error('DHCP_POOL_RANGE_INVALID')
    this.cidr = cidr
    this.networkInt = ipv4ToInt(cidr.network)
    this.broadcastInt = ipv4ToInt(cidr.broadcast)
    if (
      this.poolStartInt <= this.networkInt ||
      this.poolEndInt >= this.broadcastInt
    ) {
      throw new Error('DHCP_POOL_MUST_EXCLUDE_NETWORK_AND_BROADCAST')
    }
    this.port = config.port ?? GATEWAY_DHCP_PORT
    this.clientPort = config.clientPort ?? 68
    this.bindAddress = config.bindAddress ?? '0.0.0.0'
    this.broadcastAddress = config.broadcastAddress ?? cidr.broadcast
  }

  /** bind UDP 67 — reject พร้อมข้อความชัดเจนเมื่อไม่มีสิทธิ์/พอร์ตถูกใช้ */
  start(): Promise<void> {
    if (this.socket) return Promise.resolve()
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    return new Promise<void>((resolve, reject) => {
      const onBindError = (error: Error): void => {
        this.socket = null
        try {
          socket.close()
        } catch {
          // ปิดไปแล้ว
        }
        reject(
          new Error(
            `DHCP_BIND_FAILED: ${error.message} (ต้องรันเครื่องแม่แบบ Administrator/root และพอร์ต UDP ${this.port} ต้องว่าง)`
          )
        )
      }
      socket.once('error', onBindError)
      socket.bind({ port: this.port, address: this.bindAddress }, () => {
        socket.removeListener('error', onBindError)
        socket.on('error', (error) => this.config.onError?.(error))
        try {
          socket.setBroadcast(true)
        } catch {
          // บาง OS ไม่อนุญาต — การตอบ unicast ยังทำงาน
        }
        this.cleanupTimer = setInterval(() => {
          this.cleanupExpired()
        }, 30_000)
        this.cleanupTimer.unref?.()
        resolve()
      })
      socket.on('message', (message, rinfo) => this.handleMessage(message, rinfo))
    })
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = null
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        // ปิดไปแล้ว
      }
    }
    this.socket = null
    this.leases.clear()
  }

  getLeases(): GatewayLease[] {
    this.cleanupExpired(false)
    return [...this.leases.values()]
      .map((lease) => ({
        mac: lease.mac,
        ip: lease.ip,
        hostname: lease.hostname,
        startedAtMs: lease.startedAtMs,
        expiresAtMs: lease.expiresAtMs
      }))
      .sort((a, b) => ipv4ToInt(a.ip) - ipv4ToInt(b.ip))
  }

  get leaseCount(): number {
    return this.leases.size
  }

  /* ---------- internals ---------- */

  private handleMessage(message: Buffer, _rinfo: dgram.RemoteInfo): void {
    const packet = parseDhcpPacket(message)
    if (!packet) return // malformed — เพิกเฉย
    if (packet.op !== 1) return // รับเฉพาะ BOOTREQUEST
    if (packet.giaddr !== '0.0.0.0') return // ไม่รับ relayed request (คนละ L2)
    if (this.serverMac && packet.mac === this.serverMac) return // packet ของตัวเอง
    if (!packet.mac) return

    switch (packet.messageType) {
      case DHCP_MESSAGE_TYPE.discover:
        this.handleDiscover(packet)
        return
      case DHCP_MESSAGE_TYPE.request:
        this.handleRequest(packet)
        return
      case DHCP_MESSAGE_TYPE.release:
        this.handleRelease(packet)
        return
      case DHCP_MESSAGE_TYPE.decline:
        this.leases.delete(packet.mac)
        this.notifyLeases()
        return
      default:
        return
    }
  }

  private handleDiscover(packet: ParsedDhcpPacket): void {
    const lease = this.allocateLease(packet.mac, packet.requestedIp, packet.hostname)
    if (!lease) return // pool หมด — ไม่ตอบ (client จะลองใหม่)
    this.sendReply('offer', packet, lease)
  }

  private handleRequest(packet: ParsedDhcpPacket): void {
    const serverId = packet.serverIdentifier
    // SELECTING: client เลือก server อื่น — ไม่ใช่หน้าที่เราจะตอบ
    if (serverId !== null && serverId !== this.serverIdentifier) return

    const requestedIp = packet.requestedIp ?? (packet.ciaddr !== '0.0.0.0' ? packet.ciaddr : null)
    const existing = this.activeLeaseFor(packet.mac)

    if (existing) {
      if (requestedIp !== null && requestedIp !== existing.ip) {
        // มี binding อยู่แล้วแต่ขอ IP อื่น — ถ้า IP นั้นว่างอาจย้ายให้ แต่เพื่อความชัดเจนตอบ NAK
        this.sendReply('nak', packet, existing)
        return
      }
      existing.hostname = packet.hostname ?? existing.hostname
      existing.expiresAtMs = this.now() + this.config.leaseTimeSeconds * 1000
      this.notifyLeases()
      this.sendReply('ack', packet, existing)
      return
    }

    if (requestedIp !== null) {
      if (!this.isAssignable(requestedIp) || this.ipInUse(requestedIp)) {
        this.sendReply('nak', packet, null)
        return
      }
      const lease = this.createLease(packet.mac, requestedIp, packet.hostname)
      this.sendReply('ack', packet, lease)
      return
    }

    const lease = this.allocateLease(packet.mac, null, packet.hostname)
    if (!lease) {
      this.sendReply('nak', packet, null)
      return
    }
    this.sendReply('ack', packet, lease)
  }

  private handleRelease(packet: ParsedDhcpPacket): void {
    const lease = this.leases.get(packet.mac)
    if (!lease) return
    if (packet.ciaddr !== '0.0.0.0' && packet.ciaddr !== lease.ip) return
    this.leases.delete(packet.mac)
    this.notifyLeases()
  }

  private allocateLease(mac: string, requestedIp: string | null, hostname: string | null): LeaseRecord | null {
    const existing = this.activeLeaseFor(mac)
    if (existing) {
      existing.hostname = hostname ?? existing.hostname
      existing.expiresAtMs = this.now() + this.config.leaseTimeSeconds * 1000
      this.notifyLeases()
      return existing
    }
    if (requestedIp !== null && this.isAssignable(requestedIp) && !this.ipInUse(requestedIp)) {
      return this.createLease(mac, requestedIp, hostname)
    }
    const ip = this.findFreeIp()
    if (!ip) return null
    return this.createLease(mac, ip, hostname)
  }

  private findFreeIp(): string | null {
    for (let value = this.poolStartInt; value <= this.poolEndInt; value += 1) {
      const ip = intToIpv4(value)
      if (!this.isAssignable(ip)) continue
      if (this.ipInUse(ip)) continue
      return ip
    }
    return null
  }

  private isAssignable(ip: string): boolean {
    if (!isIpv4(ip)) return false
    const value = ipv4ToInt(ip)
    if (value < this.poolStartInt || value > this.poolEndInt) return false
    if (value <= this.networkInt || value >= this.broadcastInt) return false
    if (ip === this.serverIp) return false // host IP ต้องไม่ถูกแจก
    if (ip === this.cidr.network || ip === this.cidr.broadcast) return false
    return true
  }

  private ipInUse(ip: string): boolean {
    for (const lease of this.leases.values()) {
      if (lease.ip === ip && lease.expiresAtMs > this.now()) return true
    }
    return false
  }

  private activeLeaseFor(mac: string): LeaseRecord | null {
    const lease = this.leases.get(mac)
    if (!lease) return null
    if (lease.expiresAtMs <= this.now()) {
      this.leases.delete(mac)
      return null
    }
    return lease
  }

  private createLease(mac: string, ip: string, hostname: string | null): LeaseRecord {
    const now = this.now()
    const lease: LeaseRecord = {
      mac,
      ip,
      hostname: hostname ?? null,
      startedAtMs: now,
      expiresAtMs: now + this.config.leaseTimeSeconds * 1000
    }
    this.leases.set(mac, lease)
    this.notifyLeases()
    return lease
  }

  private sendReply(type: DhcpReplyType, packet: ParsedDhcpPacket, lease: LeaseRecord | null): void {
    const socket = this.socket
    if (!socket) return
    const reply = buildDhcpReply({
      request: packet,
      type,
      serverIp: this.serverIdentifier,
      yiaddr: lease?.ip ?? '0.0.0.0',
      subnetMask: this.cidr.netmask,
      router: this.serverIp,
      dns: this.serverIp,
      broadcast: this.cidr.broadcast,
      leaseTimeSeconds: this.config.leaseTimeSeconds,
      includeHostname: true
    })
    const broadcastFlag = (packet.flags & BROADCAST_FLAG) !== 0
    const shouldBroadcast =
      type !== 'ack' || broadcastFlag || packet.ciaddr === '0.0.0.0'
    const destination = shouldBroadcast ? this.broadcastAddress : (lease?.ip ?? this.broadcastAddress)
    socket.send(reply, this.clientPort, destination, (error) => {
      if (error) this.config.onError?.(error)
    })
  }

  private cleanupExpired(notify = true): void {
    const now = this.now()
    let changed = false
    for (const [mac, lease] of this.leases) {
      if (lease.expiresAtMs <= now) {
        this.leases.delete(mac)
        changed = true
      }
    }
    if (changed && notify) this.notifyLeases()
  }

  private notifyLeases(): void {
    this.config.onLeasesChanged?.(this.getLeases())
  }
}

function cidrUtilsContains(network: string, broadcast: string, ip: string): boolean {
  if (!isIpv4(ip)) return false
  const value = ipv4ToInt(ip)
  return value >= ipv4ToInt(network) && value <= ipv4ToInt(broadcast)
}

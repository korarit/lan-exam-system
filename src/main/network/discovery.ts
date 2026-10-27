import { EventEmitter } from 'node:events'
import dgram from 'node:dgram'
import os from 'node:os'
import { UdpBeaconSchema, type DiscoveredRoom, type UdpBeacon } from '@shared/protocol-schema'

export const DISCOVERY_PORT = 44455
export const BEACON_INTERVAL_MS = 2000
export const ROOM_STALE_MS = 7000

/* ============================================================
 * Host: UDP Room Broadcaster
 * ============================================================ */

export interface RoomBroadcasterOptions {
  beacon: UdpBeacon
  intervalMs?: number
  /** override ที่อยู่ปลายทาง (ใช้ตอนทดสอบ): '255.255.255.255' หรือ { address, port } */
  destinations?: Array<string | { address: string; port: number }>
}

/** คำนวณ broadcast address ของทุก IPv4 LAN interface บนเครื่องนี้ */
export function getLanBroadcastAddresses(): string[] {
  const results = new Set<string>(['255.255.255.255', '127.0.0.1'])
  const interfaces = os.networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const ip = ipv4ToLong(entry.address)
      const mask = ipv4ToLong(entry.netmask)
      const broadcast = longToIpv4((ip | ~mask) >>> 0)
      if (broadcast) results.add(broadcast)
    }
  }
  return [...results]
}

function ipv4ToLong(address: string): number {
  const parts = address.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4) return 0
  // eslint-disable-next-line no-bitwise
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

function longToIpv4(value: number): string {
  if (!Number.isFinite(value)) return ''
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ].join('.')
}

export class RoomBroadcaster {
  private socket: dgram.Socket | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly options: RoomBroadcasterOptions) {}

  start(): void {
    if (this.socket) return
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.bind(() => {
      try {
        socket.setBroadcast(true)
      } catch {
        // บางระบบไม่จำเป็นต้อง setBroadcast หลัง bind (loopback destination ใช้ได้เสมอ)
      }
      this.socket = socket
      this.timer = setInterval(() => this.broadcastOnce(), this.options.intervalMs ?? BEACON_INTERVAL_MS)
      this.broadcastOnce()
    })
    socket.on('error', () => {
      // ห้องแล็บบางแห่งบล็อก broadcast — host ยังรับ TCP ตรงได้อยู่
    })
  }

  /** อัปเดตตัวเลขใน beacon เช่น studentCount / examStatus ก่อนรอบส่งถัดไป */
  updateBeacon(patch: Partial<UdpBeacon>): void {
    Object.assign(this.options.beacon, patch)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.socket?.close()
    this.socket = null
  }

  private broadcastOnce(): void {
    const socket = this.socket
    if (!socket) return
    const payload = Buffer.from(JSON.stringify(this.options.beacon), 'utf8')
    if (payload.length > 512) return // beacon ต้องเล็กเสมอ
    const destinations =
      this.options.destinations ?? getLanBroadcastAddresses().map((addr) => ({ address: addr, port: DISCOVERY_PORT }))
    for (const dest of destinations) {
      const { address, port } = typeof dest === 'string' ? { address: dest, port: DISCOVERY_PORT } : dest
      socket.send(payload, port, address)
    }
  }
}

/* ============================================================
 * Client: UDP Discovery Listener
 * ============================================================ */

export class RoomDiscoveryListener extends EventEmitter {
  private socket: dgram.Socket | null = null
  private rooms = new Map<string, DiscoveredRoom>()
  private pruneTimer: NodeJS.Timeout | null = null

  /** ห้องที่เห็น ณ ตอนนี้ (เรียงตามเวลาที่ล่าสุดเห็น) */
  getRooms(): DiscoveredRoom[] {
    return [...this.rooms.values()].sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs)
  }

  start(): void {
    if (this.socket) return
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo))
    socket.on('error', () => {
      // บางเครือข่ายอนุญาตเฉพาะ unicast — ใช้ Manual IP แทนได้
    })
    socket.bind(DISCOVERY_PORT, () => {
      this.socket = socket
      try {
        socket.setBroadcast(true)
      } catch {
        // ไม่จำเป็นต้อง broadcast ฝั่ง listener
      }
    })
    this.pruneTimer = setInterval(() => this.pruneStaleRooms(), 1000)
  }

  stop(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.pruneTimer = null
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        // already closed
      }
    }
    this.socket = null
    this.rooms.clear()
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(msg.toString('utf8'))
    } catch {
      return // ไม่ใช่ beacon ของเรา — เพิกเฉย
    }
    const result = UdpBeaconSchema.safeParse(parsed)
    if (!result.success) return // beacon ปลอม/เก่า — เพิกเฉยเงียบ ๆ (การยืนยันจริงอยู่ที่ PIN handshake)
    const beacon = result.data
    const room: DiscoveredRoom = {
      ...beacon,
      sourceIp: rinfo.address,
      lastSeenAtMs: Date.now()
    }
    this.rooms.set(beacon.roomId, room)
    this.emit('rooms-changed', this.getRooms())
  }

  private pruneStaleRooms(): void {
    const now = Date.now()
    let changed = false
    for (const [roomId, room] of this.rooms) {
      if (now - room.lastSeenAtMs > ROOM_STALE_MS) {
        this.rooms.delete(roomId)
        changed = true
      }
    }
    if (changed) this.emit('rooms-changed', this.getRooms())
  }
}

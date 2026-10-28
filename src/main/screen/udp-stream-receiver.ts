import dgram from 'node:dgram'
import {
  UDP_SCREEN_HEADER_SIZE,
  UdpPacketType,
  decodeUdpSegmentAtom,
  normalizeUdpPeerIp,
  type UdpSegmentAtomHeader,
  type UdpNackEntry
} from '@shared/udp-screen-protocol'
import {
  decodeUdpScreenPacket,
  encodeUdpScreenPacket,
  type ScreenUdpKeys
} from './udp-crypto'

/* ============================================================
 * Phase 3c (UDP upgrade): UdpStreamReceiver (ฝั่งเครื่องแม่)
 * - bind พอร์ต UDP คงที่ต่อแอปเครื่องแม่ → แจ้งโดย SCREEN_SESSION
 * - registerChannel(): จับคู่ channelId ↔ studentId (ยืนยัน IP ให้ตรงกับ TLS ผู้ที่ลงทะเบียน)
 * - ส่งแต่ละ datagram: รวม chunk กลับเป็น atom เซกเมนต์ → callback ตาม origin (live/fetch)
 * - NACK: ขอส่งซ้ำชิ้นที่หายทุก 150ms; atom ค้าง > 3s → drop + แจ้ง onSegmentFailed
 * ============================================================ */

export interface UdpStreamReceiverOptions {
  /** atom ครบแล้ว — ปกติเป็น .webm เซกเมนต์ */
  onSegment: (channelIdHex: string, header: UdpSegmentAtomHeader, webm: Uint8Array) => void
  /** atom หายถาวร (เกิน 3 วินาทีไม่ครบ) — ฝั่ง fetch ใช้ re-fetch ผ่าน TCP แทน */
  onSegmentFailed: (channelIdHex: string, header: UdpSegmentAtomHeader | null, atomSeq: number) => void
  onAnomaly?: (ip: string, reason: string) => void
}

interface ReceiverChannel {
  studentIp: string
  /** พอร์ตด้านผู้ส่ง (จาก datagram ล่าสุด) ที่ใช้ส่ง NACK กลับ */
  studentPort: number | null
  keys: ScreenUdpKeys
  atoms: Map<number, PendingAtom>
}

interface PendingAtom {
  chunkCount: number
  received: Uint8Array[]
  receivedCount: number
  firstAtMs: number
  header: UdpSegmentAtomHeader | null
}

const NACK_INTERVAL_MS = 150
/** atom หายถาวรถ้าไม่ครบภายในนี้ */
const ATOM_TIMEOUT_MS = 3_000
const UDP_MIN_HEADER = UDP_SCREEN_HEADER_SIZE

export class UdpStreamReceiver {
  private socket: dgram.Socket | null = null
  private readonly channels = new Map<string, ReceiverChannel>()
  private boundPort: number | null = null
  private nackTimer: NodeJS.Timeout | null = null
  private outboundSeq = 0

  constructor(private readonly opts: UdpStreamReceiverOptions) {}

  /** bind พอร์ตสุ่ม (0) ให้เรียบร้อย — คืนพอร์ต หรือ null ถ้า bind ไม่ได้ */
  async start(): Promise<number | null> {
    if (this.socket) return this.boundPort
    try {
      const socket = dgram.createSocket('udp4')
      this.socket = socket
      socket.on('message', (message, rinfo) => this.handleDatagram(message, rinfo))
      socket.on('error', (err) => {
        this.opts.onAnomaly?.('self', `UDP_RECEIVER_ERROR: ${err.message}`)
      })
      const port = await new Promise<number>((resolve, reject) => {
        socket.once('error', (err) => reject(err))
        socket.bind(0, () => {
          const address = socket.address()
          resolve(typeof address === 'string' ? 0 : address.port)
        })
      })
      this.boundPort = port
      this.nackTimer = setInterval(() => this.sweepIntegrity(), NACK_INTERVAL_MS)
      return port
    } catch (err) {
      this.opts.onAnomaly?.('self', `UDP_RECEIVER_BIND_FAILED: ${err instanceof Error ? err.message : 'unknown'}`)
      try {
        this.socket?.close()
      } catch {
        // ปิดไปเอง
      }
      this.socket = null
      this.boundPort = null
      return null
    }
  }

  getPort(): number | null {
    return this.boundPort
  }

  /**
   * จับคู่ channel ตาม channelId —(packet ของนักเรียนฝั่งนี้จะถูกถอดรหัสด้วยการจับคู่นี้)
   * คืน false เมื่อ channelId มีคนใช้อยู่แล้ว (กันการแอบรับข้อมูลข้ามเครื่อง)
   */
  registerChannel(channelIdHex: string, studentIp: string, keys: ScreenUdpKeys): boolean {
    const normalized = normalizeUdpPeerIp(studentIp)
    const existing = this.channels.get(channelIdHex)
    if (existing && existing.studentIp !== normalized) return false
    this.channels.set(channelIdHex, { studentIp: normalized, studentPort: null, keys, atoms: new Map() })
    return true
  }

  /** ปลด channel ทั้งหมด (ปิดห้อง / เริ่มเซสชันผ่าน ใหม่) */
  unregisterAll(): void {
    this.channels.clear()
  }

  stop(): void {
    if (this.nackTimer) clearInterval(this.nackTimer)
    this.nackTimer = null
    this.unregisterAll()
    try {
      this.socket?.close()
    } catch {
      // ปิดไปเอง
    }
    this.socket = null
    this.boundPort = null
  }

  private handleDatagram(message: Buffer, rinfo: dgram.RemoteInfo): void {
    // อ่าน channelId แบบดิบ (byte 5..13) เพื่อจับคู่ channel + กุญแจก่อนถอดรหัส
    if (message.length < UDP_MIN_HEADER) return
    const channelIdHex = message.subarray(5, 13).toString('hex')
    const channel = this.channels.get(channelIdHex)
    if (!channel) {
      this.opts.onAnomaly?.(rinfo.address, 'UDP_UNKNOWN_CHANNEL')
      return
    }
    const peerIp = normalizeUdpPeerIp(rinfo.address)
    if (peerIp !== channel.studentIp) {
      this.opts.onAnomaly?.(rinfo.address, 'UDP_SOURCE_IP_MISMATCH')
      return
    }
    channel.studentPort = rinfo.port
    const frame = decodeUdpScreenPacket(message, channel.keys.studentToHost)
    if (!frame) {
      this.opts.onAnomaly?.(rinfo.address, 'UDP_PACKET_AUTH_FAILED')
      return
    }
    if (frame.kind !== 'data') return
    this.ingestData(channel, channelIdHex, frame.atomSeq, frame.chunkIndex, frame.chunkCount, frame.chunk)
  }

  private ingestData(
    channel: ReceiverChannel,
    channelIdHex: string,
    atomSeq: number,
    chunkIndex: number,
    chunkCount: number,
    chunk: Uint8Array
  ): void {
    if (chunkIndex >= chunkCount) return
    let atom = channel.atoms.get(atomSeq)
    if (!atom) {
      atom = {
        chunkCount,
        received: new Array(chunkCount),
        receivedCount: 0,
        firstAtMs: Date.now(),
        header: null
      }
      channel.atoms.set(atomSeq, atom)
    }
    if (atom.chunkCount !== chunkCount || atom.received[chunkIndex]) return
    atom.received[chunkIndex] = chunk
    atom.receivedCount += 1
    if (chunkIndex === 0) this.tryParseAtomHeader(atom, chunk)
    if (atom.receivedCount === atom.chunkCount) {
      this.assembleAndDeliver(channelIdHex, atomSeq, atom)
      channel.atoms.delete(atomSeq)
    }
  }

  /** พยายามอ่าน header ของ atom (สองไบต์ความยาว BE + JSON) จาก chunk แรก — ใช้จัดกลุ่มตอน atom หาย */
  private tryParseAtomHeader(atom: PendingAtom, firstChunk: Uint8Array): void {
    if (firstChunk.length < 2) return
    const view = Buffer.from(firstChunk.buffer, firstChunk.byteOffset, Math.min(firstChunk.length, 2048))
    const headerLen = view.readUInt16BE(0)
    if (headerLen > view.length - 2) return // header ยาวเกิน chunk แรก — แจ้ง null ตอน atom หาย
    try {
      const header = JSON.parse(view.subarray(2, 2 + headerLen).toString('utf8')) as UdpSegmentAtomHeader
      if ((header.origin !== 'live' && header.origin !== 'fetch') || typeof header.segmentId !== 'string') return
      atom.header = header
    } catch {
      // header ชำรุด — ปล่อยให้ onSegmentFailed แจ้ง null
    }
  }

  private assembleAndDeliver(channelIdHex: string, atomSeq: number, atom: PendingAtom): void {
    const total = atom.received.reduce((sum, part) => sum + (part?.length ?? 0), 0)
    const assembled = new Uint8Array(total)
    let offset = 0
    for (const part of atom.received) {
      if (!part) continue
      assembled.set(part, offset)
      offset += part.length
    }
    const decoded = decodeUdpSegmentAtom(assembled)
    if (!decoded || (decoded.header.origin !== 'live' && decoded.header.origin !== 'fetch')) {
      this.opts.onSegmentFailed(channelIdHex, null, atomSeq)
      return
    }
    this.opts.onSegment(channelIdHex, decoded.header, decoded.webm)
  }

  /** รอบ NACK + GC: ขอส่งซ้ำชิ้นที่หาย, โยน atom ที่หายถาวรทิ้ง */
  private sweepIntegrity(): void {
    const now = Date.now()
    for (const [channelIdHex, channel] of this.channels) {
      const missingEntries: UdpNackEntry[] = []
      for (const [atomSeq, atom] of channel.atoms) {
        const elapsed = now - atom.firstAtMs
        if (elapsed > ATOM_TIMEOUT_MS) {
          channel.atoms.delete(atomSeq)
          this.opts.onSegmentFailed(channelIdHex, atom.header, atomSeq)
          continue
        }
        if (elapsed < NACK_INTERVAL_MS) continue
        const missing: number[] = []
        for (let index = 0; index < atom.chunkCount; index += 1) {
          if (!atom.received[index]) missing.push(index)
        }
        if (missing.length > 0) {
          missingEntries.push({ atomSeq, missing })
          if (missingEntries.length >= 16) break
        }
      }
      if (missingEntries.length > 0) {
        this.sendNack(channel, channelIdHex, missingEntries)
      }
    }
  }

  private sendNack(channel: ReceiverChannel, channelIdHex: string, entries: UdpNackEntry[]): void {
    const socket = this.socket
    if (!socket || channel.studentPort === null) return
    try {
      const packet = encodeUdpScreenPacket({
        channelIdHex,
        epoch: 1,
        seq: (this.outboundSeq = (this.outboundSeq + 1) >>> 0),
        key: channel.keys.hostToStudent,
        data: { type: UdpPacketType.nack, entries }
      })
      socket.send(packet, channel.studentPort, channel.studentIp)
    } catch {
      // ข้อผิดพลาดการสร้างแพ็กเกต — ข้ามรอบนี้
    }
  }
}

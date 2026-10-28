import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import {
  UDP_SCREEN_CHUNK_SIZE,
  UdpAtomType,
  UdpPacketType,
  encodeUdpSegmentAtom,
  type UdpSegmentAtomHeader
} from '@shared/udp-screen-protocol'
import {
  decodeUdpScreenPacket,
  encodeUdpScreenPacket,
  type ScreenUdpKeys
} from './udp-crypto'

/* ============================================================
 * Phase 3c (UDP upgrade): UdpStreamSender (ฝั่งเครื่องนักเรียน)
 * - ผูกพอร์ต UDP ตัวเอง → ประกาศ SCREEN_UDP_REGISTER ผ่านท่อ TLS
 * - sendSegmentAtom(): ตัด atom (header + .webm) เป็น chunk แล้วส่งแบบตั้งจังหวะ (pacing)
 * - รับ NACK จากเครื่องแม่ → ส่ง chunk ซ้ำเฉพาะชิ้นที่หาย (ยังอยู่ในหน้าต่างใหม่ล่าสุด)
 * - หน้าต่างที่เก็บไว้ต่อ channelId ใหม่สุด N atom เท่านั้น (เก่ากว่านั้นไม่ส่งซ้ำ)
 * ============================================================ */

export interface UdpStreamSenderOptions {
  onStatus?: (message: string) => void
}

interface AtomEntry {
  atomSeq: number
  chunkCount: number
  sentAtMs: number
  packets: Map<number, Buffer>
}

/** จำนวน atom ใหม่ล่าสุดที่เก็บไว้รอ resends */
const WINDOW_ATOMS = 16
/** จังหวะส่ง (ms) + จำนวน datagram ต่อจังหวะ → ~1,250 datagrams/s ≈ 1.4 MB/s */
const PACE_INTERVAL_MS = 4
const PACE_BATCH = 5

export class UdpStreamSender {
  private socket: dgram.Socket | null = null
  private readonly hostAddress: string
  private readonly hostPort: number
  private readonly keys: ScreenUdpKeys
  readonly channelIdHex: string
  private epoch = 1
  private outboundSeq = 0
  private atomSeq = 0
  private readonly atoms = new Map<number, AtomEntry>()
  private queue: Buffer[] = []
  private pacer: NodeJS.Timeout | null = null

  constructor(
    options: { hostAddress: string; hostPort: number; keys: ScreenUdpKeys },
    private readonly opts: UdpStreamSenderOptions = {}
  ) {
    this.hostAddress = options.hostAddress
    this.hostPort = options.hostPort
    this.keys = options.keys
    this.channelIdHex = randomBytes(8).toString('hex')
  }

  /** เปิดฟังคำตอบ (NACK) และประกาศ แล้วสตาร์ต pacing */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4')
      this.socket = socket
      socket.on('message', (message) => this.handleHostDatagram(message))
      socket.on('error', (err) => {
        this.opts.onStatus?.(`UDP_SENDER_ERROR: ${err.message}`)
        reject(err)
      })
      socket.bind(0, () => {
        const address = socket.address()
        if (address && typeof address !== 'string') {
          this.pacer = setInterval(() => this.transmitPace(), PACE_INTERVAL_MS)
          resolve(address.port)
        } else {
          reject(new Error('UDP_SENDER_BIND_FAILED'))
        }
      })
    })
  }

  get port(): number | null {
    const address = this.socket?.address()
    return address && typeof address !== 'string' ? address.port : null
  }

  /** หยุดและล้างของ (จบเซสชัน / จบสอบ) */
  close(): void {
    if (this.pacer) clearInterval(this.pacer)
    this.pacer = null
    try {
      this.socket?.close()
    } catch {
      // ปิดไปเอง
    }
    this.socket = null
    this.queue = []
    this.atoms.clear()
  }

  /**
   * ส่ง atom เซกเมนต์ (.webm) หนึ่งชิ้น — ตัดชิ้นแล้วจัดลำดับรอส่งตามช่วงเวลา
   * คืน atomSeq หรือ null ถ้ายังส่งไม่ได้ (ยังไม่ start)
   */
  sendSegmentAtom(
    header: UdpSegmentAtomHeader,
    webm: Uint8Array,
    atomType: number = UdpAtomType.segment
  ): number | null {
    if (!this.socket) return null
    const atom = encodeUdpSegmentAtom(header, webm)
    const chunkCount = Math.max(1, Math.ceil(atom.length / UDP_SCREEN_CHUNK_SIZE))
    const chunks = new Array<Buffer>(chunkCount)
    for (let index = 0; index < chunkCount; index += 1) {
      chunks[index] = Buffer.from(atom.subarray(index * UDP_SCREEN_CHUNK_SIZE, Math.min(atom.length, (index + 1) * UDP_SCREEN_CHUNK_SIZE)))
    }
    const atomSeq = this.atomSeq
    this.atomSeq = (this.atomSeq + 1) >>> 0
    const entry: AtomEntry = { atomSeq, chunkCount, sentAtMs: Date.now(), packets: new Map() }
    this.atoms.set(atomSeq, entry)
    // ระเบียบหน้าต่างการ resends: เก็บอันใหม่ล่าสุด WINDOW_ATOMS ตัวเท่านั้น
    while (this.atoms.size > WINDOW_ATOMS) {
      const oldest = Math.min(...this.atoms.keys())
      this.atoms.delete(oldest)
    }
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = chunks[index]!
      const packet = encodeUdpScreenPacket({
        channelIdHex: this.channelIdHex,
        epoch: this.epoch,
        seq: this.nextSeq(),
        key: this.keys.studentToHost,
        data: {
          type: UdpPacketType.data,
          atomType,
          atomSeq,
          chunkIndex: index,
          chunkCount,
          chunk
        }
      })
      entry.packets.set(index, packet)
      this.queue.push(packet)
    }
    return atomSeq
  }

  /** ตั้งจังหวะส่ง — เรียกใน setInterval (ส่งเป็นกลุ่มเล็กต่อวรรค) */
  private transmitPace(): void {
    const socket = this.socket
    if (!socket) return
    for (let i = 0; i < PACE_BATCH && this.queue.length > 0; i += 1) {
      const packet = this.queue.shift()
      if (!packet) continue
      socket.send(packet, this.hostPort, this.hostAddress, (err) => {
        if (err) this.opts.onStatus?.(`UDP_SEND_FAILED: ${err.message}`)
      })
    }
  }

  private handleHostDatagram(datagram: Buffer): void {
    const frame = decodeUdpScreenPacket(datagram, this.keys.hostToStudent)
    if (!frame || frame.kind !== 'nack') return
    for (const { atomSeq, missing } of frame.entries) {
      const entry = this.atoms.get(atomSeq)
      if (!entry) continue
      for (const chunkIndex of missing) {
        const packet = entry.packets.get(chunkIndex)
        if (packet) this.queue.push(packet)
      }
    }
  }

  private nextSeq(): number {
    this.outboundSeq = (this.outboundSeq + 1) >>> 0
    return this.outboundSeq
  }
}

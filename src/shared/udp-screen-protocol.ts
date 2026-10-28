/* ============================================================
 * Phase 3c (UDP upgrade): โปรโตคอลสตรีมหน้าจอผ่าน Raw UDP (shared, node-free)
 * - รูปแบบแพ็กเกต: [magic4][type1][channelId8][epoch2][seq4][iv12]
 *   ตามด้วยช่องสีหน้า (ค้นเสียงเป็น AES-256-GCM พร้อม AAD=header, ชั้น crypto อยู่ที่ main/screen/udp-crypto.ts)
 * - เฟรมใหญ่ (ไฟล์ .webm เซกเมนต์) = atom — หนึ่ง atom ตัดเป็น chunk หลายชิ้น (MTU-safe)
 * - จับคู่ผู้ส่งด้วย channelId 8 bytes สุ่มต่อนักเรียนต่อเซสชัน
 *   (ผูกกันผ่าน SCREEN_UDP_REGISTER บนท่อ TLS, กุญแจ HKDF ของ screenBufferKey)
 * - เขียนด้วย Uint8Array/DataView ล้วน ใช้ร่วมกันทั้ง main/preload/renderer
 * ============================================================ */

/** Header: magic4 + type1 + channelId8 + epoch2 + seq4 + iv12 = 31 bytes */
export const UDP_SCREEN_MAGIC = new Uint8Array([0x5a, 0x53, 0x54, 0x01])
export const UDP_SCREEN_HEADER_SIZE = 31
export const UDP_SCREEN_GCM_TAG = 16
/** body ฝั่ง plaintext ของ DATA: atomType1 + atomSeq4 + chunkIndex2 + chunkCount2 */
export const UDP_SCREEN_DATA_HEADER = 9
/** MTU-safe: ขนาด datagram ใหญ่สุด (รวม header + GCM tag) */
export const UDP_SCREEN_MAX_PACKET = 1200
/** ขนาด chunk ปกติ (ชิ้นสุดท้ายของ atom อาจสั้นกว่า) */
export const UDP_SCREEN_CHUNK_SIZE = 1100

export const UdpPacketType = {
  /** เฟรมข้อมูล (ชิ้นของ atom) */
  data: 0x01 as const,
  /** ขอส่งชิ้นซ้ำ (NACK-based retransmit) */
  nack: 0x02 as const
}

export const UdpAtomType = {
  /** เนื้อหาไฟล์ .webm (live segment หรือ playback fetch) */
  segment: 0x01 as const
}

/* ---------- Header ของ atom เซกเมนต์ (JSON + bytes) ---------- */

export interface UdpSegmentAtomHeader {
  /** 'live' = สตรีมต่อเนื่องระหว่างเปิดดู, 'fetch' = ตอบคำสั่ง FETCH_RING_SEGMENT */
  origin: 'live' | 'fetch'
  /** requestId ของ SCREEN_INSPECT_REQUEST / FETCH_RING_SEGMENT ที่เกี่ยวข้อง */
  requestId?: string
  segmentId: string
  displayId: string
  mimeType: string
  seqNo: number
  startTimeMs: number
  endTimeMs: number
}

/* ---------- ชั้น atom ---------- */

export function encodeUdpSegmentAtom(header: UdpSegmentAtomHeader, webm: Uint8Array): Uint8Array {
  const utf8 = new TextEncoder()
  const body = utf8.encode(JSON.stringify(header))
  if (body.length > 0xffff) throw new Error('ATOM_HEADER_TOO_LARGE')
  const out = new Uint8Array(2 + body.length + webm.length)
  out[0] = (body.length >> 8) & 0xff
  out[1] = body.length & 0xff
  out.set(body, 2)
  out.set(webm, 2 + body.length)
  return out
}

export function decodeUdpSegmentAtom(atom: Uint8Array): { header: UdpSegmentAtomHeader; webm: Uint8Array } | null {
  if (atom.length < 2) return null
  const headerLen = ((atom[0] ?? 0) << 8) | (atom[1] ?? 0)
  if (atom.length < 2 + headerLen) return null
  const text = new TextDecoder().decode(atom.subarray(2, 2 + headerLen))
  try {
    const header = JSON.parse(text) as UdpSegmentAtomHeader
    if ((header.origin !== 'live' && header.origin !== 'fetch') || typeof header.segmentId !== 'string') return null
    return { header, webm: atom.subarray(2 + headerLen) }
  } catch {
    return null
  }
}

/* ---------- โครงสร้างเฟรมหลังถอดรหัส ---------- */

export interface UdpNackEntry {
  atomSeq: number
  /** รายการ chunkIndex ที่ยังไม่ได้รับ — ต้องขอส่งซ้ำ */
  missing: number[]
}

export interface UdpDataPacketFrame {
  kind: 'data'
  channelIdHex: string
  epoch: number
  seq: number
  atomType: number
  atomSeq: number
  chunkIndex: number
  chunkCount: number
  chunk: Uint8Array
}

export interface UdpNackPacketFrame {
  kind: 'nack'
  channelIdHex: string
  epoch: number
  seq: number
  entries: UdpNackEntry[]
}

export type UdpPacketFrame = UdpDataPacketFrame | UdpNackPacketFrame

/** ปรับรูปแบบ IP จาก TLS socket (IPv4-mapped IPv6) → ให้ตรงกับ dgram address */
export function normalizeUdpPeerIp(raw: string): string {
  const ip = raw.trim()
  if (ip.startsWith('::ffff:')) return ip.slice(7)
  if (ip === '::1') return '127.0.0.1'
  return ip
}

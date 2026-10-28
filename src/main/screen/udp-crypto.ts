import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import {
  UDP_SCREEN_DATA_HEADER,
  UDP_SCREEN_GCM_TAG,
  UDP_SCREEN_HEADER_SIZE,
  UDP_SCREEN_MAGIC,
  UDP_SCREEN_MAX_PACKET,
  UdpPacketType,
  decodeUdpSegmentAtom,
  type UdpDataPacketFrame,
  type UdpNackEntry,
  type UdpNackPacketFrame
} from '@shared/udp-screen-protocol'

export { decodeUdpSegmentAtom }

/* ============================================================
 * Phase 3c (UDP upgrade): ชั้นการเข้ารหัสของโปรโตคอล UDP (เฉพาะ Main process)
 * - แพ็กเกต header: [magic4][type1][channelId8][epoch2][seq4][iv12]
 * - body เข้ารหัส AES-256-GCM — AAD = header (แก้ header แล้วพังเหมือนกัน)
 * - กุญแจแยก 2 ขาจาก HKDF ของ screenBufferKey (c2s / s2c) กัน monkey ทางขาตรงข้าม
 * ============================================================ */

export interface ScreenUdpKeys {
  studentToHost: Buffer
  hostToStudent: Buffer
}

export function deriveScreenUdpKeys(screenBufferKey: Buffer): ScreenUdpKeys {
  const salt = 'zt-exam-udp-screen-v1'
  return {
    studentToHost: Buffer.from(hkdfSync('sha256', screenBufferKey, salt, 'c2s', 32)),
    hostToStudent: Buffer.from(hkdfSync('sha256', screenBufferKey, salt, 's2c', 32))
  }
}

export type UdpScreenPacket =
  | { type: typeof UdpPacketType.data; atomType: number; atomSeq: number; chunkIndex: number; chunkCount: number; chunk: Uint8Array }
  | { type: typeof UdpPacketType.nack; entries: UdpNackEntry[] }

export function decodeChannelId(channelIdHex: string): Buffer {
  if (!/^[0-9a-f]{16}$/.test(channelIdHex)) throw new Error('UDP_CHANNEL_ID_MUST_BE_16_HEX')
  return Buffer.from(channelIdHex, 'hex')
}

/** เขียนแพ็กเกต UDP + เข้ารหัส (IV สุ่มใหม่ทุกการเรียก) */
export function encodeUdpScreenPacket(options: {
  channelIdHex: string
  epoch: number
  seq: number
  key: Buffer
  data: UdpScreenPacket
}): Buffer {
  const channelId = decodeChannelId(options.channelIdHex)
  const iv = randomBytes(12)
  let body: Buffer
  if (options.data.type === UdpPacketType.data) {
    body = Buffer.allocUnsafe(UDP_SCREEN_DATA_HEADER + options.data.chunk.length)
    body[0] = options.data.atomType & 0xff
    body.writeUInt32BE(options.data.atomSeq >>> 0, 1)
    body.writeUInt16BE(options.data.chunkIndex & 0xffff, 5)
    body.writeUInt16BE(options.data.chunkCount & 0xffff, 7)
    if (options.data.chunk.length > 0) body.set(Buffer.from(options.data.chunk), UDP_SCREEN_DATA_HEADER)
  } else {
    const entries = options.data.entries.slice(0, 64).map((entry) => ({ atomSeq: entry.atomSeq, missing: entry.missing.slice(0, 0xff) }))
    let size = 1
    for (const entry of entries) size += 5 + entry.missing.length * 2
    body = Buffer.allocUnsafe(size)
    body[0] = entries.length & 0xff
    let offset = 1
    for (const entry of entries) {
      body.writeUInt32BE(entry.atomSeq >>> 0, offset)
      body[offset + 4] = entry.missing.length & 0xff
      let index = 0
      for (const missing of entry.missing) {
        body.writeUInt16BE(missing & 0xffff, offset + 5 + index * 2)
        index += 1
      }
      offset += 5 + index * 2
    }
  }
  if (UDP_SCREEN_HEADER_SIZE + body.length + UDP_SCREEN_GCM_TAG > UDP_SCREEN_MAX_PACKET) {
    throw new Error('UDP_PACKET_TOO_LARGE')
  }
  const out = Buffer.allocUnsafe(UDP_SCREEN_HEADER_SIZE + body.length + UDP_SCREEN_GCM_TAG)
  Buffer.from(UDP_SCREEN_MAGIC.buffer, UDP_SCREEN_MAGIC.byteOffset, UDP_SCREEN_MAGIC.byteLength).copy(out, 0)
  out[4] = options.data.type & 0xff
  channelId.copy(out, 5)
  out.writeUInt16BE(options.epoch & 0xffff, 13)
  out.writeUInt32BE(options.seq >>> 0, 15)
  iv.copy(out, 19)
  const cipher = createCipheriv('aes-256-gcm', options.key, iv)
  cipher.setAAD(out.subarray(0, UDP_SCREEN_HEADER_SIZE))
  const written = cipher.update(body)
  written.copy(out, UDP_SCREEN_HEADER_SIZE)
  cipher.final().copy(out, UDP_SCREEN_HEADER_SIZE + written.length)
  cipher.getAuthTag().copy(out, UDP_SCREEN_HEADER_SIZE + body.length)
  return out
}

/** อ่านแพ็กเกต UDP — คืน null เมื่อลายเซ็น/GCM ไม่ผ่านหรือรูปแบบชำรุด */
export function decodeUdpScreenPacket(packet: Uint8Array, key: Buffer): UdpDataPacketFrame | UdpNackPacketFrame | null {
  if (packet.length < UDP_SCREEN_HEADER_SIZE + UDP_SCREEN_GCM_TAG + 1) return null
  const buf = Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength)
  if (!buf.subarray(0, 4).equals(Buffer.from(UDP_SCREEN_MAGIC.buffer, UDP_SCREEN_MAGIC.byteOffset, 4))) return null
  const packetType = buf[4]
  if (packetType !== UdpPacketType.data && packetType !== UdpPacketType.nack) return null
  const channelIdHex = buf.subarray(5, 13).toString('hex')
  const epoch = buf.readUInt16BE(13)
  const seq = buf.readUInt32BE(15)
  const iv = buf.subarray(19, 31)
  let body: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(buf.subarray(0, UDP_SCREEN_HEADER_SIZE))
    decipher.setAuthTag(buf.subarray(buf.length - UDP_SCREEN_GCM_TAG))
    body = Buffer.concat([decipher.update(buf.subarray(UDP_SCREEN_HEADER_SIZE, buf.length - UDP_SCREEN_GCM_TAG)), decipher.final()])
  } catch {
    return null
  }
  if (packetType === UdpPacketType.data) {
    if (body.length < UDP_SCREEN_DATA_HEADER) return null
    return {
      kind: 'data',
      channelIdHex,
      epoch,
      seq,
      atomType: body[0] ?? 0,
      atomSeq: body.readUInt32BE(1),
      chunkIndex: body.readUInt16BE(5),
      chunkCount: body.readUInt16BE(7),
      chunk: new Uint8Array(body.subarray(UDP_SCREEN_DATA_HEADER))
    }
  }
  if (body.length < 1) return null
  const entries: UdpNackEntry[] = []
  const count = body[0] ?? 0
  let offset = 1
  for (let i = 0; i < count; i += 1) {
    if (body.length < offset + 5) return null
    const atomSeq = body.readUInt32BE(offset)
    const missingCount = body[offset + 4] ?? 0
    if (body.length < offset + 5 + missingCount * 2) return null
    const missing: number[] = []
    for (let m = 0; m < missingCount; m += 1) missing.push(body.readUInt16BE(offset + 5 + m * 2))
    entries.push({ atomSeq, missing })
    offset += 5 + missingCount * 2
  }
  return { kind: 'nack', channelIdHex, epoch, seq, entries }
}

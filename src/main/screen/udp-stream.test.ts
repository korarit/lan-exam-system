import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UDP_SCREEN_CHUNK_SIZE,
  UDP_SCREEN_HEADER_SIZE,
  UdpAtomType,
  UdpPacketType,
  encodeUdpSegmentAtom,
  normalizeUdpPeerIp,
  type UdpSegmentAtomHeader
} from '@shared/udp-screen-protocol'
import { decodeChannelId, decodeUdpScreenPacket, decodeUdpSegmentAtom, deriveScreenUdpKeys, encodeUdpScreenPacket } from './udp-crypto'
import { UdpStreamSender } from './udp-stream-sender'
import { UdpStreamReceiver } from './udp-stream-receiver'

const keyMaterial = Buffer.alloc(32, 7).fill(Buffer.from('screen-test-key-material-0000000'))
const keys = deriveScreenUdpKeys(keyMaterial)

function makeHeader(overrides: Partial<UdpSegmentAtomHeader> = {}): UdpSegmentAtomHeader {
  return {
    origin: 'live',
    requestId: 'req-1',
    segmentId: 'ring-display-0-5',
    displayId: 'display-0',
    mimeType: 'video/webm',
    seqNo: 5,
    startTimeMs: 1_000,
    endTimeMs: 3_000,
    ...overrides
  }
}

describe('udp screen protocol — แพ็กเกต + คีย์', () => {
  it('HKDF ให้กุญแจ 2 ขาต่างกันและ deterministic', () => {
    const again = deriveScreenUdpKeys(keyMaterial)
    expect(keys.studentToHost.length).toBe(32)
    expect(keys.studentToHost.equals(keys.hostToStudent)).toBe(false)
    expect(keys.studentToHost.equals(again.studentToHost)).toBe(true)
    expect(keys.hostToStudent.equals(again.hostToStudent)).toBe(true)
  })

  it('DATA packet เข้า-ถอด รหัสตรงกัน (คีย์ student → host)', () => {
    const chunk = Buffer.alloc(50, 0xab)
    const packet = encodeUdpScreenPacket({
      channelIdHex: '0123456789abcdef',
      epoch: 3,
      seq: 42,
      key: keys.studentToHost,
      data: { type: UdpPacketType.data, atomType: UdpAtomType.segment, atomSeq: 17, chunkIndex: 2, chunkCount: 9, chunk }
    })
    expect(packet.length).toBe(UDP_SCREEN_HEADER_SIZE + 9 + 50 + 16)
    const frame = decodeUdpScreenPacket(packet, keys.studentToHost)
    expect(frame).not.toBeNull()
    expect(frame!.kind).toBe('data')
    expect(frame!.channelIdHex).toBe('0123456789abcdef')
    expect(frame!.epoch).toBe(3)
    expect(frame!.seq).toBe(42)
    if (frame!.kind === 'data') {
      expect(frame!.atomSeq).toBe(17)
      expect(frame!.chunkIndex).toBe(2)
      expect(frame!.chunkCount).toBe(9)
      expect(frame!.chunk.length).toBe(50)
    }
  })

  it('ถอดด้วยกุญแจขาอื่น (s2c) → null (กัน monkey ทางขาตรงข้าม)', () => {
    const packet = encodeUdpScreenPacket({
      channelIdHex: '0123456789abcdef',
      epoch: 1,
      seq: 1,
      key: keys.studentToHost,
      data: { type: UdpPacketType.data, atomType: UdpAtomType.segment, atomSeq: 1, chunkIndex: 0, chunkCount: 1, chunk: Buffer.alloc(10, 1) }
    })
    expect(decodeUdpScreenPacket(packet, keys.hostToStudent)).toBeNull()
  })

  it('แก้ไข payload กลางทาง → GCM ปฏิเสธ (null)', () => {
    const packet = encodeUdpScreenPacket({
      channelIdHex: '0123456789abcdef',
      epoch: 1,
      seq: 1,
      key: keys.studentToHost,
      data: { type: UdpPacketType.data, atomType: UdpAtomType.segment, atomSeq: 1, chunkIndex: 0, chunkCount: 1, chunk: Buffer.alloc(10, 1) }
    })
    const last = packet.readUInt8(packet.length - 1) ^ 0xff
    packet.writeUInt8(last, packet.length - 1)
    expect(decodeUdpScreenPacket(packet, keys.studentToHost)).toBeNull()
    // แก้ header (AAD) ก็ต้องพังเหมือนกัน
    packet[13] = (packet[13] ?? 0) ^ 0x01
    expect(decodeUdpScreenPacket(packet, keys.studentToHost)).toBeNull()
  })

  it('NACK packet เข้า-ถอดรายการชิ้นที่หาย', () => {
    const packet = encodeUdpScreenPacket({
      channelIdHex: 'ffffffff00001234',
      epoch: 1,
      seq: 9,
      key: keys.hostToStudent,
      data: { type: UdpPacketType.nack, entries: [{ atomSeq: 1, missing: [2, 5] }, { atomSeq: 3, missing: [0] }] }
    })
    const frame = decodeUdpScreenPacket(packet, keys.hostToStudent)
    expect(frame!.kind).toBe('nack')
    if (frame!.kind === 'nack') {
      expect(frame!.channelIdHex).toBe('ffffffff00001234')
      const entries = frame!.entries
      expect(entries.length).toBe(2)
      expect(entries[0]!.atomSeq).toBe(1)
      expect(entries[0]!.missing).toEqual([2, 5])
      expect(entries[1]!.missing).toEqual([0])
    }
  })
})

describe('udp screen protocol — atom เซกเมนต์', () => {
  it('atom เข้า-ถอดได้ตรงข้อมูล', () => {
    const webm = Buffer.from('SECRET_WEBM_SEGMENT'.repeat(100))
    const atom = encodeUdpSegmentAtom(makeHeader(), webm)
    const decoded = decodeUdpSegmentAtom(atom)
    expect(decoded).not.toBeNull()
    expect(decoded!.header).toMatchObject({ origin: 'live', segmentId: 'ring-display-0-5', seqNo: 5 })
    expect(Buffer.from(decoded!.webm).equals(webm)).toBe(true)
  })

  it('decodeChannelId ปฏิเสธรูปแบบผิด', () => {
    expect(() => decodeChannelId('zzzz')).toThrow()
    expect(decodeChannelId('0123456789abcdef').length).toBe(8)
  })

  it('normalizeUdpPeerIp แปลง IPv4-mapped IPv6 → IPv4', () => {
    expect(normalizeUdpPeerIp('::ffff:192.168.1.9')).toBe('192.168.1.9')
    expect(normalizeUdpPeerIp('::1')).toBe('127.0.0.1')
    expect(normalizeUdpPeerIp('10.0.0.3')).toBe('10.0.0.3')
  })
})

describe('UdpStreamSender + UdpStreamReceiver (localhost จริง)', () => {
  let receiver: UdpStreamReceiver | null = null
  let sender: UdpStreamSender | null = null

  afterEach(() => {
    sender?.close()
    receiver?.stop()
  })

  it('ส่ง atom เฟรมใหญ่ (หลาย chunk) ผ่าน UDP localhost ได้ข้อมูลครบ', async () => {
    receiver = new UdpStreamReceiver({
      onSegment: (channelIdHex, header, webm) => {
        receivedLast = { channelIdHex, header, webm }
      },
      onSegmentFailed: () => {
        failedLast = true
      }
    })
    const port = await receiver.start()
    expect(port).not.toBeNull()

    const hostPort = port!
    sender = new UdpStreamSender({ hostAddress: '127.0.0.1', hostPort, keys })
    const senderPort = await sender.start()
    expect(senderPort).toBeGreaterThan(0)

    expect(receiver.registerChannel(sender.channelIdHex, '127.0.0.1', keys)).toBe(true)
    // channelId ซ้ำจากคนอื่น (IP ต่าง) → ปฏิเสธ
    expect(receiver.registerChannel(sender.channelIdHex, '10.9.9.9', keys)).toBe(false)

    const webm = Buffer.from(FAKE_WEBM.repeat(200)) // ~4KB → หลายชิง (1100 bytes/ชิง)
    expect(webm.length).toBeGreaterThan(UDP_SCREEN_CHUNK_SIZE * 2)
    receiver.registerChannel(sender.channelIdHex, '127.0.0.1', keys)
    const atomSeq = sender.sendSegmentAtom(makeHeader(), webm, UdpAtomType.segment)
    expect(atomSeq).not.toBeNull()

    await vi.waitFor(
      () => {
        expect(receivedLast).not.toBeNull()
      },
      { timeout: 3_000, interval: 50 }
    )
    expect(failedLast).toBe(false)
    expect(receivedLast!.channelIdHex).toBe(sender.channelIdHex)
    expect(receivedLast!.header.segmentId).toBe('ring-display-0-5')
    expect(Buffer.from(receivedLast!.webm).equals(webm)).toBe(true)
  })

  let receivedLast: { channelIdHex: string; header: UdpSegmentAtomHeader; webm: Uint8Array } | null = null
  let failedLast = false
})

const FAKE_WEBM = 'A'.repeat(64)

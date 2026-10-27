import { Transform, type TransformCallback } from 'node:stream'
import type { TLSSocket } from 'node:tls'

export const MAX_FRAME_SIZE = 10 * 1024 * 1024 // 10 MB
const HEADER_SIZE = 5 // 4 bytes UInt32BE length + 1 byte type

export const FrameType = {
  json: 0x01,
  binary: 0x02
} as const

export interface Frame {
  type: (typeof FrameType)[keyof typeof FrameType]
  payload: Buffer
}

/** ต่อเข้าเป็น 1 frame: [UInt32BE length][type][payload] */
export function encodeFrame(payload: Buffer, type: number = FrameType.json): Buffer {
  if (payload.length + HEADER_SIZE > MAX_FRAME_SIZE) {
    throw new Error('FRAME_TOO_LARGE')
  }
  const header = Buffer.alloc(HEADER_SIZE)
  header.writeUInt32BE(payload.length, 0)
  header.writeUInt8(type, 4)
  return Buffer.concat([header, payload])
}

/** เขียน JSON message ออกทาง socket */
export function writeJsonFrame(socket: TLSSocket, value: unknown): void {
  socket.write(encodeFrame(Buffer.from(JSON.stringify(value), 'utf8'), FrameType.json))
}

/**
 * FrameDecoder: รับ stream ที่ถูกหั่น/ติดกันกี่ทีก็ได้ แล้วแบ่งเป็น frame รายข้อความ
 * ถ้าประกาศขนาดเกิน MAX_FRAME_SIZE ให้ destroy ทันที (กัน DoS)
 */
export class FrameDecoder extends Transform {
  private buffer: Buffer = Buffer.alloc(0)

  constructor() {
    super({ objectMode: true })
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    // ทุก chunk วนดึง frame จนหมดที่มี
    while (this.buffer.length >= HEADER_SIZE) {
      const payloadLength = this.buffer.readUInt32BE(0)
      if (payloadLength > MAX_FRAME_SIZE - HEADER_SIZE) {
        callback(new Error('FRAME_TOO_LARGE'))
        this.buffer = Buffer.alloc(0)
        return
      }
      const totalLength = HEADER_SIZE + payloadLength
      if (this.buffer.length < totalLength) break // รอข้อมูลเพิ่ม

      const type = this.buffer.readUInt8(4)
      const payload = Buffer.from(
        this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength)
      )
      this.buffer = this.buffer.subarray(totalLength)
      this.push({ type: type as Frame['type'], payload } satisfies Frame)
    }
    callback()
  }

  override _flush(callback: TransformCallback): void {
    if (this.buffer.length > 0) {
      callback(new Error('INCOMPLETE_FRAME'))
      return
    }
    callback()
  }
}

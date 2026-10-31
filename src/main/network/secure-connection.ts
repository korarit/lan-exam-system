import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { TLSSocket } from 'node:tls'
import { FrameDecoder, writeJsonFrame, encodeFrame, FrameType } from './framing'
import {
  NetEnvelopeSchema,
  NetMessagePayloadSchemas,
  NetMsgType,
  type NetEnvelope
} from '@shared/protocol-schema'
import { computeHmac, verifyHmacTimingSafe } from '../crypto/primitives'

export interface SecureConnectionEvents {
  message: (message: { type: string; payload: unknown; seq: number }) => void
  /** Phase 3c: binary frame (thumbnail / ring segment) — ความปลอดภัยอาศัย TLS อยู่แล้ว */
  binary: (frame: { subType: number; payload: Buffer }) => void
  anomaly: (reason: string) => void
  closed: () => void
}

/**
 * Connection ที่มี Envelope ครบลูก:
 * - ทุกข้อความมี msgId / seq (เพิ่มขึ้นต่อ sender) / timestamp
 * - เมื่อตั้ง sessionKey แล้ว ทุกข้อความต้องมี HMAC ที่ถูกต้อง
 * - Anti-replay: ปฏิเสธข้อความที่ seq <= lastReceivedSeq (emit 'anomaly')
 */
export class SecureConnection extends EventEmitter {
  private lastSentSeq = -1
  private lastReceivedSeq = -1
  private sessionKey: Buffer | null = null
  private destroyed = false

  constructor(
    private readonly socket: TLSSocket,
    private readonly emitAnomalies = true
  ) {
    super()
    const decoder = new FrameDecoder()
    socket.pipe(decoder)
    decoder.on('data', (frame: { type: number; payload: Buffer }) => {
      if (frame.type === FrameType.binary) {
        if (frame.payload.length < 1) {
          this.anomaly('EMPTY_BINARY_FRAME')
          return
        }
        this.emit('binary', { subType: frame.payload[0] ?? 0, payload: frame.payload.subarray(1) })
        return
      }
      if (frame.type !== FrameType.json) {
        this.anomaly('UNSUPPORTED_FRAME_TYPE')
        return
      }
      this.handleEnvelope(frame.payload)
    })
    decoder.on('error', (err: Error) => {
      this.anomaly(err.message)
      this.destroy()
    })
    socket.on('error', () => this.destroy())
    socket.on('close', () => {
      if (!this.destroyed) {
        this.destroyed = true
        this.emit('closed')
      }
    })
  }

  get isDestroyed(): boolean {
    return this.destroyed
  }

  get remoteAddress(): string | undefined {
    return this.socket.remoteAddress
  }

  /** ดึง TLS exporter material (ผูกกับ session จริงของ TLS 1.3) — context ว่างเปล่าทั้งสองฝั่ง */
  exportKeyingMaterial(length: number, label: string): Buffer | null {
    try {
      return this.socket.exportKeyingMaterial(length, label, Buffer.alloc(0))
    } catch {
      return null
    }
  }

  /** fingerprint ของ peer cert จาก TLS socket จริง (hex 64 ตัว พิมพ์เล็ก) */
  getPeerCertificateFingerprint(): string {
    const fp = this.socket.getPeerCertificate().fingerprint256 ?? ''
    return fp.replace(/:/g, '').toLowerCase()
  }

  setSessionKey(key: Buffer): void {
    this.sessionKey = key
  }

  hasSessionKey(): boolean {
    return this.sessionKey !== null
  }

  /** ส่งข้อความแบบ typed (seq เพิ่มอัตโนมัติ, แนบ HMAC เมื่อมี sessionKey) — false = สายปิดอยู่ */
  send(type: string, payload: unknown): boolean {
    if (this.destroyed) return false
    const envelope: NetEnvelope = {
      msgId: randomUUID(),
      seq: ++this.lastSentSeq,
      timestamp: Date.now(),
      type,
      payload
    }
    if (this.sessionKey) {
      envelope.hmac = this.computeEnvelopeHmac(envelope).toString('base64')
    }
    if (this.socket.writable === false) {
      this.destroy()
      return false
    }
    try {
      writeJsonFrame(this.socket, envelope)
      return true
    } catch {
      this.destroy()
      return false
    }
  }

  /** ส่ง binary frame (Phase 3c: thumbnail / segment) — ใช้ความปลอดภัยจาก TLS โดยตรง */
  sendBinary(subType: number, payload: Buffer): void {
    if (this.destroyed) return
    this.socket.write(
      encodeFrame(Buffer.concat([Buffer.from([subType & 0xff]), payload]), FrameType.binary)
    )
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    try {
      this.socket.destroy()
    } catch {
      // ปล่อยผ่าน — ปิดสายเงียบ ๆ ได้
    }
    this.emit('closed')
  }

  /** ค่า HMAC ครอบ envelope (ใช้ตอนตรวจกับ sessionKey) */
  private computeEnvelopeHmac(envelope: NetEnvelope): Buffer {
    const key = this.sessionKey
    if (!key) throw new Error('SESSION_KEY_REQUIRED')
    return computeHmac(key, canonicalEnvelopeBytes(envelope))
  }

  private handleEnvelope(raw: Buffer): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      this.anomaly('MALFORMED_JSON')
      this.destroy()
      return
    }
    const envelopeResult = NetEnvelopeSchema.safeParse(parsed)
    if (!envelopeResult.success) {
      this.anomaly('BAD_ENVELOPE')
      this.destroy()
      return
    }
    const envelope = envelopeResult.data

    // anti-replay: seq ต้องเดินหน้าเสมอ
    if (envelope.seq <= this.lastReceivedSeq) {
      this.anomaly(`REPLAY_SEQ_${envelope.seq}`)
      return
    }
    this.lastReceivedSeq = envelope.seq

    // HMAC หลังมี sessionKey แล้วต้องมีและถูกต้องเสมอ
    if (this.sessionKey) {
      if (!envelope.hmac) {
        this.anomaly('MISSING_HMAC')
        this.destroy()
        return
      }
      const expected = this.computeEnvelopeHmac(envelope)
      const mac = Buffer.from(envelope.hmac, 'base64')
      if (!verifyHmacTimingSafe(this.sessionKey, canonicalEnvelopeBytes(envelope), mac)) {
        this.anomaly('BAD_HMAC')
        this.destroy()
        return
      }
      void expected
    } else if (envelope.hmac) {
      this.anomaly('UNEXPECTED_HMAC')
      this.destroy()
      return
    }

    const payloadSchema = NetMessagePayloadSchemas[envelope.type]
    if (!payloadSchema) {
      this.anomaly(`UNKNOWN_TYPE_${envelope.type}`)
      this.destroy()
      return
    }
    const payloadResult = payloadSchema.safeParse(envelope.payload)
    if (!payloadResult.success) {
      this.anomaly('BAD_PAYLOAD')
      this.destroy()
      return
    }

    this.emit('message', {
      type: envelope.type,
      payload: payloadResult.data,
      seq: envelope.seq
    })
  }

  private anomaly(reason: string): void {
    if (this.emitAnomalies) this.emit('anomaly', reason)
  }
}

/** รูปแบบข้อมูลที่ HMAC ครอบ — ต้องคำนวณเหมือนกันทั้งสองฝั่ง */
function canonicalEnvelopeBytes(envelope: NetEnvelope): Buffer {
  return Buffer.from(
    `${envelope.msgId}:${envelope.seq}:${envelope.timestamp}:${envelope.type}:` +
      JSON.stringify(envelope.payload),
    'utf8'
  )
}

/** ข้อความที่ใช้ระหว่าง handshake (ยังไม่มี HMAC) */
export const HANDSHAKE_TIMEOUT_MS = 10_000

export function isHandshakeMessageType(type: string): boolean {
  return (
    type === NetMsgType.clientHello ||
    type === NetMsgType.serverProof ||
    type === NetMsgType.joinRequest ||
    type === NetMsgType.joinAccepted ||
    type === NetMsgType.joinRejected ||
    type === NetMsgType.resumeRequest
  )
}

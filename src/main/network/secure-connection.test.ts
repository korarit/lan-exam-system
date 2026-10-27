import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { SecureConnection } from './secure-connection'
import { NetMsgType } from '@shared/protocol-schema'

/** สร้าง duplex socket จำลองคู่สายในหน่วยความจำ (แทน TLSSocket) */
function createFakeSocketPair(): [TLSSocket, TLSSocket] {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const makeSide = (
    incoming: PassThrough,
    outgoing: PassThrough,
    remote: string
  ): TLSSocket => {
    const emitter = new EventEmitter()
    const side = {
      remoteAddress: remote,
      write: (chunk: Buffer): boolean => {
        void outgoing.write(chunk)
        return true
      },
      destroy: (): void => {
        incoming.destroy()
        outgoing.destroy()
        emitter.emit('close')
      },
      pipe: (dest: unknown): unknown => {
        void incoming.pipe(dest as never)
        return dest
      },
      exportKeyingMaterial: (length: number, label: string): Buffer => {
        void label
        return Buffer.alloc(length, 0xab)
      }
    }
    return Object.assign(emitter, side) as unknown as TLSSocket
  }
  return [makeSide(bToA, aToB, '10.0.0.1'), makeSide(aToB, bToA, '10.0.0.2')]
}

/** ต้อง attach listener ก่อน send เพราะ fake stream ส่งข้อมูลแบบ synchronous */
function createMessageQueue(connection: SecureConnection): () => Promise<{ type: string; payload: unknown; seq: number }> {
  const queue: Array<{ type: string; payload: unknown; seq: number }> = []
  const waiters: Array<(m: { type: string; payload: unknown; seq: number }) => void> = []
  connection.on('message', (message) => {
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else queue.push(message)
  })
  return () =>
    new Promise((resolve) => {
      const item = queue.shift()
      if (item) resolve(item)
      else waiters.push(resolve)
    })
}

function waitForAnomaly(connection: SecureConnection): Promise<string> {
  return new Promise((resolve) => {
    connection.once('anomaly', (reason: string) => resolve(reason))
  })
}

function waitForClosed(connection: SecureConnection): Promise<void> {
  return new Promise((resolve) => {
    connection.once('closed', () => resolve())
  })
}

describe('SecureConnection', () => {
  it('delivers a message across the socket pair with increasing seq', async () => {
    const [sockA, sockB] = createFakeSocketPair()
    const a = new SecureConnection(sockA)
    const b = new SecureConnection(sockB)
    const nextMessage = createMessageQueue(b)

    a.send(NetMsgType.clientHello, { protocolVersion: 1, clientNonce: 'n'.repeat(43) })
    a.send(NetMsgType.joinRequest, { studentId: 's1', studentName: 'n1', clientAuthHmac: 'x'.repeat(43) })

    const first = await nextMessage()
    const second = await nextMessage()
    expect(first.type).toBe(NetMsgType.clientHello)
    expect(second.type).toBe(NetMsgType.joinRequest)
    expect(second.seq).toBeGreaterThan(first.seq)
  })

  it('signs with HMAC once a session key is set and verifies on the peer', async () => {
    const [sockA, sockB] = createFakeSocketPair()
    const a = new SecureConnection(sockA)
    const b = new SecureConnection(sockB)
    const key = Buffer.alloc(32, 7)
    a.setSessionKey(key)
    b.setSessionKey(key)
    const nextMessage = createMessageQueue(b)

    a.send(NetMsgType.heartbeatPing, { focusState: 'focused', currentQuestionIndex: null })

    const message = await nextMessage()
    expect(message.type).toBe(NetMsgType.heartbeatPing)
    expect(message.seq).toBe(0)
  })

  it('rejects a replayed/out-of-order seq as an anomaly', async () => {
    const [sockA, sockB] = createFakeSocketPair()
    const a = new SecureConnection(sockA)
    const b = new SecureConnection(sockB)
    const nextMessage = createMessageQueue(b)
    const anomaly = waitForAnomaly(b)

    a.send(NetMsgType.error, { message: 'one' })
    await nextMessage()
    // บังคับ seq ย้อนหลัง (แก้ผ่าน internal เพื่อจำลอง replay)
    ;(a as unknown as { lastSentSeq: number }).lastSentSeq = -1
    a.send(NetMsgType.error, { message: 'replayed' })

    expect(await anomaly).toMatch(/^REPLAY_SEQ_/)
  })

  it('destroys the connection when the HMAC does not match', async () => {
    const [sockA, sockB] = createFakeSocketPair()
    const a = new SecureConnection(sockA)
    const b = new SecureConnection(sockB)
    const keyA = Buffer.alloc(32, 1)
    const keyB = Buffer.alloc(32, 2) // คีย์ไม่ตรงกัน (จำลอง attacker)
    a.setSessionKey(keyA)
    b.setSessionKey(keyB)
    const anomaly = waitForAnomaly(b)
    const closed = waitForClosed(b)

    a.send(NetMsgType.error, { message: 'spoofed' })

    expect(await anomaly).toBe('BAD_HMAC')
    await closed
    expect(b.isDestroyed).toBe(true)
  })

  it('destroys the connection on an unknown message type', async () => {
    const [sockA, sockB] = createFakeSocketPair()
    const a = new SecureConnection(sockA)
    const b = new SecureConnection(sockB)
    const anomaly = waitForAnomaly(b)
    const closed = waitForClosed(b)

    a.send('INVALID_TYPE_NAME', {})

    expect(await anomaly).toBe('UNKNOWN_TYPE_INVALID_TYPE_NAME')
    await closed
    expect(b.isDestroyed).toBe(true)
  })

  it('rejects an unexpected HMAC before the session key is established', async () => {
    const [sockA, sockB] = createFakeSocketPair()
    const a = new SecureConnection(sockA)
    const b = new SecureConnection(sockB)
    // ฝั่ง A มีคีย์แต่ฝั่ง B ยังไม่มี = ข้อความมี HMAC ตั้งแต่ก่อน handshake เสร็จ
    a.setSessionKey(Buffer.alloc(32, 3))
    const anomaly = waitForAnomaly(b)
    const closed = waitForClosed(b)

    a.send(NetMsgType.clientHello, { protocolVersion: 1, clientNonce: 'n'.repeat(43) })

    expect(await anomaly).toBe('UNEXPECTED_HMAC')
    await closed
  })

  it('keeps envelope payload intact between sender and receiver', async () => {
    const [sockA, sockB] = createFakeSocketPair()
    const a = new SecureConnection(sockA)
    const b = new SecureConnection(sockB)
    const key = Buffer.alloc(32, 9)
    a.setSessionKey(key)
    b.setSessionKey(key)
    const nextMessage = createMessageQueue(b)
    const payload = { focusState: 'blurred' as const, currentQuestionIndex: 3 }

    a.send(NetMsgType.heartbeatPing, payload)

    const message = await nextMessage()
    expect(message.payload).toEqual(payload)
  })
})

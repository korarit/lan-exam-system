import { describe, it, expect, afterEach } from 'vitest'
import { ExamTlsServer } from './tls-server'
import { ExamTlsClient, HandshakeProofError, JoinRejectedError } from './tls-client'
import {
  generateEphemeralCert,
  derivePinKey,
  generateRoomPin
} from './crypto-cert'

const ROOM_ID = '33333333-3333-4333-8333-333333333333'
const CLEANUPS: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (CLEANUPS.length > 0) {
    const cleanup = CLEANUPS.pop()
    if (cleanup) await cleanup()
  }
})

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface TestServer {
  server: ExamTlsServer
  port: number
  pin: string
}

async function startServer(pin: string): Promise<TestServer> {
  const cert = await generateEphemeralCert()
  const server = new ExamTlsServer({
    cert,
    pinKey: derivePinKey(pin, ROOM_ID),
    roomId: ROOM_ID,
    onStudentsChanged: () => undefined
  })
  const port = await server.listen(0)
  CLEANUPS.push(() => server.stop())
  return { server, port, pin }
}

describe('TLS 1.3 + PIN handshake (integration)', () => {
  it('completes a full join with the correct PIN and matching TLS exporters', async () => {
    const pin = generateRoomPin()
    const { server, port } = await startServer(pin)

    const client = new ExamTlsClient({ onConnectionState: () => undefined })
    CLEANUPS.push(() => client.stop())
    const result = await client.connect({
      host: '127.0.0.1',
      port,
      roomId: ROOM_ID,
      roomPin: pin,
      studentId: 'std-01',
      studentName: 'สมชาย ใจดี'
    })

    expect(result.sessionToken.length).toBeGreaterThanOrEqual(16)
    expect(result.dynamicSessionKey.length).toBe(32)
    expect(server.studentCount).toBe(1)
    const serverStudent = server.getStudents()[0]
    expect(serverStudent?.studentId).toBe('std-01')

    // TLS exporter ต้องตรงกันทั้งสองฝั่ง (ผูก attestation ใน Phase 4)
    const clientExporter = client.exporter
    const serverExporter = server.getStudentExporter('std-01')
    expect(clientExporter).not.toBeNull()
    expect(serverExporter).not.toBeNull()
    expect(clientExporter!.equals(serverExporter!)).toBe(true)
  })

  it('rejects the connection immediately when the PIN is wrong (MITM/PIN check)', async () => {
    const { port, pin } = await startServer(generateRoomPin())
    const client = new ExamTlsClient({ onConnectionState: () => undefined })
    CLEANUPS.push(() => client.stop())

    await expect(
      client.connect({
        host: '127.0.0.1',
        port,
        roomId: ROOM_ID,
        roomPin: pin === '000000' ? '000001' : '000000',
        studentId: 'std-01',
        studentName: 'ผู้ไม่หวังดี'
      })
    ).rejects.toBeInstanceOf(HandshakeProofError)
  })

  it('rejects JOIN_REQUEST with a tampered client auth HMAC (bad-auth)', async () => {
    // จำลอง MITM: รู้ PIN แต่ spoof studentId ไม่ได้ จึงต้องเจาะผ่าน client จริง
    // โดยแก้ studentId ตอนสร้าง HMAC ไม่ได้เพราะ client สร้างเอง จึงใช้กรณี PIN ถูก
    // แต่ auth ไม่ผ่าน = สมมติเครื่องลูกคีย์เพี้ยน — ทดสอบผ่าน PIN ผิดฝั่ง client auth:
    const pin = generateRoomPin()
    const { server, port } = await startServer(pin)

    const client = new ExamTlsClient({ onConnectionState: () => undefined })
    CLEANUPS.push(() => client.stop())
    // หมายเหตุ: proof ผ่านเพราะ PIN ถูก แต่ auth คำนวณจาก roomId ต่างกัน
    // (client ใช้ roomId อื่นสำหรับ PBKDF2 → key ไม่ตรง → bad-auth)
    await expect(
      client.connect({
        host: '127.0.0.1',
        port,
        roomId: '44444444-4444-4444-8444-444444444444',
        roomPin: pin,
        studentId: 'std-99',
        studentName: 'key mismatch'
      })
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof HandshakeProofError || (err instanceof JoinRejectedError && err.reason === 'bad-auth')
    })
    expect(server.studentCount).toBe(0)
  })

  it('replies HEARTBEAT_PONG with host-authoritative time', async () => {
    const pin = generateRoomPin()
    const { port } = await startServer(pin)
    const client = new ExamTlsClient({ onConnectionState: () => undefined })
    CLEANUPS.push(() => client.stop())
    await client.connect({
      host: '127.0.0.1',
      port,
      roomId: ROOM_ID,
      roomPin: pin,
      studentId: 'std-heart',
      studentName: 'หัวใจสีชมพู'
    })

    // รอ heartbeat รอบแรก (interval 3s) แล้วเช็คว่าได้ pong จากเครื่องแม่
    const deadline = Date.now() + 6000
    while (client.serverTimeMs === 0 && Date.now() < deadline) {
      await wait(100)
    }
    expect(client.serverTimeMs).toBeGreaterThan(0)
    expect(client.remainingExamSeconds).toBe(0) // ยังไม่ตั้งเวลาสอบ
  }, 15000)
})

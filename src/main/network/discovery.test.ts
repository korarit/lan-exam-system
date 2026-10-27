import { describe, it, expect, afterEach } from 'vitest'
import { RoomBroadcaster, RoomDiscoveryListener, DISCOVERY_PORT } from './discovery'

const CLEANUPS: Array<() => void> = []

afterEach(() => {
  while (CLEANUPS.length > 0) {
    CLEANUPS.pop()?.()
  }
})

function makeBeacon(roomId: string) {
  return {
    magic: 'ZTEXAM_V1' as const,
    roomId,
    roomName: 'ห้อง 401',
    hostName: 'TEACHER-PC',
    examMode: 'closed' as const,
    tcpPort: 45555,
    certFpShort: 'a'.repeat(16),
    studentCount: 0,
    examStatus: 'lobby' as const,
    timestamp: Date.now()
  }
}

describe('UDP Discovery', () => {
  it('host beacon arrives at the listener within 3 seconds (loopback)', async () => {
    const roomId = '55555555-5555-4555-8555-555555555555'
    const broadcaster = new RoomBroadcaster({
      beacon: makeBeacon(roomId),
      destinations: [{ address: '127.0.0.1', port: DISCOVERY_PORT }]
    })
    const listener = new RoomDiscoveryListener()
    CLEANUPS.push(() => broadcaster.stop())
    CLEANUPS.push(() => listener.stop())

    const seen = new Promise<ReturnType<RoomDiscoveryListener['getRooms']>>((resolve) => {
      listener.once('rooms-changed', (rooms) => resolve(rooms))
    })
    listener.start()
    broadcaster.start()

    const rooms = await Promise.race([
      seen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('BEACON_TIMEOUT')), 3000))
    ])
    expect(rooms).toHaveLength(1)
    expect(rooms[0]!.roomId).toBe(roomId)
    expect(rooms[0]!.sourceIp).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/)
  })

  it('ignores malformed and stale-magic packets without crashing', async () => {
    const listener = new RoomDiscoveryListener()
    CLEANUPS.push(() => listener.stop())
    listener.start()
    // ยิงขยะเข้าพอร์ต discovery โดยตรง
    const dgram = await import('node:dgram')
    const sock = dgram.createSocket('udp4')
    CLEANUPS.push(() => sock.close())
    sock.send(Buffer.from('not-json'), DISCOVERY_PORT, '127.0.0.1')
    sock.send(JSON.stringify({ magic: 'WRONG_MAGIC' }), DISCOVERY_PORT, '127.0.0.1')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(listener.getRooms()).toHaveLength(0)
  })

  it('prunes rooms that stopped sending beacons (stale cleanup)', async () => {
    const roomId = '66666666-6666-4666-8666-666666666666'
    const broadcaster = new RoomBroadcaster({
      beacon: makeBeacon(roomId),
      destinations: [{ address: '127.0.0.1', port: DISCOVERY_PORT }]
    })
    const listener = new RoomDiscoveryListener()
    CLEANUPS.push(() => broadcaster.stop())
    CLEANUPS.push(() => listener.stop())

    const seen = new Promise<void>((resolve) => {
      listener.once('rooms-changed', () => resolve())
    })
    listener.start()
    broadcaster.start()
    await Promise.race([
      seen,
      new Promise((_, reject) => setTimeout(() => reject(new Error('BEACON_TIMEOUT')), 3000))
    ])

    // จำลองว่า beacon หยุดส่งไปนานแล้ว
    broadcaster.stop()
    const internals = listener as unknown as { rooms: Map<string, { lastSeenAtMs: number }> }
    for (const room of internals.rooms.values()) {
      room.lastSeenAtMs = Date.now() - 60_000
    }

    const pruned = new Promise<ReturnType<RoomDiscoveryListener['getRooms']>>((resolve) => {
      listener.once('rooms-changed', (rooms) => resolve(rooms))
    })
    const rooms = await Promise.race([
      pruned,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('PRUNE_TIMEOUT')), 3000))
    ])
    expect(rooms).toHaveLength(0)
  })
})

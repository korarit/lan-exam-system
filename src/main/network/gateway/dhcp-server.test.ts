import { afterEach, describe, expect, it } from 'vitest'
import dgram from 'node:dgram'
import {
  DHCP_MAGIC_COOKIE,
  DHCP_MESSAGE_TYPE,
  DHCP_OPTION,
  DhcpServer,
  buildDhcpReply,
  parseDhcpPacket,
  type DhcpServerConfig
} from './dhcp-server'
import { ipv4ToInt } from '@shared/gateway'

const SERVER_PORT = 6767
const CLIENT_PORT = 6768
const SERVER_IP = '192.168.50.1'

const CLEANUPS: Array<() => void> = []

afterEach(() => {
  while (CLEANUPS.length > 0) {
    try {
      CLEANUPS.pop()?.()
    } catch {
      // ignore
    }
  }
})

function macBuffer(mac: string): Buffer {
  const bytes = mac.split(':').map((part) => Number.parseInt(part, 16))
  const buf = Buffer.alloc(16)
  for (let i = 0; i < 6; i += 1) buf[i] = bytes[i] ?? 0
  return buf
}

interface PacketInput {
  type: number
  mac: string
  xid: number
  flags?: number
  ciaddr?: string
  giaddr?: string
  requestedIp?: string
  serverId?: string
  hostname?: string
}

function makePacket(input: PacketInput): Buffer {
  const buf = Buffer.alloc(240)
  buf.writeUInt8(1, 0) // BOOTREQUEST
  buf.writeUInt8(1, 1)
  buf.writeUInt8(6, 2)
  buf.writeUInt32BE(input.xid >>> 0, 4)
  buf.writeUInt16BE(input.flags ?? 0x8000, 10)
  if (input.ciaddr) buf.writeUInt32BE(ipv4ToInt(input.ciaddr) >>> 0, 12)
  if (input.giaddr) buf.writeUInt32BE(ipv4ToInt(input.giaddr) >>> 0, 24)
  macBuffer(input.mac).copy(buf, 28)
  buf.writeUInt32BE(DHCP_MAGIC_COOKIE, 236)
  const options: Buffer[] = []
  options.push(Buffer.from([DHCP_OPTION.messageType, 1, input.type]))
  if (input.requestedIp) {
    const data = Buffer.allocUnsafe(4)
    data.writeUInt32BE(ipv4ToInt(input.requestedIp) >>> 0, 0)
    options.push(Buffer.from([DHCP_OPTION.requestedIp, 4]), data)
  }
  if (input.serverId) {
    const data = Buffer.allocUnsafe(4)
    data.writeUInt32BE(ipv4ToInt(input.serverId) >>> 0, 0)
    options.push(Buffer.from([DHCP_OPTION.serverIdentifier, 4]), data)
  }
  if (input.hostname) {
    const data = Buffer.from(input.hostname, 'utf8')
    options.push(Buffer.from([DHCP_OPTION.hostname, data.length]), data)
  }
  options.push(Buffer.from([255]))
  return Buffer.concat([buf, ...options])
}

function baseConfig(patch: Partial<DhcpServerConfig> = {}): DhcpServerConfig {
  return {
    interfaceName: 'test0',
    bindAddress: '127.0.0.1',
    hostIp: SERVER_IP,
    subnetCidr: '192.168.50.0/24',
    poolStart: '192.168.50.100',
    poolEnd: '192.168.50.200',
    leaseTimeSeconds: 3600,
    port: SERVER_PORT,
    clientPort: CLIENT_PORT,
    broadcastAddress: '127.0.0.1',
    serverMac: '02:00:00:00:00:01',
    ...patch
  }
}

async function startServer(config: DhcpServerConfig): Promise<DhcpServer> {
  const server = new DhcpServer(config)
  await server.start()
  CLEANUPS.push(() => server.stop())
  return server
}

async function bindClient(): Promise<dgram.Socket> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(CLIENT_PORT, '127.0.0.1', () => resolve())
  })
  CLEANUPS.push(() => {
    try {
      socket.close()
    } catch {
      // ignore
    }
  })
  return socket
}

function sendRaw(socket: dgram.Socket, packet: Buffer): void {
  socket.send(packet, SERVER_PORT, '127.0.0.1')
}

function sendAndWait(socket: dgram.Socket, packet: Buffer, timeoutMs = 900): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const onMessage = (message: Buffer): void => {
      clearTimeout(timer)
      socket.removeListener('message', onMessage)
      resolve(message)
    }
    const timer = setTimeout(() => {
      socket.removeListener('message', onMessage)
      resolve(null)
    }, timeoutMs)
    socket.on('message', onMessage)
    sendRaw(socket, packet)
  })
}

describe('DHCP parse/build', () => {
  it('parses a DISCOVER packet and rebuilds an OFFER', () => {
    const discover = makePacket({ type: DHCP_MESSAGE_TYPE.discover, mac: 'AA:BB:CC:DD:EE:01', xid: 42, hostname: 'pc-1' })
    const parsed = parseDhcpPacket(discover)
    expect(parsed).not.toBeNull()
    expect(parsed?.messageType).toBe(DHCP_MESSAGE_TYPE.discover)
    expect(parsed?.mac).toBe('AA:BB:CC:DD:EE:01')
    expect(parsed?.hostname).toBe('pc-1')

    const offer = buildDhcpReply({
      request: parsed!,
      type: 'offer',
      serverIp: SERVER_IP,
      yiaddr: '192.168.50.100',
      subnetMask: '255.255.255.0',
      router: SERVER_IP,
      dns: SERVER_IP,
      broadcast: '192.168.50.255',
      leaseTimeSeconds: 3600
    })
    const parsedOffer = parseDhcpPacket(offer)
    expect(parsedOffer?.messageType).toBe(DHCP_MESSAGE_TYPE.offer)
    expect(parsedOffer?.yiaddr).toBe('192.168.50.100')
    expect(parsedOffer?.serverIdentifier).toBe(SERVER_IP)
  })

  it('rejects malformed packets', () => {
    expect(parseDhcpPacket(Buffer.from('not-dhcp'))).toBeNull()
    const tooSmall = Buffer.alloc(239)
    expect(parseDhcpPacket(tooSmall)).toBeNull()
    const badCookie = Buffer.alloc(240)
    expect(parseDhcpPacket(badCookie)).toBeNull()
  })
})

describe('DHCP server flow', () => {
  it('DISCOVER → OFFER, REQUEST → ACK and records a lease', async () => {
    const server = await startServer(baseConfig())
    const client = await bindClient()
    const mac = 'AA:BB:CC:DD:EE:01'
    const xid = 1001

    const offerRaw = await sendAndWait(client, makePacket({ type: DHCP_MESSAGE_TYPE.discover, mac, xid }))
    expect(offerRaw).not.toBeNull()
    const offer = parseDhcpPacket(offerRaw!)
    expect(offer?.messageType).toBe(DHCP_MESSAGE_TYPE.offer)
    expect(offer?.yiaddr).toBe('192.168.50.100')

    const ackRaw = await sendAndWait(
      client,
      makePacket({
        type: DHCP_MESSAGE_TYPE.request,
        mac,
        xid,
        requestedIp: offer!.yiaddr,
        serverId: SERVER_IP
      })
    )
    const ack = parseDhcpPacket(ackRaw!)
    expect(ack?.messageType).toBe(DHCP_MESSAGE_TYPE.ack)
    expect(ack?.yiaddr).toBe('192.168.50.100')
    expect(server.getLeases()).toHaveLength(1)
    expect(server.getLeases()[0]?.mac).toBe(mac)
  })

  it('ignores REQUEST for another DHCP server', async () => {
    await startServer(baseConfig())
    const client = await bindClient()
    const response = await sendAndWait(
      client,
      makePacket({
        type: DHCP_MESSAGE_TYPE.request,
        mac: 'AA:BB:CC:DD:EE:02',
        xid: 1002,
        requestedIp: '192.168.50.150',
        serverId: '192.168.50.99'
      }),
      400
    )
    expect(response).toBeNull()
  })

  it('reuses the same lease for the same MAC', async () => {
    const server = await startServer(baseConfig())
    const client = await bindClient()
    const mac = 'AA:BB:CC:DD:EE:03'
    const first = parseDhcpPacket(
      (await sendAndWait(client, makePacket({ type: DHCP_MESSAGE_TYPE.discover, mac, xid: 1 })))!
    )
    const second = parseDhcpPacket(
      (await sendAndWait(client, makePacket({ type: DHCP_MESSAGE_TYPE.discover, mac, xid: 2 })))!
    )
    expect(first?.yiaddr).toBe(second?.yiaddr)
    expect(server.getLeases()).toHaveLength(1)
  })

  it('does not offer when the pool is exhausted', async () => {
    const server = await startServer(baseConfig({ poolStart: '192.168.50.100', poolEnd: '192.168.50.100' }))
    const client = await bindClient()
    const first = await sendAndWait(
      client,
      makePacket({ type: DHCP_MESSAGE_TYPE.discover, mac: 'AA:BB:CC:DD:EE:04', xid: 1 })
    )
    expect(first).not.toBeNull()
    const second = await sendAndWait(
      client,
      makePacket({ type: DHCP_MESSAGE_TYPE.discover, mac: 'AA:BB:CC:DD:EE:05', xid: 2 }),
      400
    )
    expect(second).toBeNull()
    expect(server.getLeases()).toHaveLength(1)
  })

  it('excludes the host IP from allocation', async () => {
    await startServer(
      baseConfig({
        hostIp: '192.168.50.100',
        poolStart: '192.168.50.100',
        poolEnd: '192.168.50.101'
      })
    )
    const client = await bindClient()
    const offer = parseDhcpPacket(
      (await sendAndWait(client, makePacket({ type: DHCP_MESSAGE_TYPE.discover, mac: 'AA:BB:CC:DD:EE:06', xid: 1 })))!
    )
    expect(offer?.yiaddr).toBe('192.168.50.101')
  })

  it('ignores malformed packets and still answers valid requests', async () => {
    await startServer(baseConfig())
    const client = await bindClient()
    sendRaw(client, Buffer.from('garbage'))
    sendRaw(client, Buffer.alloc(30))
    const offer = await sendAndWait(
      client,
      makePacket({ type: DHCP_MESSAGE_TYPE.discover, mac: 'AA:BB:CC:DD:EE:07', xid: 7 })
    )
    expect(parseDhcpPacket(offer!)?.messageType).toBe(DHCP_MESSAGE_TYPE.offer)
  })

  it('releases a lease on DHCPRELEASE', async () => {
    const server = await startServer(baseConfig())
    const client = await bindClient()
    const mac = 'AA:BB:CC:DD:EE:08'
    const offer = parseDhcpPacket(
      (await sendAndWait(client, makePacket({ type: DHCP_MESSAGE_TYPE.discover, mac, xid: 1 })))!
    )
    expect(offer?.yiaddr).toBe('192.168.50.100')
    sendRaw(
      client,
      makePacket({
        type: DHCP_MESSAGE_TYPE.release,
        mac,
        xid: 2,
        ciaddr: offer!.yiaddr,
        serverId: SERVER_IP
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(server.getLeases()).toHaveLength(0)
  })

  it('ignores relayed requests (giaddr != 0)', async () => {
    await startServer(baseConfig())
    const client = await bindClient()
    const response = await sendAndWait(
      client,
      makePacket({
        type: DHCP_MESSAGE_TYPE.discover,
        mac: 'AA:BB:CC:DD:EE:09',
        xid: 9,
        giaddr: '10.0.0.1'
      }),
      400
    )
    expect(response).toBeNull()
  })
})

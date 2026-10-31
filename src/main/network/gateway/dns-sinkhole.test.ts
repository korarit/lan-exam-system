import { afterEach, describe, expect, it } from 'vitest'
import dgram from 'node:dgram'
import {
  DNS_RCODE,
  DnsSinkholeServer,
  buildDnsErrorResponse,
  buildDnsQuery,
  parseDnsQuery,
  parseDnsResponseCode,
  type DnsSinkholeConfig
} from './dns-sinkhole'

const DNS_PORT = 5353
const UPSTREAM_PORT = 5354
const DEAD_UPSTREAM_PORT = 5399

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

function baseConfig(patch: Partial<DnsSinkholeConfig> = {}): DnsSinkholeConfig {
  return {
    allowlist: ['allowed.test'],
    upstream: { address: '127.0.0.1', port: UPSTREAM_PORT },
    port: DNS_PORT,
    bindAddress: '127.0.0.1',
    timeoutMs: 250,
    ...patch
  }
}

async function startServer(config: DnsSinkholeConfig): Promise<DnsSinkholeServer> {
  const server = new DnsSinkholeServer(config)
  await server.start()
  CLEANUPS.push(() => server.stop())
  return server
}

function udpQuery(packet: Buffer, timeoutMs = 1200): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    let settled = false
    const finish = (value: Buffer | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // already closed
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.once('message', (message) => finish(message))
    socket.once('error', () => finish(null))
    socket.bind(0, '127.0.0.1', () => {
      socket.send(packet, DNS_PORT, '127.0.0.1')
    })
  })
}

async function startFakeUpstream(): Promise<dgram.Socket> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(UPSTREAM_PORT, '127.0.0.1', () => resolve())
  })
  socket.on('message', (message, rinfo) => {
    const response = Buffer.from(message)
    response.writeUInt16BE(0x8180, 2) // QR + RD + RA, NOERROR
    response.writeUInt16BE(0, 6)
    response.writeUInt16BE(0, 8)
    response.writeUInt16BE(0, 10)
    socket.send(response, rinfo.port, rinfo.address)
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

function queryPacket(id: number, name: string): Buffer {
  const packet = buildDnsQuery({ id, name })
  expect(packet).not.toBeNull()
  return packet!
}

describe('DNS parse/build', () => {
  it('parses a DNS question', () => {
    const parsed = parseDnsQuery(queryPacket(0x1234, 'allowed.test'))
    expect(parsed).not.toBeNull()
    expect(parsed?.id).toBe(0x1234)
    expect(parsed?.questions).toHaveLength(1)
    expect(parsed?.questions[0]).toEqual({ name: 'allowed.test', type: 1, class: 1 })
  })

  it('builds an NXDOMAIN response that keeps the question', () => {
    const parsed = parseDnsQuery(queryPacket(7, 'blocked.test'))!
    const response = buildDnsErrorResponse(parsed, DNS_RCODE.nxDomain)
    expect(parseDnsResponseCode(response)).toBe(DNS_RCODE.nxDomain)
    expect(parseDnsQuery(response)?.questions[0]?.name).toBe('blocked.test')
  })

  it('rejects malformed queries', () => {
    expect(parseDnsQuery(Buffer.from('x'))).toBeNull()
    expect(parseDnsQuery(Buffer.alloc(12))).not.toBeNull()
  })
})

describe('DNS sinkhole default deny', () => {
  it('returns NXDOMAIN for a domain outside the allowlist and logs it', async () => {
    const server = await startServer(baseConfig())
    const response = await udpQuery(queryPacket(11, 'chatgpt.example'))
    expect(response).not.toBeNull()
    expect(parseDnsResponseCode(response!)).toBe(DNS_RCODE.nxDomain)
    const log = server.getLog()
    expect(log).toHaveLength(1)
    expect(log[0]?.domain).toBe('chatgpt.example')
    expect(log[0]?.allowed).toBe(false)
    expect(log[0]?.action).toBe('blocked')
    expect(log[0]?.clientIp).toBe('127.0.0.1')
  })

  it('forwards an allowed domain to the injected upstream and relays the answer', async () => {
    await startFakeUpstream()
    const server = await startServer(baseConfig())
    const response = await udpQuery(queryPacket(12, 'docs.allowed.test'))
    expect(response).not.toBeNull()
    expect(parseDnsResponseCode(response!)).toBe(DNS_RCODE.noError)
    const log = server.getLog()
    expect(log).toHaveLength(1)
    expect(log[0]?.domain).toBe('docs.allowed.test')
    expect(log[0]?.allowed).toBe(true)
    expect(log[0]?.action).toBe('forwarded')
    expect(log[0]?.upstream).toBe(`127.0.0.1:${UPSTREAM_PORT}`)
  })

  it('returns SERVFAIL when the upstream fails and still logs the query', async () => {
    const server = await startServer(
      baseConfig({ upstream: { address: '127.0.0.1', port: DEAD_UPSTREAM_PORT }, timeoutMs: 150 })
    )
    const response = await udpQuery(queryPacket(13, 'allowed.test'))
    expect(response).not.toBeNull()
    expect(parseDnsResponseCode(response!)).toBe(DNS_RCODE.servFail)
    const log = server.getLog()
    expect(log).toHaveLength(1)
    expect(log[0]?.allowed).toBe(true)
    expect(log[0]?.action).toBe('servfail')
    expect(log[0]?.responseCode).toBe(DNS_RCODE.servFail)
  })

  it('blocks every query when the allowlist is empty', async () => {
    await startServer(baseConfig({ allowlist: [] }))
    const response = await udpQuery(queryPacket(14, 'allowed.test'))
    expect(parseDnsResponseCode(response!)).toBe(DNS_RCODE.nxDomain)
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { isPrivateOrLocalAddress, LocalConnectProxy } from './connect-proxy'
import type { DetectionEvent } from '@shared/policy-schema'

/* ============================================================
 * LocalConnectProxy — integration tests (Phase 5 — checklist 4.1)
 * - CONNECT โดเมนใน whitelist → 200 + ท่อถึง upstream จริง (ผ่าน resolveHost injector)
 * - CONNECT นอก whitelist → PROXY_DOMAIN_VIOLATION (block = 403 / warn = 200)
 * - CONNECT ด้วย IP ตรง → DIRECT_IP_PROXY_ATTEMPT เสมอ
 * - plain HTTP → forward ถึง upstream จริงเมื่ออนูญาต
 * ============================================================ */

const ECHO_MARK = 'ECHO:'

function waitForMatch(socket: net.Socket, needle: string, timeoutMs = 2_000): Promise<string> {
  let buffer = ''
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      if (buffer.includes(needle)) {
        cleanup()
        resolve(buffer)
      }
    }
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    socket.on('data', onData)
    socket.on('error', onError)
    setTimeout(() => {
      if (buffer.includes(needle)) return
      cleanup()
      reject(new Error(`timeout waiting for ${needle} / got: ${buffer.slice(0, 200)}`))
    }, timeoutMs)
  })
}

function connectToProxy(port: number, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

async function makeProxy(opts: {
  allowed: string[]
  enforcement: 'warn' | 'block'
  allowAnyPort?: boolean
  allowPrivateResolution?: boolean
}): Promise<{ proxy: LocalConnectProxy; events: DetectionEvent[]; allowedLog: string[]; port: number }> {
  const events: DetectionEvent[] = []
  const allowedLog: string[] = []
  const proxy = new LocalConnectProxy({
    getAllowedDomains: () => opts.allowed,
    getEnforcement: () => opts.enforcement,
    emit: (event) => events.push(event),
    logAllowed: (payload) => allowedLog.push(payload.url),
    resolveHost: () => Promise.resolve('127.0.0.1'),
    // test upstream เป็น echo server พอร์ตสุ่มบน loopback
    allowAnyPort: opts.allowAnyPort ?? true,
    allowPrivateResolution: opts.allowPrivateResolution ?? true,
    now: () => 1_700_000_000_000
  })
  const port = await proxy.listen()
  return { proxy, events, allowedLog, port }
}

let echoServer: net.Server
let echoPort: number

beforeAll(async () => {
  echoServer = net.createServer((socket) => {
    socket.on('data', (data) => {
      socket.write(`${ECHO_MARK}${data.toString('utf8')}`)
    })
  })
  await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve))
  echoPort = (echoServer.address() as net.AddressInfo).port
})

afterAll(() => {
  echoServer?.close()
})

describe('LocalConnectProxy', () => {
  it('CONNECT โดเมนใน whitelist → 200 + ท่อถึง upstream', async () => {
    const { proxy, events, allowedLog, port } = await makeProxy({ allowed: ['docs.python.org'], enforcement: 'block' })
    const socket = await connectToProxy(port, 'docs.python.org', echoPort)
    const response = await waitForMatch(socket, '200 Connection established')
    expect(response).toContain('200 Connection established')
    socket.write('ping\r\n')
    const echo = await waitForMatch(socket, `${ECHO_MARK}ping`)
    expect(echo).toContain(`${ECHO_MARK}ping`)
    expect(allowedLog.some((entry) => entry.startsWith('docs.python.org:'))).toBe(true)
    expect(events.filter((e) => e.code === 'PROXY_DOMAIN_VIOLATION' || e.code === 'DIRECT_IP_PROXY_ATTEMPT')).toHaveLength(0)
    socket.destroy()
    proxy.close()
  })

  it('CONNECT นอก whitelist + block → 403 Forbidden + event เสมอ (checklist 4.1)', async () => {
    const { proxy, events, port } = await makeProxy({ allowed: ['docs.python.org'], enforcement: 'block' })
    const socket = await connectToProxy(port, 'api.openai.com', 443)
    const response = await waitForMatch(socket, 'HTTP/1.1 403')
    expect(response).toContain('403 Forbidden')
    const violations = events.filter((event) => event.code === 'PROXY_DOMAIN_VIOLATION')
    expect(violations).toHaveLength(1)
    expect(violations[0]!.severity).toBe('critical')
    expect(violations[0]!.detail.hostname).toBe('api.openai.com:443')
    socket.destroy()
    proxy.close()
  })

  it('CONNECT นอก whitelist + report-only (warn) → เปิดท่อตามนโยบาย แต่ฟ้องไปเครื่องแม่', async () => {
    const { proxy, events, port } = await makeProxy({ allowed: ['docs.python.org'], enforcement: 'warn' })
    const socket = await connectToProxy(port, 'api.openai.com', echoPort)
    const response = await waitForMatch(socket, '200 Connection established')
    expect(response).toContain('200 Connection established')
    expect(events.filter((event) => event.code === 'PROXY_DOMAIN_VIOLATION')).toHaveLength(1)
    socket.destroy()
    proxy.close()
  })

  it('CONNECT ด้วย IP ตรง ๆ → DIRECT_IP_PROXY_ATTEMPT (กันหลบการตรวจโดเมน)', async () => {
    const { proxy, events, port } = await makeProxy({ allowed: ['docs.python.org'], enforcement: 'block' })
    // ส่ง CONNECT สู่ IP ของตัวเราเอง — ต้องถูกตัดเด็ดขาดแม้จะเป็น upstream ของเรา
    const socket = await connectToProxy(port, '127.0.0.1', echoPort)
    const response = await waitForMatch(socket, 'HTTP/1.1 403')
    expect(response).toContain('403')
    expect(events.filter((event) => event.code === 'DIRECT_IP_PROXY_ATTEMPT')).toHaveLength(1)
    socket.destroy()
    proxy.close()
  })

  it('plain HTTP ไปที่ upstream จริง + โดเมนอนุญาต', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('hello-from-upstream')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as net.AddressInfo).port
    const { proxy, allowedLog, events, port } = await makeProxy({ allowed: ['allowed.exam'], enforcement: 'block' })
    const requestThrough = (hostHeader: string): Promise<{ status: number | undefined; body: string }> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/exam.txt', headers: { host: hostHeader } },
          (res) => {
            let body = ''
            res.on('data', (chunk) => {
              body += chunk
            })
            res.on('end', () => resolve({ status: res.statusCode, body }))
          }
        )
        req.on('error', reject)
        req.end()
      })
    const allowed = await requestThrough(`allowed.exam:${upstreamPort}`)
    expect(allowed.status).toBe(200)
    expect(allowed.body).toBe('hello-from-upstream')
    expect(allowedLog.some((entry) => entry.includes('allowed.exam'))).toBe(true)
    // HTTP ไปที่ไม่อนุญาต → 403 + event
    const blocked = await requestThrough(`api.openai.com:${upstreamPort}`)
    expect(blocked.status).toBe(403)
    expect(events.filter((event) => event.code === 'PROXY_DOMAIN_VIOLATION')).toHaveLength(1)
    proxy.close()
    upstream.close()
  })

  it('listen() เป็น idempotent และ close() ปิดทุกท่อ', async () => {
    const { proxy, port } = await makeProxy({ allowed: ['docs.python.org'], enforcement: 'warn' })
    const again = await proxy.listen()
    expect(again).toBe(port)
    proxy.close()
    expect(proxy.isListening).toBe(false)
    expect(proxy.getBoundPort()).toBe(0)
  })

  it('VULN-56: โดเมนอนุญาตแต่พอร์ตนอก allowlist → 403 แม้ enforcement = warn', async () => {
    const { proxy, events, port } = await makeProxy({
      allowed: ['docs.python.org'],
      enforcement: 'warn',
      allowAnyPort: false,
      allowPrivateResolution: true
    })
    const socket = await connectToProxy(port, 'docs.python.org', 22)
    const response = await waitForMatch(socket, 'HTTP/1.1 403')
    expect(response).toContain('403')
    expect(events.some((event) => event.code === 'PROXY_DOMAIN_VIOLATION' && event.detail.reason === 'port-not-allowed')).toBe(true)
    socket.destroy()
    proxy.close()
  })

  it('VULN-56: DNS rebinding ไป loopback/private → DIRECT_IP_PROXY_ATTEMPT', async () => {
    const { proxy, events, port } = await makeProxy({
      allowed: ['docs.python.org'],
      enforcement: 'warn',
      allowAnyPort: true,
      allowPrivateResolution: false
    })
    const socket = await connectToProxy(port, 'docs.python.org', 443)
    const response = await waitForMatch(socket, 'HTTP/1.1 403')
    expect(response).toContain('403')
    expect(events.some((event) => event.code === 'DIRECT_IP_PROXY_ATTEMPT' && event.detail.reason === 'private-resolution')).toBe(true)
    socket.destroy()
    proxy.close()
  })
})

describe('isPrivateOrLocalAddress', () => {
  it('แยก private/loopback/link-local ออกจาก public', () => {
    expect(isPrivateOrLocalAddress('127.0.0.1')).toBe(true)
    expect(isPrivateOrLocalAddress('10.0.0.5')).toBe(true)
    expect(isPrivateOrLocalAddress('192.168.1.20')).toBe(true)
    expect(isPrivateOrLocalAddress('172.16.5.5')).toBe(true)
    expect(isPrivateOrLocalAddress('169.254.1.1')).toBe(true)
    expect(isPrivateOrLocalAddress('::1')).toBe(true)
    expect(isPrivateOrLocalAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateOrLocalAddress('8.8.8.8')).toBe(false)
    expect(isPrivateOrLocalAddress('104.18.32.7')).toBe(false)
  })
})

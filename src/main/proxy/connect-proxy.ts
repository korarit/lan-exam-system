import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns/promises'
import { makeDetectionEvent } from '../guard/process-inspector'
import { evaluateHostnameAgainstWhitelist } from '../browser/url-filter'
import type { DetectionEvent, DomainEnforcement } from '@shared/policy-schema'
import type { DocsUrlLogPayload } from '@shared/protocol-schema'

/* ============================================================
 * LocalConnectProxy (Phase 5 — Mode 3)
 * - HTTP CONNECT + plain-HTTP proxy ผูกเฉพาะ 127.0.0.1:<พอร์ตสุ่ม>
 * - Default-deny: เทียบโดเมนกับ policy.allowedDomains เสมอ
 * - Resolve DNS เอง (ไม่พึ่ง SNI เพราะ ECH ซ่อน SNI ได้)
 * - ห้ามต่อด้วย IP ตรง ๆ → DIRECT_IP_PROXY_ATTEMPT (กันหลบการตรวจชื่อโดเมน)
 * - โหมดจาก Signed Policy: 'warn' (report-only) = บันทึก + ฟ้อง แต่ยังเชื่อมท่อ;
 *   'block' (block-and-report) = ตอบ 403 และปิดทันที
 * - โดเมนอนุญาตที่ใช้จริงขอบันทึกเป็นประวัติ (DOCS_URL_LOG source 'proxy')
 * ============================================================ */

export interface LocalConnectProxyOptions {
  /** รายการโดเมนอนุญาตล่าสุด (อ่านสดเพื่อรับ POLICY_UPDATE ระหว่างสอบ) */
  getAllowedDomains: () => string[]
  /** นโยบายบังคับใช้ของห้อง (warn = report-only) */
  getEnforcement: () => DomainEnforcement
  emit: (event: DetectionEvent) => void
  /** โดเมนอนุญาตถูกใช้จริง → ประวัติ (ไม่เป็น event ตรวจจับ) */
  logAllowed: (payload: DocsUrlLogPayload) => void
  /** inject ตอนทดสอบ (default: dns.lookup) — คืน IP หรือ null หากแก้ไม่ได้ */
  resolveHost?: (hostname: string) => Promise<string | null>
  /** VULN-56: พอร์ตที่อนุญาตให้ CONNECT (default 80/443/8080/8443) */
  allowedPorts?: readonly number[]
  /** ใช้เฉพาะ test ที่ต้องต่อ upstream พอร์ตสุ่ม */
  allowAnyPort?: boolean
  /** ใช้เฉพาะ test — production ต้องปฏิเสธ private/loopback resolution (DNS rebinding) */
  allowPrivateResolution?: boolean
  now: () => number
}

const DEFAULT_ALLOWED_PORTS = [80, 443, 8080, 8443] as const

/** ที่อยู่ private/loopback/link-local — ใช้กัน DNS rebinding ไปอุปกรณ์ใน LAN */
export function isPrivateOrLocalAddress(address: string): boolean {
  const normalized = address.trim().replace(/^\[|\]$/g, '')
  if (normalized === '' || normalized === '::1' || normalized === '::' || normalized === '0.0.0.0') {
    return true
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(normalized)
  const ipv4 = (mapped?.[1] ?? normalized).trim()
  const parts = ipv4.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = parts as [number, number, number, number]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  const lower = normalized.toLowerCase()
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')
}

interface OpenTunnel {
  upstream: net.Socket
  client: net.Socket
}

export class LocalConnectProxy {
  private readonly tunnels = new Set<OpenTunnel>()
  private server: http.Server | null = null
  private boundPort: number | null = null

  constructor(private readonly opts: LocalConnectProxyOptions) {}

  get isListening(): boolean {
    return this.server !== null
  }

  /** พอร์ตที่ bind แล้ว (0 = ยังไม่ทำงาน) */
  getBoundPort(): number {
    return this.boundPort ?? 0
  }

  /** เปิด HTTP server ที่ 127.0.0.1:0 — idempotent */
  async listen(): Promise<number> {
    if (this.server) return this.boundPort ?? 0
    const server = http.createServer((req, res) => {
      void this.handlePlainRequest(req, res)
    })
    server.on('connect', (req, clientSocket, head) => {
      void this.handleConnect(req, clientSocket as net.Socket, head)
    })
    server.on('clientError', (_err, socket) => {
      try {
        socket.destroy()
      } catch {
        // socket ปิดไปแล้ว — ไม่มีอะไรทำ
      }
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    this.boundPort = address && typeof address === 'object' ? address.port : 0
    return this.boundPort
  }

  /** ปิดทั้งหมด — ถอดทุก tunnel + หยุด server */
  close(): void {
    for (const tunnel of this.tunnels) this.destroyTunnel(tunnel)
    const server = this.server
    this.server = null
    this.boundPort = null
    if (server) {
      server.close()
    }
  }

  private destroyTunnel(tunnel: OpenTunnel): void {
    this.tunnels.delete(tunnel)
    for (const socket of [tunnel.upstream, tunnel.client]) {
      try {
        socket.destroy()
      } catch {
        // socket ปิดไปแล้ว
      }
    }
  }

  private resolveIp(hostname: string): Promise<string | null> {
    if (this.opts.resolveHost) return this.opts.resolveHost(hostname)
    return dns
      .lookup(hostname)
      .then((entry) => entry.address)
      .catch(() => null)
  }

  private allowedPorts(): readonly number[] {
    return this.opts.allowedPorts ?? DEFAULT_ALLOWED_PORTS
  }

  /** VULN-56: ตรวจพอร์ตก่อนเปิดท่อ (กันใช้โดเมนที่อนุญาตเป็น SSH/VNC relay) */
  private isPortAllowed(port: number): boolean {
    if (this.opts.allowAnyPort === true) return true
    return this.allowedPorts().includes(port)
  }

  /** เปิดท่อไปปลายทางด้วย IP ที่ resolve เอง (คืน null ถ้าต่อไม่สำเร็จ) */
  private openUpstreamTo(ip: string, port: number): Promise<net.Socket | null> {
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(port, ip)
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
  }

  /**
   * resolve + ตรวจ DNS rebinding (private/loopback) ก่อนต่อ
   * คืน null = ต้องปฏิเสธ (emit event แล้ว)
   */
  private async resolveSafe(hostname: string, portText: string): Promise<string | null> {
    const ip = await this.resolveIp(hostname)
    if (!ip) return null
    if (this.opts.allowPrivateResolution !== true && isPrivateOrLocalAddress(ip)) {
      this.opts.emit(
        makeDetectionEvent(
          'DIRECT_IP_PROXY_ATTEMPT',
          'connect-proxy',
          {
            hostname: `${hostname}:${portText || '80'}`,
            reason: 'private-resolution',
            resolvedIp: ip.slice(0, 60),
            mode: this.opts.getEnforcement()
          },
          undefined,
          this.opts.now
        )
      )
      return null
    }
    return ip
  }

  private tunnelTo(clientSocket: net.Socket, head: Buffer, upstream: net.Socket): void {
    const pair: OpenTunnel = { upstream, client: clientSocket }
    this.tunnels.add(pair)
    const disconnect = (): void => {
      this.tunnels.delete(pair)
      this.destroyTunnel(pair)
    }
    upstream.on('error', disconnect)
    clientSocket.on('error', disconnect)
    if (head.length > 0) upstream.write(head)
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  }

  private replyProxyError(clientSocket: net.Socket, status: 'forbidden' | 'fail'): void {
    const text =
      status === 'forbidden'
        ? 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
        : 'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
    try {
      clientSocket.end(text)
    } catch {
      // socket วาย — ปล่อย
    }
  }

  /** ประเมินโดเมน/พอร์ตเป้าหมาย → event + คืนว่าจะบล็อกหรือไม่ */
  private judgeTarget(hostname: string, portText: string): boolean {
    const port = Number.parseInt(portText, 10)
    const verdict = evaluateHostnameAgainstWhitelist(hostname, this.opts.getAllowedDomains())
    if (verdict === 'allowed') {
      // VULN-56: โดเมนผ่านแต่พอร์ตนอก allowlist = บล็อกเสมอ (ไม่ขึ้นกับ warn/block)
      if (!this.isPortAllowed(port)) {
        this.opts.emit(
          makeDetectionEvent('PROXY_DOMAIN_VIOLATION', 'connect-proxy', {
            hostname: `${hostname}:${portText || '?'}`,
            reason: 'port-not-allowed',
            mode: this.opts.getEnforcement()
          }, undefined, this.opts.now)
        )
        return true
      }
      this.opts.logAllowed({
        url: `${hostname}:${portText || '?'}`,
        source: 'proxy',
        topDomain: hostname,
        occurredAtMs: this.opts.now()
      })
      return false
    }
    const code = verdict === 'direct-ip' ? 'DIRECT_IP_PROXY_ATTEMPT' : 'PROXY_DOMAIN_VIOLATION'
    this.opts.emit(
      makeDetectionEvent(code, 'connect-proxy', {
        hostname: `${hostname}:${portText || '80'}`,
        mode: this.opts.getEnforcement()
      }, undefined, this.opts.now)
    )
    return this.opts.getEnforcement() === 'block'
  }

  private async handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): Promise<void> {
    clientSocket.on('error', () => {
      try {
        clientSocket.destroy()
      } catch {
        // ปล่อย — socket ปิดไปแล้ว
      }
    })
    const target = req.url ?? ''
    const colon = target.lastIndexOf(':')
    const hostname = colon >= 0 ? target.slice(0, colon) : target
    const portText = colon >= 0 ? target.slice(colon + 1) : ''
    const port = Number.parseInt(portText, 10)
    if (!hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
      this.replyProxyError(clientSocket, 'fail')
      return
    }
    if (this.judgeTarget(hostname, portText)) {
      this.replyProxyError(clientSocket, 'forbidden')
      return
    }
    try {
      // resolve เอง + กัน DNS rebinding ไป private/loopback
      const ip = await this.resolveSafe(hostname, portText)
      if (!ip) {
        this.replyProxyError(clientSocket, 'forbidden')
        return
      }
      const upstream = await this.openUpstreamTo(ip, port)
      if (!upstream) {
        this.replyProxyError(clientSocket, 'fail')
        return
      }
      try {
        clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n')
        this.tunnelTo(clientSocket, head, upstream)
      } catch {
        upstream.destroy()
        this.replyProxyError(clientSocket, 'fail')
      }
    } catch {
      this.replyProxyError(clientSocket, 'fail')
    }
  }

  /** plain HTTP: ตรวจ host ก่อนแล้ว forward ทั้ง request/response (resolve DNS เอง) */
  private async handlePlainRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const hostHeader = req.headers.host ?? ''
    const colon = hostHeader.indexOf(':')
    const hostname = colon >= 0 ? hostHeader.slice(0, colon) : hostHeader
    const portText = colon >= 0 ? hostHeader.slice(colon + 1) : ''
    const rawUrl = req.url ?? '/'
    if (hostname === '' || !/^\d{0,5}$/.test(portText)) {
      res.writeHead(400)
      res.end()
      return
    }
    if (this.judgeTarget(hostname, portText)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('ไม่อนุญาตให้เข้าถึงเว็บนี้ระหว่างการสอบ')
      return
    }
    try {
      // resolve DNS เองด้วยชั้น resolveIp เสมอ — แล้ว request ไปที่ IP โดยตรง
      // (โฮสต์จริงคงอยู่ใน header host ให้ upstream เห็นเดิม)
      const ip = await this.resolveSafe(hostname, portText)
      if (!ip) throw new Error('DNS_LOOKUP_FAILED')
      const portForUrl = portText !== '' ? `:${portText}` : ''
      const upstreamReq = http.request(`http://${ip}${portForUrl}${rawUrl}`, {
        method: req.method,
        headers: { ...req.headers, host: hostHeader }
      })
      upstreamReq.on('response', (upstreamRes) => {
        try {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
          upstreamRes.pipe(res)
        } catch {
          try {
            res.destroy()
          } catch {
            // ปล่อย
          }
        }
      })
      upstreamReq.on('error', () => {
        try {
          if (res.headersSent) {
            res.destroy()
            return
          }
          res.writeHead(502)
          res.end()
        } catch {
          // ปล่อย
        }
      })
      req.pipe(upstreamReq)
    } catch {
      try {
        res.writeHead(502)
        res.end()
      } catch {
        // ปล่อย
      }
    }
  }
}

import dgram from 'node:dgram'
import {
  GATEWAY_DNS_PORT,
  MAX_GATEWAY_DNS_LOG,
  type GatewayDnsLogEntry
} from '@shared/gateway'

/* ============================================================
 * DNS sinkhole / forwarder (UDP 53)
 * - default deny: ทุกคำถามได้ NXDOMAIN ยกเว้นโดเมนใน allowlist
 * - โดเมนที่อนุญาต forward ไป upstream แล้ว relay คำตอบกลับ
 * - log ทุก query เป็น structured event (domain/client/allowed)
 * - ไม่ทำ TCP DNS (MVP) — client ที่ต้องการ TCP จะถูกปล่อย fail เอง
 * ============================================================ */

export const DNS_RCODE = {
  noError: 0,
  formErr: 1,
  servFail: 2,
  nxDomain: 3,
  notImp: 4,
  refused: 5
} as const

export interface DnsQuestion {
  name: string
  type: number
  class: number
}

export interface ParsedDnsQuery {
  id: number
  flags: number
  opcode: number
  questions: DnsQuestion[]
  /** bytes ของ question section ทั้งหมด (ใช้สร้าง error response) */
  questionBytes: Buffer
}

const MAX_NAME_LENGTH = 253
const MAX_POINTER_HOPS = 32

function readName(buffer: Buffer, startOffset: number): { name: string; nextOffset: number } | null {
  const labels: string[] = []
  let offset = startOffset
  let nextOffset = -1
  let hops = 0
  let length = 0
  while (offset < buffer.length) {
    const octet = buffer.readUInt8(offset)
    if ((octet & 0xc0) === 0xc0) {
      if (offset + 1 >= buffer.length) return null
      const pointer = ((octet & 0x3f) << 8) | buffer.readUInt8(offset + 1)
      if (nextOffset === -1) nextOffset = offset + 2
      if (pointer >= buffer.length || hops >= MAX_POINTER_HOPS) return null
      hops += 1
      offset = pointer
      continue
    }
    if (octet === 0) {
      offset += 1
      if (nextOffset === -1) nextOffset = offset
      break
    }
    if ((octet & 0xc0) !== 0) return null // reserved label type
    const labelLength = octet
    if (labelLength > 63 || offset + 1 + labelLength > buffer.length) return null
    const label = buffer.toString('latin1', offset + 1, offset + 1 + labelLength)
    labels.push(label)
    length += labelLength + 1
    if (length > MAX_NAME_LENGTH) return null
    offset += 1 + labelLength
  }
  if (nextOffset === -1) return null
  return { name: labels.join('.'), nextOffset }
}

/** Parse DNS header + question section — คืน null เมื่อ malformed */
export function parseDnsQuery(buffer: Buffer): ParsedDnsQuery | null {
  if (buffer.length < 12) return null
  const id = buffer.readUInt16BE(0)
  const flags = buffer.readUInt16BE(2)
  const opcode = (flags >> 11) & 0x0f
  const questionCount = buffer.readUInt16BE(4)
  if (questionCount > 16) return null
  const questions: DnsQuestion[] = []
  let offset = 12
  const questionStart = offset
  for (let index = 0; index < questionCount; index += 1) {
    const parsed = readName(buffer, offset)
    if (!parsed) return null
    offset = parsed.nextOffset
    if (offset + 4 > buffer.length) return null
    const type = buffer.readUInt16BE(offset)
    const klass = buffer.readUInt16BE(offset + 2)
    offset += 4
    questions.push({ name: parsed.name, type, class: klass })
  }
  return {
    id,
    flags,
    opcode,
    questions,
    questionBytes: Buffer.from(buffer.subarray(questionStart, offset))
  }
}

function encodeName(name: string): Buffer | null {
  const normalized = name.replace(/\.$/, '')
  if (normalized.length === 0 || normalized.length > MAX_NAME_LENGTH) return null
  const parts = normalized.split('.')
  const chunks: Buffer[] = []
  for (const part of parts) {
    if (part.length === 0 || part.length > 63) return null
    const label = Buffer.from(part, 'latin1')
    chunks.push(Buffer.from([label.length]), label)
  }
  chunks.push(Buffer.from([0]))
  return Buffer.concat(chunks)
}

/** สร้าง DNS query (ใช้ใน test / upstream probe) */
export function buildDnsQuery(input: {
  id: number
  name: string
  type?: number
  class?: number
  flags?: number
}): Buffer | null {
  const encoded = encodeName(input.name)
  if (!encoded) return null
  const header = Buffer.alloc(12)
  header.writeUInt16BE(input.id & 0xffff, 0)
  header.writeUInt16BE(input.flags ?? 0x0100, 2) // RD
  header.writeUInt16BE(1, 4)
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(input.type ?? 1, 0)
  tail.writeUInt16BE(input.class ?? 1, 2)
  return Buffer.concat([header, encoded, tail])
}

/** สร้าง error response (NXDOMAIN/SERVFAIL/FORMERR) จาก parsed query */
export function buildDnsErrorResponse(query: ParsedDnsQuery, rcode: number): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(query.id, 0)
  const flags =
    0x8000 | // QR
    (query.flags & 0x7800) | // opcode
    (query.flags & 0x0100) | // RD
    0x0080 | // RA
    (rcode & 0x0f)
  header.writeUInt16BE(flags, 2)
  header.writeUInt16BE(query.questions.length, 4)
  header.writeUInt16BE(0, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)
  return Buffer.concat([header, query.questionBytes])
}

/** error response สำหรับ packet ที่ parse ไม่ครบ (ยังอ่าน id ได้) */
export function buildRawDnsErrorResponse(buffer: Buffer, rcode: number): Buffer | null {
  if (buffer.length < 12) return null
  const header = Buffer.alloc(12)
  buffer.copy(header, 0, 0, 2)
  const flags = buffer.readUInt16BE(2)
  header.writeUInt16BE(
    0x8000 | (flags & 0x7800) | (flags & 0x0100) | 0x0080 | (rcode & 0x0f),
    2
  )
  return header
}

export function parseDnsResponseCode(buffer: Buffer): number | null {
  if (buffer.length < 12) return null
  return buffer.readUInt16BE(2) & 0x0f
}

/** normalize ชื่อโดเมนสำหรับ allowlist (lowercase, no trailing dot, no leading wildcard) */
export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\*\./, '')
}

function isAllowedDomain(domain: string, allowlist: string[]): boolean {
  const target = normalizeDomain(domain)
  if (target.length === 0) return false
  for (const raw of allowlist) {
    const entry = normalizeDomain(raw)
    if (entry === '*') return true
    if (entry.length === 0) continue
    if (target === entry || target.endsWith(`.${entry}`)) return true
  }
  return false
}

export interface DnsSinkholeConfig {
  allowlist: string[]
  upstream: { address: string; port: number }
  /** default 53 — test ใช้พอร์ตสูง */
  port?: number
  bindAddress?: string
  /** default 2500ms */
  timeoutMs?: number
  onQuery?: (entry: GatewayDnsLogEntry) => void
  onError?: (error: Error) => void
}

export class DnsSinkholeServer {
  private socket: dgram.Socket | null = null
  private readonly log: GatewayDnsLogEntry[] = []
  private readonly port: number
  private readonly bindAddress: string
  private readonly timeoutMs: number

  constructor(private readonly config: DnsSinkholeConfig) {
    this.port = config.port ?? GATEWAY_DNS_PORT
    this.bindAddress = config.bindAddress ?? '0.0.0.0'
    this.timeoutMs = config.timeoutMs ?? 2500
  }

  /** bind UDP 53 — reject พร้อมคำใบ้เรื่องสิทธิ์/พอร์ต */
  start(): Promise<void> {
    if (this.socket) return Promise.resolve()
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    return new Promise<void>((resolve, reject) => {
      const onBindError = (error: Error): void => {
        this.socket = null
        try {
          socket.close()
        } catch {
          // ปิดไปแล้ว
        }
        reject(
          new Error(
            `DNS_BIND_FAILED: ${error.message} (ต้องรันเครื่องแม่แบบ Administrator/root และพอร์ต UDP ${this.port} ต้องว่าง)`
          )
        )
      }
      socket.once('error', onBindError)
      socket.bind({ port: this.port, address: this.bindAddress }, () => {
        socket.removeListener('error', onBindError)
        socket.on('error', (error) => this.config.onError?.(error))
        resolve()
      })
      socket.on('message', (message, rinfo) => {
        void this.handleMessage(message, rinfo)
      })
    })
  }

  stop(): void {
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        // ปิดไปแล้ว
      }
    }
    this.socket = null
  }

  getLog(): GatewayDnsLogEntry[] {
    return [...this.log]
  }

  /* ---------- internals ---------- */

  private async handleMessage(message: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    const parsed = parseDnsQuery(message)
    if (!parsed) {
      this.record({
        atMs: Date.now(),
        domain: '<malformed>',
        qtype: 0,
        qclass: 0,
        clientIp: rinfo.address,
        allowed: false,
        action: 'malformed',
        responseCode: DNS_RCODE.formErr,
        upstream: null
      })
      const raw = buildRawDnsErrorResponse(message, DNS_RCODE.formErr)
      if (raw) this.send(raw, rinfo)
      return
    }
    if ((parsed.flags & 0x8000) !== 0) return // response packet — ไม่ใช่ query
    if (parsed.opcode !== 0 || parsed.questions.length === 0) {
      this.send(buildDnsErrorResponse(parsed, DNS_RCODE.formErr), rinfo)
      return
    }

    const question = parsed.questions[0]!
    const allowed = parsed.questions.every((q) => isAllowedDomain(q.name, this.config.allowlist))
    if (!allowed) {
      const response = buildDnsErrorResponse(parsed, DNS_RCODE.nxDomain)
      this.send(response, rinfo)
      this.record({
        atMs: Date.now(),
        domain: question.name,
        qtype: question.type,
        qclass: question.class,
        clientIp: rinfo.address,
        allowed: false,
        action: 'blocked',
        responseCode: DNS_RCODE.nxDomain,
        upstream: null
      })
      return
    }

    const upstream = `${this.config.upstream.address}:${this.config.upstream.port}`
    const forwarded = await this.forward(message)
    if (!forwarded) {
      const response = buildDnsErrorResponse(parsed, DNS_RCODE.servFail)
      this.send(response, rinfo)
      this.record({
        atMs: Date.now(),
        domain: question.name,
        qtype: question.type,
        qclass: question.class,
        clientIp: rinfo.address,
        allowed: true,
        action: 'servfail',
        responseCode: DNS_RCODE.servFail,
        upstream
      })
      return
    }
    this.send(forwarded, rinfo)
    this.record({
      atMs: Date.now(),
      domain: question.name,
      qtype: question.type,
      qclass: question.class,
      clientIp: rinfo.address,
      allowed: true,
      action: 'forwarded',
      responseCode: parseDnsResponseCode(forwarded) ?? DNS_RCODE.noError,
      upstream
    })
  }

  private forward(message: Buffer): Promise<Buffer | null> {
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
          // ปิดไปแล้ว
        }
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), this.timeoutMs)
      timer.unref?.()
      socket.once('error', (error) => {
        this.config.onError?.(error)
        finish(null)
      })
      socket.once('message', (response) => finish(response))
      socket.send(message, this.config.upstream.port, this.config.upstream.address, (error) => {
        if (error) finish(null)
      })
    })
  }

  private send(response: Buffer, rinfo: dgram.RemoteInfo): void {
    const socket = this.socket
    if (!socket) return
    socket.send(response, rinfo.port, rinfo.address, (error) => {
      if (error) this.config.onError?.(error)
    })
  }

  private record(entry: GatewayDnsLogEntry): void {
    this.log.push(entry)
    if (this.log.length > MAX_GATEWAY_DNS_LOG) {
      this.log.splice(0, this.log.length - MAX_GATEWAY_DNS_LOG)
    }
    this.config.onQuery?.(entry)
  }
}

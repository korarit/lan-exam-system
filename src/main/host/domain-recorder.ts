import { domainToUnicode } from 'node:url'
import type { Session } from 'electron'
import type { DomainEnforcement } from '@shared/policy-schema'

/* ============================================================
 * DomainRecorder (Phase 3a-plus)
 * - โหมด record: hook ทุก request ที่หน้า Doc Preview (เครื่องแม่) เรียกจริง
 *   → normalize → dedupe ต่อ (domain, topDomain) → นับ hits → flush ลง DB ทุก 3 วินาที
 * - โหมด enforce: ตรวจทุก request กับ allowedDomains (exact/subdomain)
 *   ไม่อนุมัติ → warn (ปล่อยผ่าน + event) หรือ block (cancel + event)
 * - การบันทึกเกิดที่เครื่องแม่ล้วน ๆ — ไม่มี network message ใหม่
 * ============================================================ */

export type RecordedDomainSource = 'preview' | 'top-url'

export interface RecordedDomainRecord {
  domain: string
  topDomain: string
  source: RecordedDomainSource
  hits: number
  firstSeenMs: number
  lastSeenMs: number
}

export interface DomainRecorderOptions {
  /** เรียกตอน flush (ทุก 3 วินาที / ตอน detach) — ผูกกับ DomainAllowlistService.recordBatch */
  onFlush: (records: RecordedDomainRecord[]) => void
  flushIntervalMs?: number
  now?: () => number
  /** IP ของเครื่องแม่เอง (ไม่ record — กัน noise จากตัวแอป) */
  localAddresses?: string[]
  /** โหมด enforce: แจ้งเมื่อพยายามเข้าโดเมนที่ไม่อนุมัติ */
  onUnauthorized?: (detail: { domain: string; topDomain: string; action: DomainEnforcement }) => void
}

const NOISE_SCHEMES = new Set(['data:', 'blob:', 'devtools:', 'chrome-extension:', 'about:', 'file:'])

/** punycode → unicode + lowercase + ตัด port (IP literal คืนตามเดิม) */
export function normalizeHostname(raw: string): string {
  let host = raw.trim().toLowerCase()
  if (host.startsWith('[') && host.includes(']')) {
    host = host.slice(1, host.indexOf(']'))
    return host
  }
  const portIndex = host.lastIndexOf(':')
  if (portIndex > 0 && host.indexOf(':') === portIndex) {
    host = host.slice(0, portIndex)
  }
  host = host.replace(/\.$/, '')
  if (isIpLiteral(host)) return host
  try {
    const unicode = domainToUnicode(host)
    return (unicode || host).toLowerCase()
  } catch {
    return host
  }
}

export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/** ดึง hostname จาก URL (คืน null ถ้า scheme ไม่ใช่ http/https หรือไม่มี host) */
export function extractHostname(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname) return null
    return normalizeHostname(parsed.hostname)
  } catch {
    return null
  }
}

/** request ที่เป็น noise ของตัวแอป (loopback / data / blob ฯลฯ) — ไม่ record */
export function isNoiseUrl(url: string, localAddresses: ReadonlySet<string>): boolean {
  const schemeMatch = /^([a-z0-9+.-]+):/i.exec(url.trim())
  if (schemeMatch && NOISE_SCHEMES.has(`${schemeMatch[1]!.toLowerCase()}:`)) return true
  const host = extractHostname(url)
  if (host === null) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.startsWith('127.') || host === '::1' || host === '0.0.0.0') return true
  if (localAddresses.has(host)) return true
  return false
}

/** ตรวจว่า hostname อยู่ในรายการอนุญาต (exact หรือ subdomain ลูก) */
export function isDomainAllowed(
  hostname: string,
  allowedDomains: Iterable<string>
): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  for (const allowed of allowedDomains) {
    const a = allowed.toLowerCase()
    if (host === a || host.endsWith(`.${a}`)) return true
  }
  return false
}

export class DomainRecorder {
  private mode: 'record' | 'enforce' = 'record'
  private enforcement: DomainEnforcement = 'warn'
  private readonly pending = new Map<string, RecordedDomainRecord>()
  private readonly allowed = new Set<string>()
  private readonly localAddresses: ReadonlySet<string>
  private readonly flushIntervalMs: number
  private readonly now: () => number
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private readonly opts: DomainRecorderOptions) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 3_000
    this.now = opts.now ?? Date.now
    this.localAddresses = new Set((opts.localAddresses ?? []).map((ip) => ip.toLowerCase()))
  }

  /* ---------- โหมด record (ครูเปิดเองที่เครื่องแม่) ---------- */

  startRecord(): void {
    this.mode = 'record'
    this.startFlushTimer()
  }

  /** โดเมนของ URL ชั้นบนที่ครูเปิด (auto-approved ที่ตัว service จัดการ) */
  recordRequest(url: string, topUrl: string | null): void {
    if (this.mode !== 'record') return
    if (isNoiseUrl(url, this.localAddresses)) return
    const domain = extractHostname(url)
    if (!domain) return
    const topDomain = (topUrl !== null ? extractHostname(topUrl) : null) ?? domain
    this.stage(domain, topDomain, 'preview')
  }

  /** โดเมนของหน้าชั้นบนที่ครูกรอก (source 'top-url' — auto-approve ที่ service) */
  recordTopUrl(url: string): void {
    const domain = extractHostname(url)
    if (!domain || isNoiseUrl(url, this.localAddresses)) return
    this.stage(domain, domain, 'top-url')
  }

  /** IP literal เก็บเป็น "IP:1.2.3.4" — UI แสดงแยกหมวดให้ครูระวังตัดสิน */
  private stageKeyDomain(domain: string): string {
    return isIpLiteral(domain) ? `IP:${domain}` : domain
  }

  private stage(domain: string, topDomain: string, source: RecordedDomainSource): void {
    const keyDomain = this.stageKeyDomain(domain)
    const key = `${keyDomain}|${topDomain}|${source}`
    const ts = this.now()
    const existing = this.pending.get(key)
    if (existing) {
      existing.hits += 1
      existing.lastSeenMs = ts
      return
    }
    this.pending.set(key, {
      domain: keyDomain,
      topDomain,
      source,
      hits: 1,
      firstSeenMs: ts,
      lastSeenMs: ts
    })
  }

  /* ---------- โหมด enforce (นักเรียนใช้งานจริง — WebContentsView ของ Mode 2) ---------- */

  startEnforce(allowedDomains: string[], enforcement: DomainEnforcement): void {
    this.mode = 'enforce'
    this.setAllowedDomains(allowedDomains)
    this.enforcement = enforcement
    this.startFlushTimer()
  }

  setAllowedDomains(domains: string[]): void {
    this.allowed.clear()
    for (const d of domains) this.allowed.add(d.toLowerCase())
  }

  setEnforcement(mode: DomainEnforcement): void {
    this.enforcement = mode
  }

  get enforcementMode(): DomainEnforcement {
    return this.enforcement
  }

  get phase(): 'record' | 'enforce' {
    return this.mode
  }

  /**
   * ตรวจ request ในโหมด enforce:
   * - อยู่ใน allowed (exact/subdomain) → { allowed: true }
   * - ไม่อยู่ → warn = ปล่อยผ่าน + event / block = { allowed: false } (ผู้เรียก cancel: true)
   */
  decide(url: string, topUrl: string | null): { allowed: boolean; domain: string | null } {
    if (isNoiseUrl(url, this.localAddresses)) return { allowed: true, domain: null }
    const domain = extractHostname(url)
    if (!domain) return { allowed: true, domain: null }
    if (isDomainAllowed(domain, this.allowed)) {
      return { allowed: true, domain }
    }
    const topDomain = (topUrl !== null ? extractHostname(topUrl) : null) ?? domain
    // ยังบันทึก hits ของความพยายามที่ไม่อนุมัติ (host ผูก DB ได้ / student ทิ้งก็ได้)
    this.stage(domain, topDomain, 'preview')
    this.opts.onUnauthorized?.({ domain, topDomain, action: this.enforcement })
    return { allowed: this.enforcement !== 'block', domain }
  }

  /* ---------- flush lifecycle ---------- */

  private startFlushTimer(): void {
    this.stopFlushTimer()
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs)
    this.flushTimer.unref?.()
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  /** ส่งรายการค้างให้ผู้รับ (DB ฝั่งเครื่องแม่) แล้วเคลียร์ */
  flush(): void {
    if (this.pending.size === 0) return
    const records = [...this.pending.values()]
    this.pending.clear()
    this.opts.onFlush(records)
  }

  /** flush รายการค้างก่อนถอด + หยุด timer */
  detach(): void {
    this.stopFlushTimer()
    this.flush()
  }
}

/* ============================================================
 * Electron adapter — ผูกกับ session ของ WebContentsView ตัวจริง
 * (แยกจาก core เพื่อให้ unit test ได้โดยไม่ต้องมี Electron)
 * ============================================================ */

export class DomainRecorderHook {
  private readonly handler = (details: { url: string }): void => {
    if (this.recorder === null) return
    const topUrl = this.getTopUrl()
    if (this.recorder.phase === 'record') {
      this.recorder.recordRequest(details.url, topUrl)
    } else {
      this.recorder.decide(details.url, topUrl)
    }
  }

  private recorder: DomainRecorder | null = null
  private attachedSession: Session | null = null

  constructor(private readonly getTopUrl: () => string | null) {}

  /** ผูก hook กับ session — ปล่อยทุก request ผ่าน (โหมด record) */
  attachRecord(session: Session, recorder: DomainRecorder): void {
    this.detach()
    this.recorder = recorder
    this.attachedSession = session
    recorder.startRecord()
    session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      this.handler(details)
      callback({})
    })
  }

  /** ผูก hook กับ session — ตรวจกับ allowedDomains (โหมด enforce) */
  attachEnforce(session: Session, recorder: DomainRecorder): void {
    this.detach()
    this.recorder = recorder
    this.attachedSession = session
    session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const topUrl = this.getTopUrl()
      const decision = recorder.decide(details.url, topUrl)
      callback(decision.allowed ? {} : { cancel: true })
    })
  }

  /** flush รายการค้างก่อนถอด */
  detach(): void {
    this.recorder?.detach()
    this.recorder = null
    this.attachedSession = null
  }

  get isAttached(): boolean {
    return this.attachedSession !== null
  }
}

export type UrlVerdict = 'allowed' | 'denied' | 'direct-ip'

/* ============================================================
 * UrlWhitelistFilter (Phase 5 — Mode 2 และ proxy Mode 3) — pure matcher
 * ประเมินกติกา whitelist แบบ default-deny:
 *   1. โดเมนเดียว:       `docs.python.org`      → host ตรง ๆ ทุก path
 *   2. ซับโดเมนทั้งต้นไม้: `*.cppreference.com`   → host เอง + ลงท้าย .cppreference.com
 *   3. Path prefix:      `developer.mozilla.org/en-US/docs/*` → host ตรง + path ขึ้นต้น
 *      (path ไม่จบด้วย * → เทียบตรงเป๊ะ pathname+search)
 * การเรียกด้วย IP ตรง ๆ (http://104.18.32.7 หรือ CONNECT x.x.x.x) = การหลบ
 * การตรวจชื่อโดเมน → คืน 'direct-ip' ให้ผู้เรียกฟ้องเป็น event แยก
 * ============================================================ */

interface ParsedRule {
  host: string
  /** path pattern ที่คัดสะอ้างแล้ว ('' = ไม่ลำดับ path ให้เช็ค) */
  path: string
  /** กติกาขึ้นต้น `*.` */
  wildcardHost: boolean
  /** path pattern ลงท้าย * จึงประเมินเป็น prefix */
  wildcardPrefix: boolean
}

const IPV4_HOST_RE = /^\d{1,3}(\.\d{1,3}){3}$/

function trimEnd(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, value.length - suffix.length) : value
}

function parseRule(rule: string): ParsedRule | null {
  let normalized = rule.trim().toLowerCase()
  if (normalized === '') return null
  normalized = normalized.replace(/^https?:\/\//, '')
  const slashIdx = normalized.indexOf('/')
  let hostPart = slashIdx === -1 ? normalized : normalized.slice(0, slashIdx)
  let pathPart = slashIdx === -1 ? '' : normalized.slice(slashIdx)
  if (pathPart === '/' || pathPart === '/*' || pathPart === '*') pathPart = ''
  // กติกาไม่รองรับ port หรือ path ฝังในส่วน host
  if (hostPart.includes('/') || hostPart.includes(':')) return null
  const wildcardHost = hostPart.startsWith('*.')
  if (wildcardHost) hostPart = hostPart.slice(2)
  hostPart = trimEnd(hostPart, '.')
  if (hostPart === '' || IPV4_HOST_RE.test(hostPart)) return null
  let wildcardPrefix = false
  if (pathPart.endsWith('*')) {
    pathPart = trimEnd(trimEnd(pathPart, '*'), '/')
    wildcardPrefix = true
  }
  return { host: hostPart, path: pathPart, wildcardHost, wildcardPrefix }
}

function hostMatches(parsedRule: ParsedRule, hostname: string): boolean {
  if (hostname === parsedRule.host) return true
  if (parsedRule.wildcardHost) {
    return hostname.length > parsedRule.host.length + 1 && hostname.endsWith(`.${parsedRule.host}`)
  }
  return false
}

/** ประเมิน URL เต็มกับรายการกติกา (default-deny) */
export function evaluateUrlAgainstWhitelist(url: string, allowedRules: string[]): UrlVerdict {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'denied'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'denied'
  const hostname = trimEnd(parsed.hostname.toLowerCase(), '.')
  if (IPV4_HOST_RE.test(hostname) || hostname.startsWith('[')) return 'direct-ip'
  // path จับคู่แบบ case-insensitive (กติกาถูก lowercase ไว้แล้ว)
  const actualPath = (parsed.pathname + parsed.search).toLowerCase()
  for (const rule of allowedRules) {
    const parsedRule = parseRule(rule)
    if (!parsedRule) continue
    if (!hostMatches(parsedRule, hostname)) continue
    if (parsedRule.path === '') return 'allowed'
    if (parsedRule.wildcardPrefix) {
      if (actualPath.startsWith(parsedRule.path)) return 'allowed'
    } else if (trimEnd(actualPath, '/') === parsedRule.path) {
      return 'allowed'
    }
  }
  return 'denied'
}

/** ประเมิน hostname เฉย ๆ (สำหรับ CONNECT host:port ของ proxy Mode 3 — ไม่มี path) */
export function evaluateHostnameAgainstWhitelist(hostname: string, allowedRules: string[]): UrlVerdict {
  const normalized = trimEnd(hostname.toLowerCase().trim(), '.')
  if (normalized === '') return 'denied'
  if (IPV4_HOST_RE.test(normalized) || normalized.startsWith('[')) return 'direct-ip'
  for (const rule of allowedRules) {
    const parsedRule = parseRule(rule)
    if (!parsedRule) continue
    if (hostMatches(parsedRule, normalized)) return 'allowed'
  }
  return 'denied'
}

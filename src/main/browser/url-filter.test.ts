import { describe, expect, it } from 'vitest'
import { evaluateUrlAgainstWhitelist, evaluateHostnameAgainstWhitelist } from './url-filter'

/* ============================================================
 * ทดสอบ UrlWhitelistFilter (Phase 5 — checklist 4.1)
 * ============================================================ */

describe('evaluateUrlAgainstWhitelist', () => {
  const RULES = [
    'docs.python.org',
    '*.cppreference.com',
    'developer.mozilla.org/en-US/docs/Web/JavaScript/*'
  ]

  it('โดเมนเดียว — ผ่านทุก path', () => {
    expect(evaluateUrlAgainstWhitelist('https://docs.python.org/3/library/os.html', RULES)).toBe('allowed')
  })

  it('ซับโดเมนที่มีกติกา *.domain — ผ่าน / ตระกูลอื่นถูกปฏิเสธ', () => {
    expect(evaluateUrlAgainstWhitelist('https://en.cppreference.com/w/cpp/language/basic', RULES)).toBe('allowed')
    expect(evaluateUrlAgainstWhitelist('https://evil-python.org', RULES)).toBe('denied')
  })

  it('path prefix — ในเอกสารผ่าน นอกถูกปฏิเสธ', () => {
    expect(evaluateUrlAgainstWhitelist('https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions', RULES)).toBe('allowed')
    expect(
      evaluateUrlAgainstWhitelist('https://developer.mozilla.org/en-US/docs/Web/CSS/color', RULES)
    ).toBe('denied')
  })

  it('เว็บ AI ต้องถูกปฏิเสธเสมอ (default-deny)', () => {
    expect(evaluateUrlAgainstWhitelist('https://chatgpt.com/', ['docs.python.org'])).toBe('denied')
    expect(evaluateUrlAgainstWhitelist('https://api.openai.com/v1/chat/completions', ['docs.python.org'])).toBe('denied')
  })

  it('ห้ามต่อด้วย IP ตรง ๆ — ถือว่าเป็น DIRECT_IP', () => {
    // checklist 4.1: https://104.18.32.7:443 (Direct IP) -> DENIED (DIRECT_IP_ATTEMPT)
    expect(evaluateUrlAgainstWhitelist('https://104.18.32.7:443', ['*.python.org'])).toBe('direct-ip')
    expect(evaluateUrlAgainstWhitelist('http://192.168.0.15/notes.html', RULES)).toBe('direct-ip')
  })

  it('พยายามหลบด้วยการล้อม hostname เหมือนกัน? ต้องไม่ผ่าน', () => {
    // เกมหลบซับโดเมน: "evil.pythetic-org"
    expect(evaluateUrlAgainstWhitelist('https://evilpython.org', ['*.python.org'])).toBe('denied')
    // hostname ลงท้าย .python.org จึงผ่านตามกติกา *.python.org
    expect(evaluateUrlAgainstWhitelist('https://docs2.python.org/x', ['*.python.org'])).toBe('allowed')
  })

  it('ไม่มีกติกา = default deny ทั้งหมด', () => {
    expect(evaluateUrlAgainstWhitelist('https://docs.python.org', [])).toBe('denied')
  })

  it('URL ไม่ถูกต้อง = deny', () => {
    expect(evaluateUrlAgainstWhitelist('not-a-url', RULES)).toBe('denied')
    expect(evaluateUrlAgainstWhitelist('ftp://docs.python.org', RULES)).toBe('denied')
  })
})

describe('evaluateHostnameAgainstWhitelist (proxy CONNECT)', () => {
  it('โดเมนอนุญาต / นอกรายการ', () => {
    expect(evaluateHostnameAgainstWhitelist('docs.python.org', ['docs.python.org'])).toBe('allowed')
    expect(evaluateHostnameAgainstWhitelist(' Panasonic.python.org', ['*.python.org'])).toBe('allowed')
    expect(evaluateHostnameAgainstWhitelist('api.openai.com', ['docs.python.org'])).toBe('denied')
  })

  it('CONNECT ด้วย IP ตรง = direct-ip', () => {
    expect(evaluateHostnameAgainstWhitelist('104.18.32.7', ['*.python.org'])).toBe('direct-ip')
    expect(evaluateHostnameAgainstWhitelist('[::1]', ['*.*'])).toBe('direct-ip')
  })
})

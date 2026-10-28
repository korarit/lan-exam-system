import { describe, expect, it } from 'vitest'
import {
  DomainRecorder,
  extractHostname,
  isDomainAllowed,
  isIpLiteral,
  isNoiseUrl,
  normalizeHostname
} from './domain-recorder'

describe('normalizeHostname / extractHostname', () => {
  it('lowercase + ตัด port + punycode → unicode', () => {
    expect(normalizeHostname('EXAMPLE.COM:8080')).toBe('example.com')
    expect(normalizeHostname('xn--bcher-kva.example')).toBe('bücher.example')
    expect(normalizeHostname('Docs.Example.COM.')).toBe('docs.example.com')
  })

  it('ดึง hostname จาก URL — ปฏิเสธ scheme ที่ไม่ใช่ http/https', () => {
    expect(extractHostname('https://cdn.example.com/a.png')).toBe('cdn.example.com')
    expect(extractHostname('http://USER@Docs.Example.com:443/page?x=1')).toBe('docs.example.com')
    expect(extractHostname('data:image/png;base64,xxx')).toBeNull()
    expect(extractHostname('blob:https://app.example.com/uuid')).toBeNull()
    expect(extractHostname('not a url')).toBeNull()
  })

  it('IP literal', () => {
    expect(isIpLiteral('1.2.3.4')).toBe(true)
    expect(isIpLiteral('example.com')).toBe(false)
    expect(normalizeHostname('1.2.3.4')).toBe('1.2.3.4')
  })
})

describe('isNoiseUrl — กรอง noise ของตัวแอป', () => {
  const local = new Set(['192.168.1.10'])
  it('loopback / data / blob / IP เครื่องแม่ = noise', () => {
    expect(isNoiseUrl('http://localhost:5173/x', local)).toBe(true)
    expect(isNoiseUrl('http://127.0.0.1:5173/x', local)).toBe(true)
    expect(isNoiseUrl('data:text/html,x', local)).toBe(true)
    expect(isNoiseUrl('blob:https://x/y', local)).toBe(true)
    expect(isNoiseUrl('devtools://devtools/bundled/x', local)).toBe(true)
    expect(isNoiseUrl('http://192.168.1.10:4311/api', local)).toBe(true)
  })
  it('เว็บจริง = ไม่ใช่ noise', () => {
    expect(isNoiseUrl('https://docs.example.com/page', local)).toBe(false)
    expect(isNoiseUrl('https://fonts.gstatic.com/f.woff2', local)).toBe(false)
  })
})

describe('isDomainAllowed — exact / subdomain', () => {
  const allowed = new Set(['docs.example.com'])
  it('subdomain ลูกผ่าน, ชื่อแฝงไม่ผ่าน', () => {
    expect(isDomainAllowed('docs.example.com', allowed)).toBe(true)
    expect(isDomainAllowed('a.docs.example.com', allowed)).toBe(true)
    expect(isDomainAllowed('evildocs.example.com', allowed)).toBe(false)
    expect(isDomainAllowed('example.com', allowed)).toBe(false)
  })
})

describe('DomainRecorder — โหมด record', () => {
  function makeRecorder(now: () => number, localAddresses: string[] = []): {
    recorder: DomainRecorder
    flushed: Array<{ domain: string; hits: number }>
  } {
    const flushed: Array<{ domain: string; hits: number }> = []
    const recorder = new DomainRecorder({
      onFlush: (records) => {
        for (const r of records) flushed.push({ domain: r.domain, hits: r.hits })
      },
      flushIntervalMs: 60_000,
      now,
      localAddresses
    })
    return { recorder, flushed }
  }

  it('30 requests ข้าม 3 โดเมน (ปน localhost) → flush ได้ 3 records, hits รวมถูกต้อง', () => {
    const { recorder, flushed } = makeRecorder(() => 1_000)
    recorder.startRecord()
    const topUrl = 'https://docs.example.com/material'
    let seq = 0
    for (let i = 0; i < 30; i++) {
      const pool = [
        'https://cdn.example.com/img.png',
        'https://fonts.gstatic.com/f.woff2',
        `https://api.docs.example.com/v1/data?seq=${seq++}`
      ]
      // localhost กับ IP เครื่องแม่ปนเข้ามา 8 ครั้ง — ต้องถูกกรองทิ้ง
      if (i % 4 === 0) {
        recorder.recordRequest('http://localhost:5173/hmr', topUrl)
        continue
      }
      recorder.recordRequest(pool[i % pool.length]!, topUrl)
    }
    recorder.detach()
    expect(flushed).toHaveLength(3)
    const totalHits = flushed.reduce((sum, r) => sum + r.hits, 0)
    expect(totalHits).toBe(22) // 30 - 8 (localhost)
  })

  it('record โดเมนเดิมซ้ำ → hits สะสม + lastSeenMs อัปเดต', () => {
    let clock = 1_000
    const batches: Array<Array<{ domain: string; hits: number; lastSeenMs: number }>> = []
    const recorder = new DomainRecorder({
      onFlush: (records) =>
        batches.push(records.map((r) => ({ domain: r.domain, hits: r.hits, lastSeenMs: r.lastSeenMs }))),
      flushIntervalMs: 60_000,
      now: () => clock
    })
    recorder.startRecord()
    const topUrl = 'https://docs.example.com/material'
    recorder.recordRequest('https://cdn.example.com/a.png', topUrl)
    recorder.recordRequest('https://cdn.example.com/b.png', topUrl)
    recorder.flush()
    clock = 9_000
    recorder.recordRequest('https://cdn.example.com/c.png', topUrl)
    recorder.detach()
    expect(batches).toHaveLength(2)
    expect(batches[0]![0]!.hits).toBe(2)
    expect(batches[1]![0]!.hits).toBe(1)
    expect(batches[1]![0]!.lastSeenMs).toBe(9_000)
  })

  it('IP literal เก็บเป็น "IP:x.x.x.x" แยกหมวด', () => {
    const { recorder, flushed } = makeRecorder(() => 1_000)
    recorder.startRecord()
    recorder.recordRequest('http://203.0.113.9/payload', 'http://203.0.113.9/')
    recorder.detach()
    expect(flushed[0]!.domain).toBe('IP:203.0.113.9')
  })
})

describe('DomainRecorder — โหมด enforce (นักเรียนใช้งานจริง)', () => {
  function makeEnforceRecorder(allowedDomains: string[], enforcement: 'warn' | 'block', unauthorized: Array<{ domain: string; action: string }>): DomainRecorder {
    const recorder = new DomainRecorder({
      onFlush: () => {},
      flushIntervalMs: 60_000,
      localAddresses: ['192.168.1.1'],
      onUnauthorized: (d) => unauthorized.push(d)
    })
    recorder.startEnforce(allowedDomains, enforcement)
    return recorder
  }

  it('warn: โดเมนที่ไม่ allowed → ปล่อยผ่าน + onUnauthorized', () => {
    const unauthorized: Array<{ domain: string; action: string }> = []
    const recorder = makeEnforceRecorder(['docs.example.com'], 'warn', unauthorized)
    const ok = recorder.decide('https://docs.example.com/page', 'https://docs.example.com/page')
    expect(ok.allowed).toBe(true)
    const sub = recorder.decide('https://cdn.docs.example.com/img.png', 'https://docs.example.com/page')
    expect(sub.allowed).toBe(true)
    const bad = recorder.decide('https://api.openai.com/v1', 'https://docs.example.com/page')
    expect(bad.allowed).toBe(true) // warn = ปล่อยผ่าน
    expect(unauthorized).toHaveLength(1)
    expect(unauthorized[0]!.domain).toBe('api.openai.com')
    expect(unauthorized[0]!.action).toBe('warn')
  })

  it('block: โดเมนที่ไม่ allowed → cancel, โดเมนที่ allowed ผ่านปกติ', () => {
    const unauthorized: Array<{ domain: string; action: string }> = []
    const recorder = makeEnforceRecorder(['docs.example.com'], 'block', unauthorized)
    const bad = recorder.decide('https://chatgpt.com/', 'https://docs.example.com/')
    expect(bad.allowed).toBe(false)
    const good = recorder.decide('https://docs.example.com/doc', 'https://docs.example.com/doc')
    expect(good.allowed).toBe(true)
    expect(unauthorized).toHaveLength(1)
    expect(unauthorized[0]!.action).toBe('block')
  })

  it('noise (loopback/data:) ไม่ถูกฟ้องในโหมด enforce', () => {
    const unauthorized: Array<{ domain: string; action: string }> = []
    const recorder = makeEnforceRecorder([], 'warn', unauthorized)
    expect(recorder.decide('http://localhost:5173/x', null).allowed).toBe(true)
    expect(recorder.decide('data:text/html,x', null).allowed).toBe(true)
    expect(unauthorized).toHaveLength(0)
  })
})

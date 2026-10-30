import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { HostDatabase } from '../storage/db'
import { DomainAllowlistService } from './domain-allowlist'

const tempDirs: string[] = []
const openDbs: HostDatabase[] = []

function makeService(enforcement: 'report-only' | 'block-and-report' = 'report-only'): {
  db: HostDatabase
  service: DomainAllowlistService
  sessionId: string
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-allowlist-'))
  tempDirs.push(dir)
  const db = new HostDatabase({ filePath: path.join(dir, 'test.sqlite') })
  openDbs.push(db)
  const sessionId = randomUUID()
  db.db
    .prepare(
      `INSERT INTO exam_sessions (id, room_name, mode, enforcement, status, crypto_salt, created_at_ms)
       VALUES (?, 'ห้อง 401', 'in-app-docs', ?, 'lobby', 'salt', ?)`
    )
    .run(sessionId, enforcement, Date.now())
  return { db, service: new DomainAllowlistService(db), sessionId }
}

afterEach(() => {
  // ปิด db ก่อนลบโฟลเดอร์ (Windows ล็อกไฟล์ที่เปิดอยู่)
  while (openDbs.length > 0) openDbs.pop()?.close()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('DomainAllowlistService.recordBatch — upsert', () => {
  it('record โดเมนเดิมซ้ำ 2 รอบ → 1 แถวแต่ hits สะสม + last_seen_ms อัปเดต', () => {
    const { db, service, sessionId } = makeService()
    service.recordBatch(sessionId, [
      { domain: 'cdn.example.com', topDomain: 'docs.example.com', source: 'preview', hits: 3, firstSeenMs: 1_000, lastSeenMs: 2_000 }
    ])
    service.recordBatch(sessionId, [
      { domain: 'cdn.example.com', topDomain: 'docs.example.com', source: 'preview', hits: 2, firstSeenMs: 5_000, lastSeenMs: 8_000 }
    ])
    const rows = service.list(sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.hits).toBe(5)
    expect(rows[0]!.lastSeenAtMs).toBe(8_000)
    expect(rows[0]!.firstSeenMs).toBe(1_000)
    expect(rows[0]!.approved).toBe(false)
    const count = db.db.prepare(`SELECT COUNT(*) AS n FROM recorded_domains`).get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('โดเมนคนละ topDomain = แถวคนละแถว, เรียง hits มาก → น้อย', () => {
    const { service, sessionId } = makeService()
    service.recordBatch(sessionId, [
      { domain: 'fonts.gstatic.com', topDomain: 'docs.example.com', source: 'preview', hits: 1, firstSeenMs: 1, lastSeenMs: 1 },
      { domain: 'cdn.example.com', topDomain: 'docs.example.com', source: 'preview', hits: 9, firstSeenMs: 1, lastSeenMs: 1 },
      { domain: 'cdn.example.com', topDomain: 'other.example.org', source: 'preview', hits: 2, firstSeenMs: 1, lastSeenMs: 1 }
    ])
    const rows = service.list(sessionId)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.hits)).toEqual([9, 2, 1])
  })

  it('recordTopUrl = source top-url + pending (R2: ไม่ auto-approved)', () => {
    const { service, sessionId } = makeService()
    service.recordTopUrl(sessionId, 'docs.example.com')
    const rows = service.list(sessionId)
    expect(rows[0]!.source).toBe('top-url')
    expect(rows[0]!.approved).toBe(false)
    expect(service.listApproved(sessionId)).toEqual([])
  })

  it('clear ล้างรายการทั้งห้องเพื่อเริ่ม record ใหม่ (R2)', () => {
    const { service, sessionId } = makeService()
    service.recordBatch(sessionId, [
      { domain: 'cdn.example.com', topDomain: 'docs.example.com', source: 'preview', hits: 2, firstSeenMs: 1, lastSeenMs: 1 }
    ])
    expect(service.clear(sessionId)).toBe(1)
    expect(service.list(sessionId)).toEqual([])
  })
})

describe('DomainAllowlistService.approve — ครูตัดสิน (ไม่มีตัวขวาง)', () => {
  it('อนุมัติรายการเดียว / ยกเลิกได้', () => {
    const { service, sessionId } = makeService()
    service.recordBatch(sessionId, [
      { domain: 'cdn.example.com', topDomain: 'docs.example.com', source: 'preview', hits: 2, firstSeenMs: 1, lastSeenMs: 1 },
      { domain: 'fonts.gstatic.com', topDomain: 'docs.example.com', source: 'preview', hits: 1, firstSeenMs: 1, lastSeenMs: 1 }
    ])
    expect(service.setApproved(sessionId, 'cdn.example.com', true)).toBe(true)
    expect(service.listApproved(sessionId)).toEqual(['cdn.example.com'])
    expect(service.setApproved(sessionId, 'cdn.example.com', false)).toBe(true)
    expect(service.listApproved(sessionId)).toEqual([])
  })

  it('อนุมัติทั้งหมดที่รอตัดสิน (approveAll)', () => {
    const { service, sessionId } = makeService()
    service.recordBatch(sessionId, [
      { domain: 'cdn.example.com', topDomain: 'docs.example.com', source: 'preview', hits: 2, firstSeenMs: 1, lastSeenMs: 1 },
      { domain: 'fonts.gstatic.com', topDomain: 'docs.example.com', source: 'preview', hits: 1, firstSeenMs: 1, lastSeenMs: 1 }
    ])
    service.recordTopUrl(sessionId, 'docs.example.com')
    expect(service.approveAll(sessionId)).toBe(3) // top-url ก็เป็น pending ต้องอนุมัติเอง (R2)
    expect(service.listApproved(sessionId).sort()).toEqual(['cdn.example.com', 'fonts.gstatic.com', 'docs.example.com'].sort())
  })

  it('อนุมัติข้าม session ไม่ได้ (ผูกต่อห้อง)', () => {
    const a = makeService()
    const b = makeService()
    a.service.recordBatch(a.sessionId, [
      { domain: 'cdn.example.com', topDomain: 'docs.example.com', source: 'preview', hits: 1, firstSeenMs: 1, lastSeenMs: 1 }
    ])
    a.service.setApproved(a.sessionId, 'cdn.example.com', true)
    expect(b.service.listApproved(b.sessionId)).toEqual([])
  })
})

describe('DomainAllowlistService — domainEnforcement', () => {
  it('ค่าเริ่มต้นสืบจาก enforcement ของห้อง', () => {
    const warn = makeService('report-only')
    const block = makeService('block-and-report')
    expect(warn.service.resolveDomainEnforcement(warn.sessionId)).toBe('warn')
    expect(block.service.resolveDomainEnforcement(block.sessionId)).toBe('block')
  })

  it('ครูตั้งทับได้ในการ์ดเตรียมเอกสาร (override)', () => {
    const { service, sessionId } = makeService('report-only')
    service.setEnforcementOverride('block')
    expect(service.resolveDomainEnforcement(sessionId)).toBe('block')
    service.setEnforcementOverride(null)
    expect(service.resolveDomainEnforcement(sessionId)).toBe('warn')
    expect(service.resolveDomainEnforcement(null)).toBe('warn')
  })
})

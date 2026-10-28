import type { HostDatabase } from '../storage/db'
import type { RecordedDomainRecord, RecordedDomainSource } from './domain-recorder'
import type { DomainEnforcement } from '@shared/policy-schema'

/* ============================================================
 * DomainAllowlistService (Phase 3a-plus) — ครอบตาราง recorded_domains
 * - recordBatch: upsert (hits สะสม, first/last_seen อัปเดต)
 * - list: เรียง hits มาก → น้อย พร้อมสถานะอนุมัติ
 * - approve: รายการเดียวหรือทั้งหมดที่ค้าง — ไม่มีตัวขวาง (ครูตรวจเอง)
 * ผูกต่อ session (ห้องสอบ) — ไม่แชร์ข้ามห้อง
 * ============================================================ */

export interface RecordedDomainRow {
  domain: string
  topDomain: string
  source: RecordedDomainSource
  hits: number
  approved: boolean
  firstSeenMs: number
  lastSeenAtMs: number
}

interface RecordedDomainDbRow {
  domain: string
  top_domain: string
  source: string
  hits: number
  first_seen_ms: number
  last_seen_ms: number
  approved: number
}

export class DomainAllowlistService {
  /** ค่าทับจากการ์ดเตรียมเอกสาร (in-memory ต่อห้อง — null = สืบจาก enforcement ของห้อง) */
  private enforcementOverride: DomainEnforcement | null = null

  constructor(private readonly db: HostDatabase) {}

  /** upsert รายการจาก DomainRecorder — hits สะสม, ไม่แตะสถานะอนุมัติเดิม */
  recordBatch(sessionId: string, records: RecordedDomainRecord[]): void {
    if (records.length === 0) return
    const upsert = this.db.db.prepare(
      `INSERT INTO recorded_domains
         (session_id, domain, top_domain, source, hits, first_seen_ms, last_seen_ms, approved)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(session_id, domain, top_domain) DO UPDATE SET
         hits = hits + excluded.hits,
         last_seen_ms = excluded.last_seen_ms`
    )
    const run = this.db.db.transaction((rows: RecordedDomainRecord[]) => {
      for (const r of rows) {
        upsert.run(sessionId, r.domain, r.topDomain, r.source, r.hits, r.firstSeenMs, r.lastSeenMs)
      }
    })
    run(records)
  }

  /** โดเมนของ URL ชั้นบนที่ครูกรอก — auto-approved */
  recordTopUrl(sessionId: string, domain: string, atMs = Date.now()): void {
    this.db.db
      .prepare(
        `INSERT INTO recorded_domains
           (session_id, domain, top_domain, source, hits, first_seen_ms, last_seen_ms, approved, approved_at_ms)
         VALUES (?, ?, ?, 'top-url', 1, ?, ?, 1, ?)
         ON CONFLICT(session_id, domain, top_domain) DO UPDATE SET
           hits = hits + 1,
           last_seen_ms = excluded.last_seen_ms`
      )
      .run(sessionId, domain.toLowerCase(), domain.toLowerCase(), atMs, atMs, atMs)
  }

  list(sessionId: string): RecordedDomainRow[] {
    const rows = this.db.db
      .prepare(
        `SELECT domain, top_domain, source, hits, first_seen_ms, last_seen_ms, approved
         FROM recorded_domains WHERE session_id = ?
         ORDER BY hits DESC, domain ASC`
      )
      .all(sessionId) as RecordedDomainDbRow[]
    return rows.map((row) => ({
      domain: row.domain,
      topDomain: row.top_domain,
      source: row.source === 'top-url' ? 'top-url' : 'preview',
      hits: row.hits,
      approved: row.approved === 1,
      firstSeenMs: row.first_seen_ms,
      lastSeenAtMs: row.last_seen_ms
    }))
  }

  /** โดเมนที่อนุมัติแล้ว (สำหรับฝัง allowedDomains ใน policy) */
  listApproved(sessionId: string): string[] {
    const rows = this.db.db
      .prepare(`SELECT DISTINCT domain FROM recorded_domains WHERE session_id = ? AND approved = 1`)
      .all(sessionId) as Array<{ domain: string }>
    return rows.map((r) => r.domain)
  }

  /** อนุมัติ/ยกเลิกรายการเดียว — คืน true ถ้ามีแถวถูกอัปเดต */
  setApproved(sessionId: string, domain: string, approved: boolean, atMs = Date.now()): boolean {
    const result = this.db.db
      .prepare(
        `UPDATE recorded_domains
         SET approved = ?, approved_at_ms = ?
         WHERE session_id = ? AND domain = ?`
      )
      .run(approved ? 1 : 0, approved ? atMs : null, sessionId, domain.toLowerCase())
    return result.changes > 0
  }

  /** อนุมัติทั้งหมดที่ยังรอตัดสิน — คืนจำนวนรายการที่อนุมัติเพิ่ม */
  approveAll(sessionId: string, atMs = Date.now()): number {
    return this.db.db
      .prepare(
        `UPDATE recorded_domains SET approved = 1, approved_at_ms = ?
         WHERE session_id = ? AND approved = 0`
      )
      .run(atMs, sessionId).changes
  }

  /** enforcement ของห้อง (จาก DB — report-only → warn / block-and-report → block) */
  getRoomEnforcement(sessionId: string): 'report-only' | 'block-and-report' {
    const row = this.db.db
      .prepare(`SELECT enforcement FROM exam_sessions WHERE id = ?`)
      .get(sessionId) as { enforcement: string } | undefined
    return row?.enforcement === 'block-and-report' ? 'block-and-report' : 'report-only'
  }

  /** ค่า domainEnforcement ที่ใช้จริง: ครูตั้งทับได้ในการ์ดเตรียมเอกสาร */
  resolveDomainEnforcement(sessionId: string | null): DomainEnforcement {
    if (this.enforcementOverride) return this.enforcementOverride
    if (sessionId === null) return 'warn'
    return this.getRoomEnforcement(sessionId) === 'block-and-report' ? 'block' : 'warn'
  }

  setEnforcementOverride(mode: DomainEnforcement | null): void {
    this.enforcementOverride = mode
  }
}

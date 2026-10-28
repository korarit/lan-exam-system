import { pbkdf2Sync } from 'node:crypto'
import { computeHmac, sha256Hex } from '../crypto/primitives'
import type { HostDatabase } from '../storage/db'
import {
  AUDIT_HASH_PREFIX,
  AUDIT_HMAC_PREFIX,
  GENESIS_PREV_HASH,
  ROOM_CREATED_EVENT
} from '@shared/triage'
import type {
  AuditEntryView,
  ChainVerification
} from '@shared/triage'
import type { Severity } from '@shared/types/events'

/* ============================================================
 * Phase 3b.1 — AuditLogger: Append-only Audit Log แบบ
 * Cryptographic Hash Chain (SHA-256) + HMAC ของเครื่องแม่
 *
 * - ทุกรายการผูกกับรายการก่อนหน้าด้วย prevHash → แก้/ลบย้อนหลังตรวจพบ
 * - เขียนใน SQLite Transaction เดียวต่อรายการ (better-sqlite3 sync)
 *   → ไม่มี race condition แม้ event จากหลายสิบเครื่องพร้อมกัน
 * ============================================================ */

/** Canonical JSON: เรียง key แบบลึกทุกระดับ เพื่อให้ hash คำนวณซ้ำได้เสมอ */
export function canonicalJsonString(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonString(item)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonString(v)}`).join(',')}}`
}

/** คีย์ HMAC ของห้อง (roomAuditSecretKey) — ดึงจาก room secret seed ของการเริ่มสอบรอบนั้น */
export function deriveAuditKey(roomSecretSeedHex: string, roomId: string): Buffer {
  return pbkdf2Sync(roomSecretSeedHex, `${roomId}:audit`, 10_000, 32, 'sha256')
}

export interface AppendAuditInput {
  /** 'HOST' เมื่อเกิดจากระบบหรือการกดของผู้คุมสอบเอง */
  studentId: string
  eventCode: string
  category: string
  severity: Severity
  scoreDelta: number
  summaryText: string
  evidence: Record<string, unknown>
  clientTimestampMs?: number
}

interface AuditRow {
  session_id: string
  seq_no: number
  student_id: string | null
  timestamp_ms: number
  client_timestamp_ms: number | null
  event_type: string
  category: string
  severity: string
  score_delta: number
  summary_text: string
  payload_json: string
  prev_hash: string
  entry_hash: string
  host_hmac: string
}

export class AuditLogger {
  constructor(
    private readonly db: HostDatabase,
    /** คืนคีย์ HMAC ประจำห้อง (ดึงจาก exam_sessions.crypto_salt) */
    private readonly getAuditKey: (roomId: string) => Buffer
  ) {}

  /* ---------- Genesis (seq 0) ตอนเริ่มการสอบของห้อง ---------- */

  appendGenesis(roomId: string, policyBody: unknown, nowMs: number): AuditEntryView {
    const existing = this.db.db
      .prepare(`SELECT seq_no FROM audit_logs WHERE session_id = ? AND seq_no = 0`)
      .get(roomId)
    if (existing) return this.listEntries(roomId, { ascending: true, limit: 1 })[0]!

    const canonicalPolicy = canonicalJsonString(policyBody)
    // สูตร Genesis ตามแผน: SHA256("ZTEXAM_AUDIT_V1|0|" + roomId + "|" + ts + "|ROOM_CREATED|" + policy)
    const entryHash = sha256Hex(
      `${AUDIT_HASH_PREFIX}|0|${roomId}|${nowMs}|${ROOM_CREATED_EVENT}|${canonicalPolicy}`
    )
    const hostHmac = this.computeHmac(roomId, 0, entryHash)
    this.db.db
      .prepare(
        `INSERT INTO audit_logs
           (session_id, student_id, timestamp_ms, event_type, severity, payload_json,
            prev_hash, entry_hash, seq_no, category, score_delta, summary_text, host_hmac)
         VALUES (?, 'HOST', ?, ?, 'normal', ?, ?, ?, 0, 'lifecycle', 0, ?, ?)`
      )
      .run(roomId, nowMs, ROOM_CREATED_EVENT, canonicalPolicy, GENESIS_PREV_HASH, entryHash, '', hostHmac)
    return this.rowToView(this.getRow(roomId, 0)!)
  }

  /* ---------- เหตุการณ์ทั่วไป (seq k >= 1) ---------- */

  append(roomId: string, input: AppendAuditInput, nowMs: number = Date.now()): AuditEntryView {
    return this.db.db.transaction((): AuditEntryView => {
      const last = this.db.db
        .prepare(
          `SELECT seq_no, entry_hash FROM audit_logs WHERE session_id = ? ORDER BY seq_no DESC LIMIT 1`
        )
        .get(roomId) as { seq_no: number; entry_hash: string } | undefined
      const seqNo = (last?.seq_no ?? -1) + 1
      const prevHash = seqNo === 0 ? GENESIS_PREV_HASH : last!.entry_hash
      const canonicalEvidence = canonicalJsonString(input.evidence)
      const entryHash = sha256Hex(
        [
          AUDIT_HASH_PREFIX,
          String(seqNo),
          prevHash,
          roomId,
          input.studentId,
          String(nowMs),
          input.eventCode,
          input.severity,
          canonicalEvidence
        ].join('|')
      )
      const hostHmac = this.computeHmac(roomId, seqNo, entryHash)
      this.db.db
        .prepare(
          `INSERT INTO audit_logs
             (session_id, student_id, timestamp_ms, client_timestamp_ms, event_type, severity,
              payload_json, prev_hash, entry_hash, seq_no, category, score_delta, summary_text, host_hmac)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          roomId,
          input.studentId,
          nowMs,
          input.clientTimestampMs ?? null,
          input.eventCode,
          input.severity,
          canonicalEvidence,
          prevHash,
          entryHash,
          seqNo,
          input.category,
          input.scoreDelta,
          input.summaryText,
          hostHmac
        )
      return this.rowToView(this.getRow(roomId, seqNo)!)
    })()
  }

  /* ---------- ตรวจสอบความสมบูรณ์ของสายโซ่ทั้งห้อง ---------- */

  verifyAuditChain(roomId: string): ChainVerification {
    const rows = this.readRows(roomId)
    const totalEntries = rows.length
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!
      // seq ต้องเรียงต่อเนื่อง 0, 1, 2, ... N โดยไม่มีเลขหาย
      if (row.seq_no !== index) {
        return {
          valid: false,
          totalEntries,
          firstTamperedSeqNo: row.seq_no,
          reason: `SEQ_GAP: expected seq ${index} but found ${row.seq_no}`
        }
      }
      // prevHash ต้องชี้ไปที่ entryHash ของแถวก่อนหน้าเสมอ
      const expectedPrev = index === 0 ? GENESIS_PREV_HASH : rows[index - 1]!.entry_hash
      if (row.prev_hash !== expectedPrev) {
        return {
          valid: false,
          totalEntries,
          firstTamperedSeqNo: row.seq_no,
          reason: `PREV_HASH_MISMATCH at seq ${row.seq_no}`
        }
      }
      // คำนวณ entryHash ซ้ำจากเนื้อหาจริงในฐานข้อมูล
      const expectedHash =
        index === 0
          ? sha256Hex(
              `${AUDIT_HASH_PREFIX}|0|${roomId}|${row.timestamp_ms}|${ROOM_CREATED_EVENT}|${row.payload_json}`
            )
          : sha256Hex(
              [
                AUDIT_HASH_PREFIX,
                String(row.seq_no),
                row.prev_hash,
                roomId,
                row.student_id ?? '',
                String(row.timestamp_ms),
                row.event_type,
                row.severity,
                row.payload_json
              ].join('|')
            )
      if (row.entry_hash !== expectedHash) {
        return {
          valid: false,
          totalEntries,
          firstTamperedSeqNo: row.seq_no,
          reason: `ENTRY_HASH_MISMATCH at seq ${row.seq_no}`
        }
      }
      // HMAC ต้องตรงกับคีย์ประจำห้อง (กันการปลอมแถวใหม่ทั้งแถว)
      if (row.host_hmac !== this.computeHmac(roomId, row.seq_no, row.entry_hash)) {
        return {
          valid: false,
          totalEntries,
          firstTamperedSeqNo: row.seq_no,
          reason: `HMAC_MISMATCH at seq ${row.seq_no}`
        }
      }
    }
    return { valid: true, totalEntries }
  }

  /* ---------- อ่านรายการสำหรับ Timeline / รายงาน ---------- */

  listEntries(
    roomId: string,
    opts: { studentId?: string; ascending?: boolean; limit?: number } = {}
  ): AuditEntryView[] {
    const ascending = opts.ascending ?? false
    const clauses = [`session_id = ?`]
    const params: unknown[] = [roomId]
    if (opts.studentId !== undefined) {
      clauses.push(`student_id = ?`)
      params.push(opts.studentId)
    }
    const order = ascending ? `ASC` : `DESC`
    let sql = `SELECT * FROM audit_logs WHERE ${clauses.join(' AND ')} ORDER BY seq_no ${order}`
    if (opts.limit !== undefined) sql += ` LIMIT ?`
    if (opts.limit !== undefined) params.push(opts.limit)
    const rows = this.db.db.prepare(sql).all(...params) as AuditRow[]
    return rows.map((row) => this.rowToView(row))
  }

  getEntryCount(roomId: string): number {
    const row = this.db.db
      .prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE session_id = ?`)
      .get(roomId) as { count: number }
    return row.count
  }

  /* ---------- internals ---------- */

  private readRows(roomId: string): AuditRow[] {
    return this.db.db
      .prepare(`SELECT * FROM audit_logs WHERE session_id = ? ORDER BY seq_no ASC`)
      .all(roomId) as AuditRow[]
  }

  private getRow(roomId: string, seqNo: number): AuditRow | undefined {
    return this.db.db
      .prepare(`SELECT * FROM audit_logs WHERE session_id = ? AND seq_no = ?`)
      .get(roomId, seqNo) as AuditRow | undefined
  }

  private computeHmac(roomId: string, seqNo: number, entryHash: string): string {
    return computeHmac(
      this.getAuditKey(roomId),
      `${AUDIT_HMAC_PREFIX}|${seqNo}|${entryHash}`
    ).toString('hex')
  }

  private rowToView(row: AuditRow): AuditEntryView {
    let evidence: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(row.payload_json)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        evidence = parsed as Record<string, unknown>
      }
    } catch {
      evidence = { raw: row.payload_json }
    }
    return {
      seqNo: row.seq_no,
      roomId: row.session_id,
      studentId: row.student_id ?? 'HOST',
      serverTimestampMs: row.timestamp_ms,
      clientTimestampMs: row.client_timestamp_ms,
      eventCode: row.event_type,
      category: row.category,
      severity: row.severity as Severity,
      scoreDelta: row.score_delta,
      summaryText: row.summary_text,
      evidence,
      prevHash: row.prev_hash,
      entryHash: row.entry_hash,
      hostHmac: row.host_hmac
    }
  }
}

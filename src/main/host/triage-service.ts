import { DetectionEventCatalog, type DetectionEvent } from '@shared/policy-schema'
import { NetMsgType } from '@shared/protocol-schema'
import {
  EXAM_ENDED_EVENT,
  PROCTOR_EVENT_CODES
} from '@shared/triage'
import type {
  AlertResolution,
  AuditEntryView,
  ChainVerification,
  StudentEvidenceInfo,
  TriageOverviewEvent
} from '@shared/triage'
import type { Severity } from '@shared/types/events'
import type { HostDatabase } from '../storage/db'
import type { HostRoomManager } from '../network/host-room'
import { AuditLogger, deriveAuditKey } from './audit-log'
import { buildEventSummary, TriageEngine } from './triage-engine'

/* ============================================================
 * Phase 3b — TriageService: จุดเชื่อมกลางบนเครื่องแม่
 * AuditLogger (hash chain) + TriageEngine (คัดกรอง) + ปุ่มของผู้คุม
 * ============================================================ */

export interface TriageServiceOptions {
  db: HostDatabase
  getRoom: () => HostRoomManager | null
  sendHostEvent: (channel: string, payload: unknown) => void
  correlationWindowMs?: number
  now?: () => number
}

export class TriageService {
  readonly audit: AuditLogger
  readonly engine: TriageEngine
  private activeRoomId: string | null = null

  constructor(public readonly opts: TriageServiceOptions) {
    this.audit = new AuditLogger(opts.db, (roomId) => this.auditKey(roomId))
    const engineOptions: { correlationWindowMs?: number; now?: () => number } = {}
    if (opts.now !== undefined) engineOptions.now = opts.now
    if (opts.correlationWindowMs !== undefined) engineOptions.correlationWindowMs = opts.correlationWindowMs
    this.engine = new TriageEngine(engineOptions)
  }

  get roomId(): string | null {
    return this.activeRoomId
  }

  /* ---------- lifecycle ของห้อง ---------- */

  startRoom(roomId: string, policyBody: unknown): void {
    this.activeRoomId = roomId
    this.engine.clear()
    this.audit.appendGenesis(roomId, policyBody, this.opts.now?.() ?? Date.now())
  }

  endRoom(roomId: string, reason: string): void {
    if (this.audit.getEntryCount(roomId) === 0) return
    this.audit.append(roomId, {
      studentId: 'HOST',
      eventCode: EXAM_ENDED_EVENT,
      category: 'lifecycle',
      severity: 'normal',
      scoreDelta: 0,
      summaryText: `จบการสอบ (${reason})`,
      evidence: { reason }
    })
    this.activeRoomId = null
  }

  /* ---------- ingest จากท่อข้อมูลตรวจจับ ---------- */

  recordStudentEvents(studentId: string, events: DetectionEvent[]): void {
    const roomId = this.activeRoomId
    if (!roomId) return
    for (const event of events) {
      const entry = this.audit.append(roomId, {
        studentId,
        eventCode: event.code,
        category: DetectionEventCatalog[event.code].category,
        severity: event.severity,
        scoreDelta: event.score,
        summaryText: buildEventSummary(event),
        evidence: event.detail,
        clientTimestampMs: event.occurredAtMs
      })
      this.engine.ingest(studentId, event, entry.seqNo)
    }
    this.pushOverview()
  }

  /** เหตุการณ์ที่เครื่องแม่พบเอง (เช่น exam anomaly, ข้อความแปลกปลอม) */
  recordHostEvent(
    studentId: string | null,
    eventCode: string,
    severity: Severity,
    summaryText: string,
    evidence: Record<string, unknown>,
    scoreDelta = 0
  ): void {
    const roomId = this.activeRoomId
    if (!roomId) return
    const entry = this.audit.append(roomId, {
      studentId: studentId ?? 'HOST',
      eventCode,
      category: 'host',
      severity,
      scoreDelta,
      summaryText,
      evidence
    })
    if (studentId && studentId !== 'HOST' && scoreDelta > 0) {
      this.engine.ingestRawEntry(entry)
    }
    this.pushOverview()
  }

  /* ---------- สถานะการเชื่อมต่อ / freeze ---------- */

  setStudentConnection(studentId: string, online: boolean): void {
    this.engine.setDisconnected(studentId, !online)
    this.pushOverview()
  }

  /* ---------- ปุ่มของผู้คุมสอบ (ทุกกดลง chain ด้วย studentId = 'HOST') ---------- */

  resolveAlerts(studentId: string, resolution: AlertResolution, note?: string): number {
    const roomId = this.activeRoomId
    if (!roomId) return 0
    const affected = this.engine.acknowledgeAlerts(studentId, resolution)
    if (affected === 0 && !note) return 0
    const eventCode =
      resolution === 'cleared' ? PROCTOR_EVENT_CODES.acknowledged : PROCTOR_EVENT_CODES.confirmed
    const summaryText =
      resolution === 'cleared'
        ? `ผู้คุมสอบตรวจแล้ว/ตักเตือนแล้ว (${affected} เหตุการณ์)${note ? ` — ${note}` : ''}`
        : `ผู้คุมสอบยืนยันพบการทุจริต (${affected} เหตุการณ์)${note ? ` — ${note}` : ''}`
    this.audit.append(roomId, {
      studentId: 'HOST',
      eventCode,
      category: 'proctor',
      severity: 'normal',
      scoreDelta: 0,
      summaryText,
      evidence: { targetStudentId: studentId, affectedAlerts: affected, note: note ?? '' }
    })
    this.pushOverview()
    return affected
  }

  sendWarning(studentId: string, message: string): boolean {
    const roomId = this.activeRoomId
    if (!roomId) return false
    const tlsServer = this.opts.getRoom()?.tlsServerInstance
    const delivered = tlsServer !== undefined && tlsServer !== null
    if (delivered) {
      tlsServer.sendToStudent(studentId, NetMsgType.proctorWarning, {
        message,
        sentAtMs: this.opts.now?.() ?? Date.now()
      })
    }
    this.audit.append(roomId, {
      studentId: 'HOST',
      eventCode: PROCTOR_EVENT_CODES.warning,
      category: 'proctor',
      severity: 'normal',
      scoreDelta: 0,
      summaryText: `ผู้คุมสอบส่งข้อความเตือน: ${message}`,
      evidence: { targetStudentId: studentId, message, delivered }
    })
    this.pushOverview()
    return delivered
  }

  setFrozen(studentId: string, frozen: boolean): boolean {
    const roomId = this.activeRoomId
    if (!roomId) return false
    const tlsServer = this.opts.getRoom()?.tlsServerInstance
    const delivered = tlsServer !== undefined && tlsServer !== null
    if (delivered) {
      tlsServer.sendToStudent(
        studentId,
        frozen ? NetMsgType.freezeExam : NetMsgType.unfreezeExam,
        { frozen, reason: frozen ? 'ผู้คุมสอบสั่งแช่เครื่องชั่วคราว' : '' }
      )
    }
    // อัปเดตสถานะในตาราง students (frozen ↔ taking)
    this.opts.db.db
      .prepare(
        `UPDATE students SET status = ? WHERE session_id = ? AND student_id = ? AND status IN ('joined', 'taking', 'frozen')`
      )
      .run(frozen ? 'frozen' : 'taking', roomId, studentId)
    this.engine.setFrozen(studentId, frozen)
    this.audit.append(roomId, {
      studentId: 'HOST',
      eventCode: frozen ? PROCTOR_EVENT_CODES.froze : PROCTOR_EVENT_CODES.unfroze,
      category: 'proctor',
      severity: 'normal',
      scoreDelta: 0,
      summaryText: frozen
        ? 'ผู้คุมสอบสั่ง Freeze เครื่องนักเรียน'
        : 'ผู้คุมสอบปลด Freeze เครื่องนักเรียน',
      evidence: { targetStudentId: studentId, delivered }
    })
    this.pushOverview()
    return delivered
  }

  /* ---------- อ่านข้อมูลสำหรับ Dashboard / รายงาน ---------- */

  getOverview(): TriageOverviewEvent {
    return {
      counts: this.engine.getCounts(),
      students: this.engine.getSortedStudents(),
      serverNowMs: this.opts.now?.() ?? Date.now()
    }
  }

  getStudentEvidence(studentId: string): {
    info: StudentEvidenceInfo | null
    entries: AuditEntryView[]
    chain: ChainVerification
  } {
    const roomId = this.activeRoomId
    if (!roomId) return { info: null, entries: [], chain: { valid: true, totalEntries: 0 } }
    const student = this.opts.getRoom()?.students.find((s) => s.studentId === studentId) ?? null
    const dbRow = this.opts.db.db
      .prepare(`SELECT display_name, status, joined_at_ms FROM students WHERE session_id = ? AND student_id = ?`)
      .get(roomId, studentId) as { display_name: string; status: string; joined_at_ms: number } | undefined
    const view = this.engine.getStudentState(studentId)
    const latestAlertCodes = new Set((view?.alerts ?? []).map((alert) => alert.eventCode))
    const info: StudentEvidenceInfo = {
      studentId,
      studentName: student?.studentName ?? dbRow?.display_name ?? studentId,
      online: student?.online ?? false,
      status: dbRow?.status ?? 'unknown',
      focusState: student?.focusState ?? null,
      joinedAtMs: dbRow?.joined_at_ms ?? null,
      lastSeenAtMs: student?.lastSeenAtMs ?? null,
      frozen: view?.frozen ?? false,
      vmSuspected: latestAlertCodes.has('VM_ENVIRONMENT_DETECTED'),
      remoteSuspected: latestAlertCodes.has('REMOTE_SESSION_SUSPECTED')
    }
    return {
      info,
      entries: this.audit.listEntries(roomId, { studentId, ascending: false }),
      chain: this.audit.verifyAuditChain(roomId)
    }
  }

  verifyChain(roomId?: string): ChainVerification {
    const target = roomId ?? this.activeRoomId
    if (!target) return { valid: true, totalEntries: 0 }
    return this.audit.verifyAuditChain(target)
  }

  /** เวลาเริ่ม/จบ + enforcement ของห้อง (จาก exam_sessions — เวลาอ้างอิงของเครื่องแม่เท่านั้น) */
  getRoomMeta(roomId: string): {
    startedAtMs: number | null
    endedAtMs: number | null
    enforcement: string
  } {
    const row = this.opts.db.db
      .prepare(`SELECT started_at_ms, ended_at_ms, enforcement FROM exam_sessions WHERE id = ?`)
      .get(roomId) as
      | { started_at_ms: number | null; ended_at_ms: number | null; enforcement: string }
      | undefined
    return {
      startedAtMs: row?.started_at_ms ?? null,
      endedAtMs: row?.ended_at_ms ?? null,
      enforcement: row?.enforcement ?? 'report-only'
    }
  }

  getAuditEntries(roomId?: string): AuditEntryView[] {
    const target = roomId ?? this.activeRoomId
    if (!target) return []
    return this.audit.listEntries(target, { ascending: true })
  }

  /* ---------- internals ---------- */

  private auditKey(roomId: string): Buffer {
    const row = this.opts.db.db
      .prepare(`SELECT crypto_salt FROM exam_sessions WHERE id = ?`)
      .get(roomId) as { crypto_salt: string } | undefined
    if (!row) throw new Error(`AUDIT_ROOM_NOT_FOUND: ${roomId}`)
    return deriveAuditKey(row.crypto_salt, roomId)
  }

  pushOverview(): void {
    this.opts.sendHostEvent('host:triage-updated', this.getOverview())
  }
}

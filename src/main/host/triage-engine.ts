import { DetectionEventCatalog, type DetectionEvent } from '@shared/policy-schema'
import {
  PROCTOR_EVENT_CODES,
  ROOM_CREATED_EVENT,
  EXAM_ENDED_EVENT
} from '@shared/triage'
import type {
  AlertResolution,
  AuditEntryView,
  StudentTriageView,
  TriageAlertView,
  TriageCounts,
  TriageLevel
} from '@shared/triage'

/* ============================================================
 * Phase 3b.2 — TriageEngine: คัดกรองเหตุการณ์เป็นสถานะต่อคน
 * - EventCorrelator: รวมเหตุการณ์ซ้ำ (คนเดิม/โค้ดเดิม/หลักฐานเดิม)
 *   ภายในหน้าต่างเวลา อัปเดต occurrenceCount โดยไม่บวกคะแนนซ้ำ
 *   (pid เปลี่ยน = โปรเซสเปิดใหม่ = ความผิดครั้งใหม่ บวกคะแนนทันที)
 * - สถานะ 3 ระดับ: CRITICAL > WARNING > NORMAL ตามเกณฑ์คะแนน
 * - Priority Queue Sorting สำหรับดันคนแดงขึ้นบนสุดเสมอ
 * ============================================================ */

export interface TriageEngineOptions {
  /** ช่วงเวลาที่ถือว่าเป็น "เหตุการณ์เดิมที่ยังค้างอยู่" (detectors poll ~3 วินาที) */
  correlationWindowMs?: number
  now?: () => number
}

/** กลุ่มแจ้งเตือนภายใน (เก็บสถานะค้างไว้ในหน่วยความจำ ระหว่างการสอบ) */
interface InternalAlert extends TriageAlertView {
  firstSeenAtMs: number
}

interface IngestResult {
  alert: TriageAlertView
  isNew: boolean
  scoreDeltaApplied: number
}

/** คีย์กลุ่มหลักฐาน: เหตุการณ์เดียวกัน + หลักฐานหลักตรงกัน = กลุ่มเดียวกัน */
export function computeEvidenceKey(detail: Record<string, string>): string {
  return Object.entries(detail)
    .filter(([key, value]) => value !== '' && key !== 'eventId')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(';')
}

/** สร้างคำสรุปภาษาคนจากเหตุการณ์ตรวจจับ (แสดงบนการ์ด/Timeline) */
export function buildEventSummary(event: DetectionEvent): string {
  const d = event.detail
  const process = d.processName ?? d.exeName ?? d.exe ?? ''
  switch (event.code) {
    case 'DISGUISED_PROCESS_DETECTED':
      return `เปลี่ยนชื่อไฟล์แอบรัน: ${d.displayName ?? process} (ในชื่อ ${d.actualName ?? d.path ?? 'ไม่ทราบชื่อจริง'})`
    case 'BLACKLISTED_PROCESS_DETECTED':
      return `เปิดโปรแกรมต้องห้าม: ${process || d.commandLine || 'ไม่ทราบชื่อ'}`
    case 'FORBIDDEN_DNS_QUERY_DETECTED':
    case 'UNAUTHORIZED_DOMAIN_DETECTED':
      return `พยายามติดต่อโดเมนที่ไม่อนุญาต: ${d.domain ?? 'ไม่ทราบโดเมน'}`
    case 'DIRECT_SOCKET_PROXY_BYPASS':
      return `ต่อออกอินเทอร์เน็ตตรง ๆ ไม่ผ่าน proxy: ${process} → ${d.peerAddress ?? ''}:${d.peerPort ?? ''}`
    case 'CAPTURE_EVADING_WINDOW_DETECTED':
      return `หน้าต่างซ่อนจากการจับภาพหน้าจอ (Stealth Overlay): ${d.windowTitle ?? process}`
    case 'TOPMOST_OVERLAY_WINDOW_DETECTED':
      return `หน้าต่างลอยทับข้อสอบ: ${d.windowTitle ?? process}`
    case 'KIOSK_ESCAPE_ATTEMPT':
      return 'พยายามหลบหนีโหมด Kiosk'
    case 'SYNTHETIC_INPUT_INJECTED':
      return `ตรวจพบอินพุตจากโปรแกรมอัตโนมัติ (Synthetic Input)${process ? ` จาก ${process}` : ''}`
    case 'EXTERNAL_CLIPBOARD_INJECTION':
      return 'มีการวางข้อความจากแอปอื่นข้ามอุปกรณ์'
    case 'DEBUGGER_ATTACHED':
      return 'ตรวจพบ Debugger แนบกับแอป'
    case 'FOREIGN_MODULE_INJECTED':
      return 'ตรวจพบโมดูลแปลกปลอมถูกฉีดเข้าแอป'
    case 'WINDOW_BLUR_PROLONGED': {
      const seconds = d.durationMs ? (Number(d.durationMs) / 1000).toFixed(1) : null
      return seconds ? `หน้าจอเสียโฟกัส ${seconds} วินาที` : 'หน้าจอเสียโฟกัสเป็นเวลานาน'
    }
    case 'WINDOW_BLUR_BRIEF':
      return 'หน้าจอเสียโฟกัสชั่วขณะ'
    case 'ABNORMAL_TYPING_PATTERN':
      return 'จังหวะการพิมพ์ผิดปกติ (น่าสงสัยว่ามีตัวช่วย)'
    case 'DISPLAY_CONFIG_CHANGED':
      return 'การตั้งค่าจอภาพเปลี่ยนระหว่างสอบ'
    case 'GUARD_THREAD_STALLED':
      return `ระบบตรวจจับย่อย (${d.stalledDetector ?? '?'}) หยุดทำงานชั่วคราว`
    case 'NETWORK_TUNNEL_OR_PROXY_TAMPER':
      return 'พยายามปิด/งัดแง้ม proxy หรืออุโมงค์เครือข่าย'
    case 'SUSPICIOUS_COMPUTE_SPIKE':
      return `ใช้ CPU หนักผิดปกติ${process ? ` (${process})` : ''} — อาจรัน AI ในเครื่อง`
    case 'PID_BURST_ANOMALY':
      return 'มีการเปิด-ปิดโปรเซสถี่ผิดปกติ'
    case 'VM_ENVIRONMENT_DETECTED':
      return 'สัญญาณว่ารันอยู่ในเครื่องเสมือน (VM)'
    case 'REMOTE_SESSION_SUSPECTED':
      return `สัญญาณว่าถูกควบคุมจากระยะไกล${process ? ` (${process})` : ''}`
    case 'ATTESTATION_VERIFICATION_FAILED':
      return `ยืนยันความถูกต้องของไฟล์แอปไม่ผ่าน: ${d.reason ?? 'ไม่ทราบสาเหตุ'}`
    case 'BLOCKED_SYSTEM_SHORTCUT':
      return `พยายามกดปุ่มลัดระดับระบบที่ถูกบล็อก: ${d.shortcut ?? 'ไม่ทราบปุ่ม'}`
    case 'UNAUTHORIZED_DOCS_URL_ATTEMPT':
      return `พยายามเปิดเว็บนอกขอบเขตเอกสารที่อนุญาต: ${d.url ?? 'ไม่ทราบ URL'}`
    case 'PROXY_DOMAIN_VIOLATION':
      return `โปรแกรมภายนอกพยายามต่อโดเมนที่ไม่อนุญาตผ่าน proxy: ${d.hostname ?? 'ไม่ทราบโดเมน'}`
    case 'DIRECT_IP_PROXY_ATTEMPT':
      return `พยายามต่อด้วย IP ตรง ๆ เพื่อหลบการตรวจโดเมน: ${d.hostname ?? 'ไม่ทราบปลายทาง'}`
    case 'VSCODE_PROFILE_TAMPERED':
      return d.kind === 'settings-modified'
        ? 'มีการแอบแก้ไขตั้งค่าโปรไฟล์ VS Code ควบคุม (เช่น http.proxy)'
        : 'มีการแอบติดตั้ง/แก้ไข Extension ในโปรไฟล์ VS Code ควบคุม'
    case 'UNAUTHORIZED_IDE_DETECTED':
      return d.kind === 'ai-editor'
        ? `เปิดโปรแกรม AI IDE ที่ต้องห้าม: ${d.processName ?? 'ไม่ทราบชื่อ'}`
        : `เปิด VS Code นอกโปรไฟล์ควบคุมของระบบ: ${d.processName ?? 'ไม่ทราบชื่อ'}`
    default:
      return [event.code, ...Object.entries(d).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`)].join(' · ')
  }
}

export class TriageEngine {
  private readonly correlationWindowMs: number
  private readonly now: () => number
  private readonly alertsByStudent = new Map<string, InternalAlert[]>()
  private readonly disconnected = new Set<string>()
  private readonly frozen = new Set<string>()

  constructor(opts: TriageEngineOptions = {}) {
    this.correlationWindowMs = opts.correlationWindowMs ?? 30_000
    this.now = opts.now ?? Date.now
  }

  /* ---------- ingest เหตุการณ์จากเครื่องนักเรียน ---------- */

  ingest(studentId: string, event: DetectionEvent, seqNo: number): IngestResult {
    const evidenceKey = computeEvidenceKey(event.detail)
    const alertId = `${event.code}|${evidenceKey}`
    const nowMs = this.now()
    const list = this.alertsByStudent.get(studentId) ?? []
    this.alertsByStudent.set(studentId, list)

    const existing = list.find((alert) => alert.alertId === alertId)
    if (existing && existing.status === 'active' && nowMs - existing.lastSeenAtMs <= this.correlationWindowMs) {
      // เหตุการณ์เดิมที่ยังค้างอยู่ → เพิ่มตัวนับ ไม่บวกคะแนนซ้ำ (กัน alert fatigue)
      existing.occurrenceCount += 1
      existing.durationSeconds = Math.max(0, Math.round((nowMs - existing.firstSeenAtMs) / 1000))
      existing.lastSeenAtMs = nowMs
      return { alert: { ...existing }, isNew: false, scoreDeltaApplied: 0 }
    }

    const alert: InternalAlert = {
      alertId,
      studentId,
      eventCode: event.code,
      category: DetectionEventCatalog[event.code].category,
      severity: event.severity,
      summaryText: buildEventSummary(event),
      score: event.score,
      occurrenceCount: 1,
      durationSeconds: 0,
      firstSeqNo: seqNo,
      firstSeenAtMs: nowMs,
      lastSeenAtMs: nowMs,
      status: 'active'
    }
    list.push(alert)
    return { alert: { ...alert }, isNew: true, scoreDeltaApplied: event.score }
  }

  /* ---------- การกดของผู้คุมสอบ ---------- */

  /** ตักเตือนแล้ว (cleared = ถอดคะแนนค้าง) หรือ ยืนยันพบการทุจริต (confirmed = ปักหมุดคะแนนไว้) */
  acknowledgeAlerts(studentId: string, resolution: AlertResolution): number {
    const list = this.alertsByStudent.get(studentId) ?? []
    let affected = 0
    for (const alert of list) {
      if (alert.status !== 'active') continue
      alert.status = resolution === 'cleared' ? 'cleared' : 'confirmed'
      affected += 1
    }
    return affected
  }

  setDisconnected(studentId: string, value: boolean): void {
    if (value) this.disconnected.add(studentId)
    else this.disconnected.delete(studentId)
  }

  setFrozen(studentId: string, value: boolean): void {
    if (value) this.frozen.add(studentId)
    else this.frozen.delete(studentId)
  }

  removeStudent(studentId: string): void {
    this.alertsByStudent.delete(studentId)
    this.disconnected.delete(studentId)
    this.frozen.delete(studentId)
  }

  clear(): void {
    this.alertsByStudent.clear()
    this.disconnected.clear()
    this.frozen.clear()
  }

  /* ---------- สถานะต่อคน + ลำดับความสำคัญ ---------- */

  getStudentState(studentId: string): StudentTriageView | null {
    const list = this.alertsByStudent.get(studentId)
    if (!list && !this.disconnected.has(studentId) && !this.frozen.has(studentId)) return null
    return this.buildView(studentId, list ?? [])
  }

  /** เรียง: CRITICAL (unack มากสุดก่อน → คะแนนสูงก่อน) → DISCONNECTED → WARNING (คะแนนสูงก่อน) → NORMAL (ตามรหัส) */
  getSortedStudents(): StudentTriageView[] {
    const views = [...this.alertsByStudent.keys()]
    for (const id of this.disconnected) if (!views.includes(id)) views.push(id)
    for (const id of this.frozen) if (!views.includes(id)) views.push(id)
    const built = views.map((id) => this.buildView(id, this.alertsByStudent.get(id) ?? []))
    return built.sort(compareTriagePriority)
  }

  getCounts(): TriageCounts {
    const counts: TriageCounts = { total: 0, critical: 0, warning: 0, disconnected: 0, normal: 0 }
    for (const view of this.getSortedStudents()) {
      counts.total += 1
      if (view.triageLevel === 'critical') counts.critical += 1
      else if (view.disconnected) counts.disconnected += 1
      else if (view.triageLevel === 'warning') counts.warning += 1
      else counts.normal += 1
    }
    return counts
  }

  /** เล่นซ้ำ audit chain ทั้งห้องเพื่อสร้างสถานะใหม่ (เช่นหลังเปิดแอปใหม่กลางสอบ) */
  rebuildFromEntries(entries: AuditEntryView[]): void {
    this.clear()
    const ascending = [...entries].sort((a, b) => a.seqNo - b.seqNo)
    for (const entry of ascending) {
      // รายการของผู้คุม (studentId = 'HOST') — ต้องจัดการก่อนข้าม HOST
      if (entry.eventCode === PROCTOR_EVENT_CODES.acknowledged) {
        const target = proctorTargetStudentId(entry)
        if (target) this.acknowledgeAlerts(target, 'cleared')
        continue
      }
      if (entry.eventCode === PROCTOR_EVENT_CODES.confirmed) {
        const target = proctorTargetStudentId(entry)
        if (target) this.acknowledgeAlerts(target, 'confirmed')
        continue
      }
      if (entry.studentId === 'HOST' || entry.eventCode === ROOM_CREATED_EVENT || entry.eventCode === EXAM_ENDED_EVENT) {
        continue
      }
      this.ingestRawEntry(entry)
    }
  }

  /* ---------- internals ---------- */

  /** ingest จากแถว audit โดยตรง (ใช้ตอน replay chain / เหตุการณ์ฝั่งเครื่องแม่) */
  ingestRawEntry(entry: AuditEntryView): void {
    if (entry.scoreDelta <= 0 && entry.severity === 'normal') return
    const detail: Record<string, string> = {}
    for (const [key, value] of Object.entries(entry.evidence)) {
      if (typeof value === 'string') detail[key] = value
      else if (typeof value === 'number' || typeof value === 'boolean') detail[key] = String(value)
    }
    const evidenceKey = computeEvidenceKey(detail)
    const alertId = `${entry.eventCode}|${evidenceKey}`
    const list = this.alertsByStudent.get(entry.studentId) ?? []
    if (list.some((alert) => alert.alertId === alertId)) {
      // เหตุการณ์เดิมจาก chain → นับเพิ่มโดยไม่บวกคะแนน
      const existing = list.find((alert) => alert.alertId === alertId)!
      existing.occurrenceCount += 1
      existing.durationSeconds = Math.max(
        0,
        Math.round((entry.serverTimestampMs - existing.lastSeenAtMs) / 1000)
      )
      existing.lastSeenAtMs = entry.serverTimestampMs
      return
    }
    list.push({
      alertId,
      studentId: entry.studentId,
      eventCode: entry.eventCode,
      category: entry.category,
      severity: entry.severity,
      summaryText: entry.summaryText,
      score: entry.scoreDelta,
      occurrenceCount: 1,
      durationSeconds: 0,
      firstSeqNo: entry.seqNo,
      firstSeenAtMs: entry.serverTimestampMs,
      lastSeenAtMs: entry.serverTimestampMs,
      status: 'active'
    })
    this.alertsByStudent.set(entry.studentId, list)
  }

  private buildView(studentId: string, list: InternalAlert[]): StudentTriageView {
    let activeSuspicionScore = 0
    let unacknowledgedCriticalCount = 0
    let unacknowledgedWarningCount = 0
    let lastEventAtMs: number | null = null
    let latestSummary: string | null = null
    for (const alert of list) {
      if (alert.status !== 'cleared') activeSuspicionScore += alert.score
      if (alert.status === 'active') {
        if (alert.severity === 'critical') unacknowledgedCriticalCount += 1
        else if (alert.severity === 'warning') unacknowledgedWarningCount += 1
      }
      if (lastEventAtMs === null || alert.lastSeenAtMs > lastEventAtMs) {
        lastEventAtMs = alert.lastSeenAtMs
        latestSummary = alert.summaryText
      }
    }
    const disconnected = this.disconnected.has(studentId)
    return {
      studentId,
      activeSuspicionScore,
      unacknowledgedCriticalCount,
      unacknowledgedWarningCount,
      triageLevel: resolveTriageLevel(activeSuspicionScore, unacknowledgedCriticalCount, unacknowledgedWarningCount),
      disconnected,
      frozen: this.frozen.has(studentId),
      lastEventAtMs,
      latestSummary,
      alerts: list.map((alert) => ({ ...alert }))
    }
  }
}

/** เกณฑ์จัดระดับสี: แดง (unack critical > 0 หรือคะแนน ≥ 40) / เหลือง (15–39 หรือมี warning ค้าง) / เขียว */
export function resolveTriageLevel(
  activeSuspicionScore: number,
  unacknowledgedCriticalCount: number,
  unacknowledgedWarningCount: number
): TriageLevel {
  if (unacknowledgedCriticalCount > 0 || activeSuspicionScore >= 40) return 'critical'
  if (activeSuspicionScore >= 15 || unacknowledgedWarningCount > 0) return 'warning'
  return 'normal'
}

/** Priority Queue Sorting ตามลำดับในแผนงาน Phase 3b */
export function compareTriagePriority(a: StudentTriageView, b: StudentTriageView): number {
  const rankOf = (view: StudentTriageView): number => {
    if (view.triageLevel === 'critical') return 0
    if (view.disconnected) return 1
    if (view.triageLevel === 'warning') return 2
    return 3
  }
  const rankDiff = rankOf(a) - rankOf(b)
  if (rankDiff !== 0) return rankDiff
  if (rankOf(a) === 0) {
    const criticalDiff = b.unacknowledgedCriticalCount - a.unacknowledgedCriticalCount
    if (criticalDiff !== 0) return criticalDiff
  }
  if (rankOf(a) <= 2) {
    const scoreDiff = b.activeSuspicionScore - a.activeSuspicionScore
    if (scoreDiff !== 0) return scoreDiff
  }
  return a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0
}

  /** studentId เป้าหมายของรายการที่ผู้คุมกด (เก็บใน evidence.targetStudentId) */
export function proctorTargetStudentId(entry: AuditEntryView): string {
  const target = entry.evidence['targetStudentId']
  return typeof target === 'string' ? target : ''
}

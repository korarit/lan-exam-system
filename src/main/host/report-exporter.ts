import {
  AUDIT_HASH_PREFIX,
  type AuditEntryView,
  type ChainVerification,
  type StudentTriageView
} from '@shared/triage'

/* ============================================================
 * Phase 3b.4 — ReportExporter: รายงานหลังจบการสอบ
 * 1) HTML Incident Report (พิมพ์/แนบเป็นหลักฐานทางวิชาการ)
 * 2) Signed JSON Audit Bundle (.ztaudit) — ข้อมูลดิบ + hash chain
 *    (ความสมบูรณ์พิสูจน์ได้จากสายโซ่เอง ไม่ต้องพึ่งความลับ)
 * ============================================================ */

export interface IncidentReportStudent {
  name: string
  triage: StudentTriageView
  summary: { answeredCount: number; totalQuestions: number; awardedPoints: number; finished: boolean } | null
  entries: AuditEntryView[]
}

export interface IncidentReportInput {
  room: { roomId: string; roomName: string; mode: string; enforcement: string }
  examTitle: string | null
  startedAtMs: number | null
  endedAtMs: number | null
  chain: ChainVerification
  students: IncidentReportStudent[]
  generatedAtMs: number
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatDateTime(ms: number | null): string {
  if (ms === null) return '—'
  return new Date(ms).toLocaleString('th-TH', { hour12: false })
}

function severityLabel(severity: string): string {
  if (severity === 'critical') return 'วิกฤต'
  if (severity === 'warning') return 'เฝ้าระวัง'
  return 'ปกติ'
}

function triageLabel(level: string): string {
  if (level === 'critical') return '🔴 วิกฤต'
  if (level === 'warning') return '🟡 เฝ้าระวัง'
  return '🟢 ปกติ'
}

function evidenceLines(entry: AuditEntryView): string {
  return Object.entries(entry.evidence)
    .filter(([, value]) => value !== '' && value !== undefined)
    .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(typeof value === 'string' ? value : JSON.stringify(value))}`)
    .join('<br/>')
}

/** สร้างรายงาน HTML (เปิดพิมพ์เป็น PDF ได้จากเบราว์เซอร์/Electron print) */
export function buildIncidentReportHtml(input: IncidentReportInput): string {
  const flagged = input.students.filter((student) => student.triage.activeSuspicionScore > 0 || student.triage.alerts.length > 0)
  const chainBadge = input.chain.valid
    ? 'Audit Hash Chain Integrity: Verified ✅'
    : `Audit Hash Chain Integrity: TAMPERED ❌ (${escapeHtml(input.chain.reason ?? 'unknown')} at seq ${input.chain.firstTamperedSeqNo ?? '?'})`
  const chainColor = input.chain.valid ? '#065f46' : '#991b1b'

  const studentSections = flagged
    .map((student) => {
      const rows = student.entries
        .map(
          (entry) => `
          <tr>
            <td>#${entry.seqNo}</td>
            <td>${formatDateTime(entry.serverTimestampMs)}</td>
            <td>${escapeHtml(severityLabel(entry.severity))}</td>
            <td>${escapeHtml(entry.summaryText || entry.eventCode)}</td>
            <td class="mono small">${evidenceLines(entry) || '—'}</td>
            <td class="mono small">${escapeHtml(entry.entryHash.slice(0, 16))}…</td>
          </tr>`
        )
        .join('')
      return `
      <section>
        <h3>${escapeHtml(student.name)} <span class="pill">${escapeHtml(student.triage.studentId)}</span></h3>
        <p>
          ระดับสุดท้าย: <strong>${escapeHtml(triageLabel(student.triage.triageLevel))}</strong> ·
          คะแนนความน่าสงสัย: <strong>${student.triage.activeSuspicionScore}</strong> ·
          เหตุการณ์รวม ${student.triage.alerts.reduce((sum, alert) => sum + alert.occurrenceCount, 0)} ครั้ง
          ${student.summary ? `· ทำไป ${student.summary.answeredCount}/${student.summary.totalQuestions} ข้อ ได้ ${student.summary.awardedPoints} คะแนน` : ''}
        </p>
        ${student.triage.alerts.some((alert) => alert.status === 'confirmed') ? '<p class="confirmed">⚠️ ผู้คุมสอบยืนยันพบการทุจริต (Confirmed Violation)</p>' : ''}
        <table>
          <thead>
            <tr><th>#</th><th>เวลา (เครื่องแม่)</th><th>ระดับ</th><th>เหตุการณ์</th><th>หลักฐาน</th><th>Hash</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`
    })
    .join('')

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8" />
<title>รายงานเหตุการณ์การสอบ — ${escapeHtml(input.room.roomName)}</title>
<style>
  body { font-family: 'Segoe UI', 'Noto Sans Thai', sans-serif; margin: 24px auto; max-width: 900px; color: #111827; }
  h1 { font-size: 20px; } h3 { margin-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 24px; }
  th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; vertical-align: top; font-size: 12px; }
  th { background: #f3f4f6; }
  .mono { font-family: Consolas, monospace; } .small { font-size: 11px; }
  .pill { background: #e5e7eb; border-radius: 999px; padding: 2px 10px; font-size: 12px; }
  .confirmed { color: #991b1b; font-weight: 600; }
  .chain { font-weight: 700; color: ${chainColor}; border: 1px solid currentColor; padding: 8px 12px; border-radius: 8px; }
  section { page-break-inside: avoid; }
</style>
</head>
<body>
<h1>รายงานเหตุการณ์การสอบ (Incident Report)</h1>
<p>
  ห้อง: <strong>${escapeHtml(input.room.roomName)}</strong> (${escapeHtml(input.room.roomId)})<br/>
  โหมด: ${escapeHtml(input.room.mode)} · enforcement: ${escapeHtml(input.room.enforcement)}<br/>
  ชุดข้อสอบ: ${escapeHtml(input.examTitle ?? '—')}<br/>
  เริ่ม: ${formatDateTime(input.startedAtMs)} · จบ: ${formatDateTime(input.endedAtMs)}<br/>
  ออกรายงาน: ${formatDateTime(input.generatedAtMs)}
</p>
<p class="chain">${chainBadge}</p>
<p>ผู้เข้าสอบที่มีเหตุการณ์ผิดปกติ: <strong>${flagged.length}</strong> คน (จากทั้งหมด ${input.students.length} คน)</p>
${studentSections || '<p>ไม่พบเหตุการณ์ผิดปกติในห้องสอบนี้</p>'}
<p class="small mono">Audit format: ${escapeHtml(AUDIT_HASH_PREFIX)} · ตรวจสอบย้อนหลังด้วยไฟล์ .ztaudit ที่แนบร่วมกับรายงานนี้</p>
</body>
</html>`
}

export interface AuditBundleInput {
  format: 'ZTEXAM_AUDIT_BUNDLE_V1'
  roomId: string
  roomName: string
  examTitle: string | null
  exportedAtMs: number
  chain: ChainVerification
  entries: Array<AuditEntryView>
}

/** สร้างเนื้อความไฟล์ .ztaudit (JSON) — ตรวจสอบ hash chain ย้อนหลังได้จากไฟล์เดียว */
export function buildAuditBundle(input: {
  roomId: string
  roomName: string
  examTitle: string | null
  chain: ChainVerification
  entries: AuditEntryView[]
  generatedAtMs: number
}): string {
  const bundle: AuditBundleInput = {
    format: 'ZTEXAM_AUDIT_BUNDLE_V1',
    roomId: input.roomId,
    roomName: input.roomName,
    examTitle: input.examTitle,
    exportedAtMs: input.generatedAtMs,
    chain: input.chain,
    entries: input.entries
  }
  return `${JSON.stringify(bundle, null, 2)}\n`
}

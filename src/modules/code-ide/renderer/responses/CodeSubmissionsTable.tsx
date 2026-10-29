import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, Download, Archive, RotateCcw, Eye, HardDrive } from 'lucide-react'
import type { CodeIdeSubmissionsResponse, CodeIdeSubmissionSummary, CodeIdeWorkspaceStateResponse } from '@shared/ipc-channels'
import StudentProjectInspectorModal from './StudentProjectInspectorModal'

/* ============================================================
 * Phase 10 (10.3) — ตารางสรุปผลคะแนน code-ide ฝั่งครู
 * รายชื่อนักเรียน + ป้ายหมวด/ภาษา + แถบ Test Cases + สถานะคิวตรวจ
 * + Re-grade All + Export CSV/Bundle + เปิดโฟลเดอร์ <studentId>
 * ============================================================ */

function statusBadge(status: CodeIdeSubmissionSummary['status']): string {
  switch (status) {
    case 'graded': return 'bg-emerald-900/50 text-emerald-200'
    case 'grading': return 'bg-sky-900/50 text-sky-200'
    case 'queued': return 'bg-slate-800 text-slate-300'
    case 'blocked': return 'bg-red-900/50 text-red-200'
    case 'error': return 'bg-amber-900/50 text-amber-200'
    default: return 'bg-slate-800 text-slate-300'
  }
}

function scoreBar(passed: number, total: number): string {
  if (total === 0) return '—'
  const icon = passed === total ? '🟢' : passed === 0 ? '🔴' : '🟡'
  return `${icon} ${passed}/${total}`
}

export default function CodeSubmissionsTable(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CodeIdeSubmissionsResponse | null>(null)
  const [workspace, setWorkspace] = useState<CodeIdeWorkspaceStateResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({})

  const refresh = useCallback(() => {
    setLoading(true)
    void window.ztExam
      .getCodeSubmissions()
      .then(setSnapshot)
      .catch((err: unknown) => setActionMsg(`⛔ โหลดข้อมูลไม่สำเร็จ: ${err instanceof Error ? err.message : 'unknown'}`))
      .finally(() => setLoading(false))
    void window.ztExam
      .getCodeWorkspaceState()
      .then(setWorkspace)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 8000)
    return () => clearInterval(timer)
  }, [refresh])

  async function setWorkspaceRoot(): Promise<void> {
    setActionMsg(null)
    const res = await window.ztExam.setCodeWorkspaceRoot()
    if (res.ok) {
      setActionMsg(`📂 ตั้งโฟลเดอร์เก็บงานแล้ว: ${res.rootPath ?? ''} — ระบบสร้าง Subfolder <studentId> ให้อัตโนมัติ`)
      refresh()
    } else if (res.reason !== 'CANCELLED') {
      setActionMsg(`⛔ ตั้งโฟลเดอร์ไม่สำเร็จ: ${res.reason ?? 'unknown'}`)
    }
  }

  async function regradeAll(): Promise<void> {
    setActionMsg('⏳ กำลังตรวจใหม่ทั้งห้อง… (คิวขนานตามคอร์ CPU เครื่องแม่)')
    try {
      const res = await window.ztExam.codeRegradeAll()
      setActionMsg(res.ok ? `✅ ตรวจใหม่เสร็จ: ${res.students ?? 0} คน / ตรวจสำเร็จ ${res.graded ?? 0} งาน` : `⛔ ${res.reason ?? 'failed'}`)
    } catch (err) {
      setActionMsg(`⛔ ตรวจใหม่ไม่สำเร็จ: ${err instanceof Error ? err.message : 'unknown'}`)
    }
    refresh()
  }

  async function exportCsv(): Promise<void> {
    const res = await window.ztExam.exportCodeCsv()
    setActionMsg(res.ok ? `💾 ส่งออก CSV แล้ว: ${res.rootPath ?? ''}` : res.reason === 'CANCELLED' ? null : `⛔ ${res.reason ?? 'failed'}`)
  }

  async function exportBundle(): Promise<void> {
    setActionMsg('⏳ กำลังส่งออกโฟลเดอร์โปรเจกต์ทั้งห้อง…')
    const res = await window.ztExam.exportCodeBundle()
    setActionMsg(res.ok ? `📦 ส่งออกแล้ว: ${res.rootPath ?? ''} (โครงโฟลเดอร์นักเรียนครบ + grading-report.json)` : res.reason === 'CANCELLED' ? null : `⛔ ${res.reason ?? 'failed'}`)
  }

  async function openFolder(studentId: string): Promise<void> {
    const res = await window.ztExam.openCodeStudentFolder({ studentId })
    if (!res.ok) setActionMsg(`⛔ เปิดโฟลเดอร์ไม่สำเร็จ: ${res.reason ?? 'unknown'}`)
  }

  async function saveManual(studentId: string, maxPoints: number): Promise<void> {
    const raw = (manualInputs[studentId] ?? '').trim()
    try {
      const points = raw === '' ? null : Number(raw)
      if (points !== null && (!Number.isFinite(points) || points < 0 || points > maxPoints)) {
        setActionMsg(`⛔ คะแนนต้องอยู่ระหว่าง 0–${maxPoints}`)
        return
      }
      const res = await window.ztExam.codeManualGrade({ studentId, points })
      setActionMsg(res.ok ? `✅ บันทึกคะแนน ${studentId} แล้ว (manual ชนะ auto)` : `⛔ ${res.reason ?? 'failed'}`)
      refresh()
    } catch (err) {
      setActionMsg(`⛔ บันทึกไม่สำเร็จ: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  if (loading && snapshot === null) {
    return <p className="p-8 text-center text-sm text-slate-500">กำลังโหลดงาน code-ide…</p>
  }

  const subs = snapshot?.submissions ?? []
  const maxPoints = snapshot?.maxPoints ?? 0

  return (
    <div className="space-y-3">
      {/* แถบสถานะห้อง + workspace + queue */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
        <span className="font-semibold text-slate-100">
          {snapshot?.packageTitle ?? 'ยังไม่ผูก .ztcode เข้าห้อง'} {snapshot?.category ? `[${snapshot.category}]` : ''} {snapshot?.language ? `(${snapshot.language})` : ''}
        </span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5">คิวตรวจ: {snapshot?.queue.active ?? 0} รัน / {snapshot?.queue.pending ?? 0} รอ</span>
        <span className={`rounded px-1.5 py-0.5 ${workspace?.workspaceOk ? 'bg-emerald-900/50 text-emerald-200' : 'bg-amber-900/50 text-amber-200'}`}>
          {workspace?.rootPath ? `📂 ${workspace.rootPath}` : '📂 ยังไม่เลือกโฟลเดอร์เก็บงานครู'}
        </span>
        <span className="flex-1" />
        <button type="button" onClick={() => void setWorkspaceRoot()} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 hover:border-emerald-500">
          <HardDrive size={13} /> เลือกโฟลเดอร์เก็บงาน
        </button>
        <button type="button" onClick={() => void regradeAll()} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 hover:border-amber-500">
          <RotateCcw size={13} /> ตรวจใหม่ทั้งห้อง
        </button>
        <button type="button" onClick={() => void exportCsv()} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 hover:border-sky-500">
          <Download size={13} /> CSV
        </button>
        <button type="button" onClick={() => void exportBundle()} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 hover:border-sky-500">
          <Archive size={13} /> โฟลเดอร์ทั้งห้อง
        </button>
        <button type="button" onClick={refresh} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 hover:border-slate-500">
          <RefreshCw size={13} /> รีเฟรช
        </button>
      </div>

      {actionMsg !== null && (
        <p className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-[13px] text-slate-200">{actionMsg}</p>
      )}

      {snapshot !== null && snapshot.depsUnsupported.length > 0 && (
        <p className="rounded-xl border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-[13px] text-amber-200">
          ⚠️ Offline libs บางตัวใช้ตรวจ/รันไม่ได้: {snapshot.depsUnsupported.join('; ').slice(0, 400)} — อัปโหลดเป็น .zip/.jar ใหม่แล้วผูกห้องอีกครั้ง
        </p>
      )}

      {snapshot !== null && !snapshot.ok && (
        <p className="rounded-xl border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-[13px] text-amber-200">
          {snapshot.reason === 'ROOM_NOT_OPEN' && 'ยังไม่เปิดห้องสอบ — เปิดห้องก่อนแล้วผูก .ztcode จากแท็บ Code IDE Builder (ปุ่ม “ผูกเข้าห้องสอบ”) '}
          {snapshot.reason === 'ROOM_PACKAGE_NOT_LOADED' && 'ห้องเปิดแล้วแต่ยังไม่ผูกข้อสอบ — ไปที่แท็บ Code IDE Builder แล้วกด “ผูกเข้าห้องสอบ”'}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full min-w-[880px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/60 text-xs text-slate-400">
              <th className="px-3 py-2">นักเรียน</th>
              <th className="px-3 py-2">ไฟล์</th>
              <th className="px-3 py-2">Tests</th>
              <th className="px-3 py-2">Auto</th>
              <th className="px-3 py-2">Manual</th>
              <th className="px-3 py-2">รวม / เต็ม</th>
              <th className="px-3 py-2">สถานะ</th>
              <th className="px-3 py-2">ตรวจ</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => (
              <tr key={s.studentId} className="border-b border-slate-800/60 hover:bg-slate-900/40">
                <td className="px-3 py-2">
                  <div className="font-mono font-semibold text-slate-100">{s.studentId}</div>
                  {s.blockedReason && <div className="mt-0.5 max-w-[260px] truncate text-[11px] text-red-300" title={s.blockedReason}>{s.blockedReason}</div>}
                </td>
                <td className="px-3 py-2 font-mono text-slate-300">{s.fileCount}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-slate-300">{scoreBar(s.passedCount, s.totalCount)}</td>
                <td className="px-3 py-2 font-mono text-slate-300">{s.autoPoints}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <input
                      value={manualInputs[s.studentId] ?? (s.manualPoints !== null ? String(s.manualPoints) : '')}
                      onChange={(e) => setManualInputs((prev) => ({ ...prev, [s.studentId]: e.target.value }))}
                      placeholder="—"
                      className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-xs focus:border-emerald-500 focus:outline-none"
                    />
                    <button type="button" onClick={() => void saveManual(s.studentId, maxPoints)} className="rounded border border-slate-700 px-1.5 py-1 text-[11px] hover:border-emerald-500">
                      บันทึก
                    </button>
                  </div>
                </td>
                <td className="px-3 py-2 font-mono font-semibold text-emerald-200">{s.totalPoints} / {s.maxPoints}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] ${statusBadge(s.status)}`}>{s.status}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => setInspecting(s.studentId)} title="เปิด Mirror IDE Inspector" className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] hover:border-sky-500">
                      <Eye size={12} /> ดูโค้ด
                    </button>
                    <button type="button" onClick={() => void openFolder(s.studentId)} title="เปิดโฟลเดอร์ <studentId> ใน File Explorer" className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] hover:border-emerald-500">
                      <FolderOpen size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {subs.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                  ยังไม่มีงานที่ส่ง — นักเรียนกด “ส่งงาน” ใน IDE แล้วงานจะเข้าแถวตรวจอัตโนมัติที่นี่
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {inspecting !== null && (
        <StudentProjectInspectorModal
          studentId={inspecting}
          maxPoints={maxPoints}
          category={snapshot?.category ?? null}
          language={snapshot?.language ?? null}
          onClose={() => {
            setInspecting(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

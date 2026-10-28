import { useEffect, useState } from 'react'
import { X, Send, Snowflake, ShieldCheck, ShieldX } from 'lucide-react'
import type { AuditEntryView, ChainVerification, StudentEvidenceResponse } from '@shared/ipc-channels'
import { useAppStore } from '../../store/app-store'
import { timeAgo } from '../../store/triage-store'

interface Props {
  studentId: string
  name: string
  nowMs: number
  onClose: () => void
}

/** แผงด้านข้าง: ข้อมูลเครื่อง + Timeline หลักฐาน + แผงบันทึกการตรวจของผู้คุม */
export default function EvidenceTimelineDrawer(props: Props): React.JSX.Element {
  const notify = useAppStore((s) => s.notify)
  const [data, setData] = useState<StudentEvidenceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [resolution, setResolution] = useState<'cleared' | 'confirmed'>('cleared')
  const [note, setNote] = useState('')
  const [warningText, setWarningText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.ztExam
      .getStudentEvidence({ studentId: props.studentId })
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [props.studentId])

  async function submitResolution(): Promise<void> {
    setSubmitting(true)
    try {
      const res = await window.ztExam.resolveTriage({
        studentId: props.studentId,
        resolution,
        note: note.trim() ? note.trim() : undefined
      })
      notify({
        severity: resolution === 'confirmed' ? 'critical' : 'info',
        message:
          resolution === 'cleared'
            ? `บันทึกผลตรวจแล้ว (เคลียร์ ${res.affectedAlerts} เหตุการณ์) — ลง audit chain แล้ว`
            : `ยืนยันพบการทุจริต (${res.affectedAlerts} เหตุการณ์) — ปักหมุดหลักฐานแล้ว`
      })
      setNote('')
      const refreshed = await window.ztExam.getStudentEvidence({ studentId: props.studentId })
      setData(refreshed)
    } catch (err) {
      notify({ severity: 'warning', message: err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ' })
    } finally {
      setSubmitting(false)
    }
  }

  async function sendWarning(): Promise<void> {
    if (!warningText.trim()) return
    try {
      await window.ztExam.sendProctorWarning({ studentId: props.studentId, message: warningText.trim() })
      notify({ severity: 'info', message: 'ส่งข้อความเตือนขึ้นจอนักเรียนแล้ว' })
      setWarningText('')
    } catch (err) {
      notify({ severity: 'warning', message: err instanceof Error ? err.message : 'ส่งไม่สำเร็จ' })
    }
  }

  async function toggleFreeze(): Promise<void> {
    const frozen = !(data?.info?.frozen ?? false)
    try {
      await window.ztExam.setStudentFreeze({ studentId: props.studentId, frozen })
      notify({
        severity: frozen ? 'critical' : 'info',
        message: frozen ? 'สั่ง Freeze เครื่องนักเรียนแล้ว' : 'ปลด Freeze แล้ว'
      })
      const refreshed = await window.ztExam.getStudentEvidence({ studentId: props.studentId })
      setData(refreshed)
    } catch (err) {
      notify({ severity: 'warning', message: err instanceof Error ? err.message : 'สั่งไม่สำเร็จ' })
    }
  }

  const info = data?.info
  const chain: ChainVerification | null = data?.chain ?? null
  const entries: AuditEntryView[] = data?.entries ?? []

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-[26rem] max-w-full flex-col border-l border-slate-800 bg-slate-950 shadow-2xl">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">{props.name}</h3>
          <p className="font-mono text-[10px] text-slate-500">{props.studentId}</p>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          className="rounded-lg border border-slate-700 p-1.5 text-slate-400 transition hover:bg-slate-800"
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading && <p className="py-8 text-center text-sm text-slate-500">กำลังโหลดหลักฐาน…</p>}

        {!loading && info && (
          <>
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-400">
              <div className="mb-1.5 font-medium text-slate-300">ข้อมูลเครื่อง</div>
              <div className="grid grid-cols-2 gap-y-1">
                <span>สถานะ:</span>
                <span className={info.online ? 'text-emerald-300' : 'text-red-300'}>
                  {info.online ? 'ออนไลน์' : 'ออฟไลน์'} ({info.status})
                </span>
                <span>โฟกัส:</span>
                <span>{info.focusState ?? '—'}</span>
                <span>VM:</span>
                <span className={info.vmSuspected ? 'text-amber-300' : ''}>
                  {info.vmSuspected ? 'สัญญาณน่าสงสัย' : 'ไม่พบสัญญาณ'}
                </span>
                <span>Remote:</span>
                <span className={info.remoteSuspected ? 'text-amber-300' : ''}>
                  {info.remoteSuspected ? 'สัญญาณน่าสงสัย' : 'ไม่พบสัญญาณ'}
                </span>
                <span>เข้าห้อง:</span>
                <span>{timeAgo(info.joinedAtMs, props.nowMs) || '—'}</span>
                <span>Last seen:</span>
                <span>{timeAgo(info.lastSeenAtMs, props.nowMs) || '—'}</span>
              </div>
            </div>

            {chain && (
              <div
                className={`mt-2 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
                  chain.valid
                    ? 'border-emerald-800/60 bg-emerald-950/30 text-emerald-300'
                    : 'border-red-800/70 bg-red-950/40 text-red-300'
                }`}
              >
                {chain.valid ? <ShieldCheck size={14} /> : <ShieldX size={14} />}
                Hash Chain: {chain.valid ? 'Verified ✅' : `TAMPERED ❌ (seq ${chain.firstTamperedSeqNo ?? '?'})`}
                <span className="ml-auto font-mono text-[10px]">{chain.totalEntries} รายการ</span>
              </div>
            )}

            {/* Timeline หลักฐาน — เรียงจากล่าสุดขึ้นบน */}
            <div className="mt-3">
              <div className="mb-1.5 text-xs font-medium text-slate-300">
                Timeline เหตุการณ์ ({entries.length})
              </div>
              {entries.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-600">ไม่มีเหตุการณ์บันทึกไว้</p>
              ) : (
                <ul className="space-y-2">
                  {entries.map((entry) => (
                    <li
                      key={entry.seqNo}
                      className={`rounded-xl border px-3 py-2 text-xs ${
                        entry.severity === 'critical'
                          ? 'border-red-900/60 bg-red-950/20'
                          : entry.severity === 'warning'
                            ? 'border-amber-900/50 bg-amber-950/20'
                            : 'border-slate-800 bg-slate-900/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-slate-200">
                          {entry.studentId === 'HOST' ? '🧑‍🏫 ' : ''}
                          {entry.summaryText || entry.eventCode}
                        </span>
                        <span className="shrink-0 text-[10px] text-slate-500">
                          {timeAgo(entry.serverTimestampMs, props.nowMs)}
                        </span>
                      </div>
                      {entry.scoreDelta > 0 && (
                        <span className="mr-1 rounded bg-slate-800 px-1 font-mono text-[10px] text-slate-400">
                          +{entry.scoreDelta} คะแนน
                        </span>
                      )}
                      {entry.eventCode !== entry.summaryText && (
                        <span className="ml-1 font-mono text-[10px] text-slate-600">{entry.eventCode}</span>
                      )}
                      {Object.keys(entry.evidence).length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[10px] text-sky-400 hover:text-sky-300">
                            ข้อมูลทางเทคนิค
                          </summary>
                          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-500">
                            {JSON.stringify(entry.evidence, null, 1)}
                          </pre>
                          <div className="mt-0.5 font-mono text-[9px] text-slate-700">
                            seq #{entry.seqNo} · hash {entry.entryHash.slice(0, 20)}…
                          </div>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      {/* แผงบันทึกการตรวจของผู้คุมสอบ */}
      {info && (
        <div className="border-t border-slate-800 px-4 py-3">
          <div className="mb-1.5 text-xs font-medium text-slate-300">บันทึกผลการตรวจของผู้คุม</div>
          <div className="grid grid-cols-2 gap-2">
            <label
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px] ${
                resolution === 'cleared'
                  ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-200'
                  : 'border-slate-700 text-slate-400'
              }`}
            >
              <input
                type="radio"
                checked={resolution === 'cleared'}
                onChange={() => setResolution('cleared')}
                className="accent-emerald-500"
              />
              ตรวจแล้ว / เข้าใจผิด
            </label>
            <label
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px] ${
                resolution === 'confirmed'
                  ? 'border-red-700/60 bg-red-950/30 text-red-200'
                  : 'border-slate-700 text-slate-400'
              }`}
            >
              <input
                type="radio"
                checked={resolution === 'confirmed'}
                onChange={() => setResolution('confirmed')}
                className="accent-red-500"
              />
              ยืนยันพบการทุจริต
            </label>
          </div>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            maxLength={500}
            placeholder="หมายเหตุของผู้คุม เช่น “เดินไปตรวจที่เครื่อง พบสคริปต์ต่อ API ข้างนอกจริง”"
            className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs focus:border-sky-500 focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void submitResolution()}
              className="flex-1 rounded-xl bg-sky-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:opacity-40"
            >
              บันทึกลง Audit Chain
            </button>
            <button
              type="button"
              onClick={() => void toggleFreeze()}
              className={`inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-xs transition ${
                info.frozen
                  ? 'border-sky-600/70 text-sky-300 hover:bg-sky-950/40'
                  : 'border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Snowflake size={13} /> {info.frozen ? 'ปลด Freeze' : 'Freeze'}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              value={warningText}
              onChange={(event) => setWarningText(event.target.value)}
              maxLength={300}
              placeholder="ข้อความเตือนขึ้นจอนักเรียน…"
              className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs focus:border-amber-500 focus:outline-none"
            />
            <button
              type="button"
              disabled={!warningText.trim()}
              onClick={() => void sendWarning()}
              className="inline-flex items-center gap-1 rounded-xl border border-amber-700/60 px-3 py-1.5 text-xs text-amber-300 transition hover:bg-amber-950/40 disabled:opacity-40"
            >
              <Send size={12} /> ส่ง
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

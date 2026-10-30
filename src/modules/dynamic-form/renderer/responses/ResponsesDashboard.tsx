import { useEffect, useMemo, useState } from 'react'
import { BarChart3, Rows3, UserSquare2, Download, PackagePlus, FolderOpen, RefreshCw, RotateCcw, Lock, EyeOff, Paperclip } from 'lucide-react'
import type {
  FormResponsesSnapshot,
  FormStudentResponsesView,
  FormItemAnswerView
} from '../../shared/form-responses-view'
import { isFormItemQuestion, INPUT_TYPE_LABELS } from '../../shared/form-schema'

/* ============================================================
 * Phase 7 (7.3.1) — Responses Dashboard (สไตล์แท็บ Responses)
 * 3 มุมมอง:
 *  1. Summary — สรุปคะแนน + กราฟ + สถิติรายข้อ (ตอบผิด >70% เตือน)
 *  2. By Question — ตรวจรายข้อเร็ว (Blind Grading + Enter ไปคนถัดไป)
 *  3. Individual — ใบคำตอบรายบุคคล + สถานะความปลอดภัย
 * ============================================================ */

type HostApi = typeof window.ztExam

type TabId = 'summary' | 'by-question' | 'individual'

export default function ResponsesDashboard(): React.JSX.Element {
  const api = window.ztExam as HostApi
  const [snapshot, setSnapshot] = useState<FormResponsesSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [tab, setTab] = useState<TabId>('summary')

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      setSnapshot(await api.getFormResponses())
      const state = await api.getFormState()
      setNotice(
        state.formTitle === null
          ? 'ยังไม่มีฟอร์มถูกผูกกับห้อง — เปิด/บันทึกฟอร์มใน Builder แล้วกด Attach ข้อสอบ'
          : null
      )
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'โหลดข้อมูลผลสอบไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }

  const attachForm = async (): Promise<void> => {
    try {
      const res = await api.loadZtform({})
      if (res.ok && res.formPayloadJson !== undefined) {
        await api.attachRoomForm({ formPayloadJson: res.formPayloadJson })
        await refresh()
      } else if (res.message !== undefined) {
        setNotice(res.message)
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'เปิดฟอร์มไม่สำเร็จ')
    }
  }

  const regradeAll = async (): Promise<void> => {
    const confirmed = window.confirm('คำนวณคะแนนใหม่ทั้งห้อง (Re-grade All)? คำตอบดิบไม่เปลี่ยน แต่คะแนนตรวจอัตโนมัติอัปเดตตามเฉลยล่าสุด')
    if (!confirmed) return
    try {
      const res = await api.formRegradeAll({})
      if (res.ok) {
        setNotice(`ตรวจใหม่แล้ว ${res.students ?? 0} คน • ข้อที่เปลี่ยน ${res.changedItems ?? 0} รายการ (${(res.totalDeltaPoints ?? 0) > 0 ? '+' : ''}${res.totalDeltaPoints ?? 0} คะแนน)`)
        await refresh()
      } else {
        setNotice(`Re-grade ไม่สำเร็จ: ${res.reason ?? '?'}`)
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Re-grade ไม่สำเร็จ')
    }
  }

  const exportCsv = async (): Promise<void> => {
    try {
      const res = await api.exportFormCsv()
      const suffix = hasFileUpload ? ' — หมายเหตุ: คอลัมน์ file_upload เป็นชื่อไฟล์/สถานะเท่านั้น ไม่มีไบนารี (F-1 เก็บไฟล์จริงช่องทางอื่น)' : ''
      setNotice(res.ok && res.filePath !== undefined ? `บันทึก CSV แล้ว: ${res.filePath}${suffix}` : `Export CSV ไม่สำเร็จ: ${res.reason ?? '?'}`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Export CSV ไม่สำเร็จ')
    }
  }

  const saveZtresults = async (encrypted: boolean): Promise<void> => {
    try {
      const passwordFromPrompt = encrypted ? window.prompt('ตั้งรหัสผ่านของไฟล์ .ztresults (ใช้เปิดที่เครื่องอื่น)') : null
      if (encrypted && passwordFromPrompt === null) return
      const res = await api.saveZtresults({ encrypted, ...(passwordFromPrompt !== null ? { password: passwordFromPrompt } : {}) })
      setNotice(res.ok && res.filePath !== undefined ? `บันทึกผลสอบแล้ว: ${res.filePath}` : `Save .ztresults ไม่สำเร็จ: ${res.reason ?? '?'}`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Save .ztresults ไม่สำเร็จ')
    }
  }

  const loadZtresults = async (): Promise<void> => {
    try {
      const res = await api.loadZtresults({})
      if (res.ok && res.manifest !== undefined) {
        await refresh()
        setNotice(`เปิดไฟล์ผลสอบแล้ว: ${res.manifest.formTitle} (${res.manifest.studentCount} คน) จากห้อง ${res.manifest.roomName}`)
      } else if (res.needPassword === true) {
        const password = window.prompt('ไฟล์ถูกเข้ารหัส — กรอกรหัสผ่านของครู')
        if (!password) return
        const retry = await api.loadZtresults({ password })
        if (retry.ok && retry.manifest !== undefined) {
          await refresh()
          setNotice(`เปิดไฟล์ผลสอบแล้ว: ${retry.manifest.formTitle} (${retry.manifest.studentCount} คน)`)
        } else {
          setNotice(retry.message ?? 'เปิดไฟล์ไม่สำเร็จ')
        }
      } else {
        setNotice(res.message ?? 'เปิดไฟล์ไม่สำเร็จ')
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'เปิดไฟล์ไม่สำเร็จ')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const questions = useMemo(() => {
    if (snapshot === null) return []
    return snapshot.form.items.filter(isFormItemQuestion)
  }, [snapshot])
  const questionList = useMemo(
    () =>
      questions.map((q, idx) => ({
        itemId: q.itemId,
        prompt: q.prompt,
        index: idx + 1
      })),
    [questions]
  )
  const hasFileUpload = useMemo(
    () => questions.some((q) => q.inputType === 'file_upload'),
    [questions]
  )

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <Rows3 size={18} className="text-emerald-400" />
            {snapshot?.formTitle ?? 'ผลสอบ Dynamic Form'}
          </h2>
          <p className="text-xs text-slate-500">
            ห้อง {snapshot?.roomName ?? '—'} • โหมด {snapshot === null ? '—' : snapshot.kind === 'archive' ? 'เปิดจากไฟล์ .ztresults' : 'ฐานข้อมูลเครื่องแม่'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button type="button" onClick={attachForm} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 hover:border-emerald-600">
            ผูกฟอร์ม (.ztform)
          </button>
          <button type="button" onClick={regradeAll} className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 hover:border-amber-500">
            <RotateCcw size={12} /> Re-grade All
          </button>
          <button type="button" onClick={exportCsv} className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 hover:border-emerald-600">
            <Download size={12} /> Export CSV
          </button>
          <button type="button" onClick={() => saveZtresults(false)} className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 hover:border-emerald-600">
            <PackagePlus size={12} /> Save .ztresults
          </button>
          <button type="button" onClick={() => saveZtresults(true)} className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 hover:border-emerald-600">
            <Lock size={12} /> Save (เข้ารหัส)
          </button>
          <button type="button" onClick={loadZtresults} className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 hover:border-emerald-600">
            <FolderOpen size={12} /> เปิด .ztresults
          </button>
          <button type="button" onClick={refresh} className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 hover:border-emerald-600">
            <RefreshCw size={12} /> รีเฟรช
          </button>
        </div>
      </header>

      {hasFileUpload && snapshot !== null && (
        <div
          title="F-1: ท่อ LAN ยังไม่ส่งไบนารีไฟล์แนบ ตาราง/Export โชว์เฉพาะชื่อไฟล์/สถานะ ไฟล์จริงเก็บผ่านช่องทางอื่น — กันครูเข้าใจผิด"
          className="rounded-xl border border-amber-800/60 bg-amber-950/30 px-4 py-2 text-xs text-amber-200"
        >
          📎 <b>ฟอร์มนี้มีข้อ file_upload — ไฟล์แนบยังไม่ส่งผ่านเครือข่าย (F-1)</b>
          <span className="mt-0.5 block text-amber-200/80">
            ตาราง/Export แสดงเฉพาะชื่อไฟล์/สถานะ ไม่มีไบนารี — เก็บไฟล์จริงผ่านช่องทางอื่นที่นัดกับนักเรียนไว้ อย่าตีความว่า “ไม่ส่ง = ทุจริต/ได้ 0 เพราะไฟล์หาย”
          </span>
        </div>
      )}

      {notice !== null && notice.length > 0 && (
        <div className="rounded-xl border border-emerald-800/60 bg-emerald-950/40 px-4 py-2 text-xs text-emerald-200">{notice}</div>
      )}

      <nav className="flex gap-1 border-b border-slate-800">
        {(
          [
            { id: 'summary', label: 'สรุปภาพรวม', icon: <BarChart3 size={13} /> },
            { id: 'by-question', label: 'ตรวจรายข้อ (เร็วที่สุด)', icon: <Rows3 size={13} /> },
            { id: 'individual', label: 'ใบคำตอบรายบุคคล', icon: <UserSquare2 size={13} /> }
          ] as Array<{ id: TabId; label: string; icon: React.ReactNode }>
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-t-lg px-4 py-2 text-sm transition ${
              tab === t.id ? 'border-b-2 border-emerald-500 font-semibold text-emerald-300' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && snapshot === null ? (
          <div className="p-8 text-center text-sm text-slate-500">กำลังโหลดผลสอบ…</div>
        ) : snapshot === null ? (
          <div className="p-8 text-center text-sm text-slate-500">
            ยังไม่มีผลตอบ — ผูกฟอร์มกับห้อง หรือเปิดไฟล์ .ztresults ย้อนหลัง
          </div>
        ) : tab === 'summary' ? (
          <SummaryTab snapshot={snapshot} />
        ) : tab === 'by-question' ? (
          <ByQuestionTab snapshot={snapshot} questionList={questionList} />
        ) : (
          <IndividualTab snapshot={snapshot} />
        )}
      </div>
    </div>
  )
}

/* ---------- มุมมอง 1: สรุปภาพรวม + สถิติรายข้อ ---------- */

function SummaryTab({ snapshot }: { snapshot: FormResponsesSnapshot }): React.JSX.Element {
  const dist = snapshot.distribution
  const distMax = Math.max(1, ...dist.map((d) => d.count))
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {[
          { label: 'นักเรียน', value: String(snapshot.summary.studentCount) },
          { label: 'คะแนนเฉลี่ย (%)', value: snapshot.summary.mean.toFixed(1) },
          { label: 'คะแนนกลาง (%)', value: snapshot.summary.median.toFixed(1) },
          { label: 'สูงสุด (%)', value: snapshot.summary.max.toFixed(1) },
          { label: 'ต่ำสุด (%)', value: snapshot.summary.min.toFixed(1) },
          { label: 'รอตรวจอัตนัย', value: String(snapshot.summary.needsManualCount) }
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <p className="text-[11px] text-slate-500">{card.label}</p>
            <p className="mt-1 text-lg font-semibold text-slate-100">{card.value}</p>
          </div>
        ))}
      </div>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">การกระจายคะแนน (โดย %)</h3>
        <div className="flex h-36 items-end gap-3">
          {dist.map((bucket) => (
            <div key={bucket.bucketLow} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-xs text-slate-400">{bucket.count > 0 ? bucket.count : ''}</span>
              <div
                className="w-full rounded-t-md bg-gradient-to-t from-emerald-700 to-emerald-500"
                style={{ height: `${Math.round((bucket.count / distMax) * 100)}%`, minHeight: bucket.count > 0 ? 4 : 2 }}
              />
              <span className="text-[10px] text-slate-500">
                {bucket.bucketLow}–{bucket.bucketHigh}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">สถิติรายข้อ (Question Breakdown)</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="pb-2">#</th>
                <th className="pb-2">โจทย์</th>
                <th className="pb-2">ชนิด</th>
                <th className="pb-2">ตอบ</th>
                <th className="pb-2">ถูกเต็ม</th>
                <th className="pb-2">อัตราถูก</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.itemStats.map((stat) => {
                const prompt = snapshot.form.items.find((i) => i.itemId === stat.itemId)
                const label = prompt !== undefined && isFormItemQuestion(prompt) ? prompt.prompt : stat.itemId
                const typeLabel =
                  stat.inputType in INPUT_TYPE_LABELS ? INPUT_TYPE_LABELS[stat.inputType as keyof typeof INPUT_TYPE_LABELS] : stat.inputType
                return (
                  <tr key={stat.itemId} className="border-t border-slate-800/70">
                    <td className="py-1.5">Q{stat.index}</td>
                    <td className="max-w-[280px] truncate py-1.5">{label.length > 0 ? label : stat.itemId}</td>
                    <td className="py-1.5 text-slate-500">{typeLabel}</td>
                    <td className="py-1.5">{stat.responsesCount}</td>
                    <td className="py-1.5">{stat.correctCount}</td>
                    <td className="py-1.5">
                      {Math.round(stat.correctRate * 100)}%
                      {stat.flaggedHard && <span className="ml-2 rounded bg-red-950/60 px-1.5 py-0.5 text-[10px] text-red-300">ตอบผิดเกิน 70% — ตรวจโจทย์</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {snapshot.regradeHistory.length > 0 && (
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-xs text-slate-400">
          <h3 className="mb-2 text-sm font-semibold text-slate-200">ประวัติการ Re-grade</h3>
          <ul className="space-y-1">
            {snapshot.regradeHistory.slice(0, 8).map((h) => (
              <li key={h.runAtMs}>
                {new Date(h.runAtMs).toLocaleString('th-TH')} — {h.summaryJson}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/* ---------- มุมมอง 2: ตรวจรายข้อ (Blind Grading) ---------- */

function ByQuestionTab({
  snapshot,
  questionList
}: {
  snapshot: FormResponsesSnapshot
  questionList: Array<{ itemId: string; prompt: string; index: number }>
}): React.JSX.Element {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [blind, setBlind] = useState(false)
  const effective = selectedItemId ?? questionList[0]?.itemId ?? null

  const allPending = snapshot.students.some(
    (s) => s.items.some((i) => i.itemId === effective && i.status === 'needs-manual')
  )
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
          value={effective ?? ''}
          onChange={(e) => setSelectedItemId(e.target.value)}
        >
          {questionList.map((q) => (
            <option key={q.itemId} value={q.itemId}>
              Q{q.index}: {q.prompt.length > 0 ? q.prompt.slice(0, 40) : q.itemId}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setBlind(!blind)}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs ${blind ? 'border-amber-500 text-amber-300' : 'border-slate-700 text-slate-300'}`}
        >
          <EyeOff size={12} /> {blind ? 'Blind Grading เปิดอยู่' : 'Blind Grading'}
        </button>
        {allPending && <span className="rounded bg-amber-950/60 px-2 py-1 text-[11px] text-amber-300">ข้อนี้มีคำตอบรอครูตรวจ</span>}
      </div>
      <div className="space-y-3">
        {snapshot.students.map((student) => {
          const view = student.items.find((i) => i.itemId === effective)
          if (view === undefined) return null
          return <GradingRow key={student.studentId} student={student} view={view} blind={blind} snapshot={snapshot} />
        })}
      </div>
    </div>
  )
}

function GradingRow({
  student,
  view,
  blind,
  snapshot
}: {
  student: FormStudentResponsesView
  view: FormItemAnswerView
  blind: boolean
  snapshot: FormResponsesSnapshot
}): React.JSX.Element {
  const api = window.ztExam
  const [points, setPoints] = useState<string>(
    view.manualPoints !== null ? String(view.manualPoints) : view.status === 'auto-graded' ? String(view.earnedPoints) : ''
  )
  const handIn = async (): Promise<void> => {
    const n = points.trim().length === 0 ? null : Number(points)
    if (n !== null && !Number.isFinite(n)) return
    await api.formManualGrade({ studentId: student.studentId, itemId: view.itemId, points: n })
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') void handIn()
  }
  const needManual = view.status === 'needs-manual'
  const formItem = snapshot.form.items.find((i) => i.itemId === view.itemId)
  const isFileUpload = formItem !== undefined && isFormItemQuestion(formItem) && formItem.inputType === 'file_upload'
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-100">{blind ? 'ผู้สอบ ' + student.studentId.slice(0, 6) + '…' : student.studentName}</p>
          <p className="text-[11px] text-slate-500">
            ส่งเมื่อ {student.submittedAtMs === null ? 'ยังไม่ส่ง' : new Date(student.submittedAtMs).toLocaleString('th-TH')} • ใช้เวลา {Math.round((view.journey?.timeSpentMs ?? 0) / 1000)} วินาที
          </p>
        </div>
        <span className={`rounded px-2 py-1 text-[10px] ${view.status === 'auto-graded' ? 'bg-emerald-950/60 text-emerald-300' : view.status === 'needs-manual' ? 'bg-amber-950/60 text-amber-300' : 'bg-slate-800 text-slate-300'}`}>
          {view.status} • {view.earnedPoints}/{view.maxPoints}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-200">{view.displayValue.length > 0 ? view.displayValue : '(ไม่ตอบ)'}</p>
      {isFileUpload && (
        <p
          title="F-1: LAN ยังไม่ส่งไบนารีไฟล์แนบ — รายการนี้เป็น descriptor/ชื่อไฟล์เท่านั้น"
          className="mt-2 rounded-lg border border-amber-800/60 bg-amber-950/30 px-2.5 py-1.5 text-[11px] text-amber-200"
        >
          📎 ข้อนี้เป็น file_upload (F-1) — ยังไม่มีไบนารีผ่าน LAN{view.artifacts.length === 0 ? ' (ไม่มีไฟล์แนบมาถึง — เก็บไฟล์จริงช่องทางอื่น)' : ' (รายการด้านล่างเป็น descriptor/ลิงก์เท่านั้น)'}
        </p>
      )}
      {view.artifacts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {view.artifacts.map((a) => (
            <button
              key={a.artifactId}
              type="button"
              title="F-1: เปิดได้เฉพาะ descriptor/ไฟล์ที่ครูนำเข้าช่องทางอื่นแล้ว — ไม่ใช่ไบนารีที่นักเรียนอัปโหลดผ่าน LAN"
              onClick={() => void window.ztExam.openFormArtifact({ studentId: student.studentId, itemId: view.itemId, artifactId: a.artifactId })}
              className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-emerald-600"
            >
              <Paperclip size={10} /> {a.fileName} ({Math.round(a.sizeBytes / 1024)} KB)
            </button>
          ))}
        </div>
      )}
      {needManual && view.keywordHits !== undefined && (
        <p className="mt-1 text-[11px] text-amber-300/90">
          พบ Keyword {view.keywordHits}/{view.keywordTotal} คำ: {view.keywordFound?.join(', ') ?? '—'}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <input
          type="number"
          step="0.5"
          value={points}
          onChange={(e) => setPoints(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`คะแนน (เต็ม ${view.maxPoints})`}
          className="w-32 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
        />
        <button type="button" onClick={handIn} className="rounded-lg border border-emerald-700 bg-emerald-900/40 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-900/70">
          ให้คะแนน
        </button>
        {(view.status === 'needs-manual' || view.status === 'invalid') && (
          <button type="button" onClick={() => void api.formManualGrade({ studentId: student.studentId, itemId: view.itemId, points: null })} className="text-[11px] text-slate-500 hover:text-slate-300">
            ล้างคะแนน
          </button>
        )}
        <span className="text-[11px] text-slate-600">
          {snapshot.form.items.find((i) => i.itemId === view.itemId) && view.correctDisplay !== null ? `เฉลย: ${view.correctDisplay}` : ''}
        </span>
      </div>
    </div>
  )
}

/* ---------- มุมมอง 3: ใบคำตอบรายบุคคล ---------- */

function IndividualTab({ snapshot }: { snapshot: FormResponsesSnapshot }): React.JSX.Element {
  const [selectedStudent, setSelectedStudent] = useState<string | null>(null)
  const effective = selectedStudent ?? snapshot.students[0]?.studentId ?? null
  const student = snapshot.students.find((s) => s.studentId === effective)
  if (student === undefined) {
    return <div className="p-8 text-center text-sm text-slate-500">ยังไม่มีข้อมูลนักเรียน</div>
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <select
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs"
          value={effective ?? ''}
          onChange={(e) => setSelectedStudent(e.target.value)}
        >
          {snapshot.students.map((s) => (
            <option key={s.studentId} value={s.studentId}>
              {s.studentName} ({Math.round(s.totals.percent)}%)
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2 text-xs">
          <SecurityBadge status={student.security.status} />
          <span className="text-slate-500">คะแนนความน่าสงสัย {student.security.suspicionScore} • เหตุการณ์วิกฤต {student.security.criticalEvents}</span>
        </div>
        <div className="ml-auto text-xs text-slate-300">
          คะแนน <b>{student.totals.totalPoints}</b>/{student.totals.maxPoints} ({student.totals.percent.toFixed(1)}%) • รอตรวจ {student.totals.needsManualCount} ข้อ
        </div>
      </div>
      <div className="space-y-2">
        {student.items.map((view, idx) => (
          <div key={view.itemId} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <p className="font-medium text-slate-100">
                Q{idx + 1}. {promptOf(snapshot, view.itemId, false)}
              </p>
              <span className={`shrink-0 rounded px-2 py-1 text-[10px] ${statusColor(view.status)}`}>
                {view.status} • {view.earnedPoints}/{view.maxPoints}
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-slate-200">{view.displayValue.length > 0 ? view.displayValue : '(ไม่ตอบ)'}</p>
            {view.correctDisplay !== null && <p className="mt-1 text-[11px] text-emerald-300/80">เฉลย: {view.correctDisplay}</p>}
            <p className="mt-1 text-[11px] text-slate-500">
              ใช้เวลา {Math.round((view.journey?.timeSpentMs ?? 0) / 1000)} วิ {view.violations.length > 0 ? `• ผิดกฎ: ${view.violations.map((v) => v.code).join(', ')}` : ''}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

function promptOf(snapshot: FormResponsesSnapshot, itemId: string, short: boolean): string {
  const item = snapshot.form.items.find((i) => i.itemId === itemId)
  const text = item !== undefined && isFormItemQuestion(item) ? item.prompt : itemId
  const stat = snapshot.itemStats.find((s) => s.itemId === itemId)
  const prefix = stat !== undefined ? `Q${stat.index}` : ''
  const body = text.length > 0 ? text : itemId
  return short ? (prefix.length > 0 ? `${prefix} ${body.slice(0, 34)}` : body.slice(0, 34)) : body
}

function statusColor(status: FormItemAnswerView['status']): string {
  switch (status) {
    case 'auto-graded':
      return 'bg-emerald-950/60 text-emerald-300'
    case 'needs-manual':
      return 'bg-amber-950/60 text-amber-300'
    case 'manual-graded':
      return 'bg-sky-950/60 text-sky-300'
    case 'invalid':
      return 'bg-red-950/60 text-red-300'
    default:
      return 'bg-slate-800 text-slate-300'
  }
}

function SecurityBadge({ status }: { status: FormStudentResponsesView['security']['status'] }): React.JSX.Element {
  const cls =
    status === 'CRITICAL'
      ? 'bg-red-950/60 text-red-300'
      : status === 'WARNING'
        ? 'bg-amber-950/60 text-amber-300'
        : 'bg-emerald-950/60 text-emerald-300'
  return <span className={`rounded px-2 py-1 text-[10px] font-semibold ${cls}`}>{status}</span>
}

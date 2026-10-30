import { useEffect, useState } from 'react'
import { AlarmClock, BookOpenText, Signal, Save, BookMarked } from 'lucide-react'
import { useStudentExamStore } from '../store/exam-store'
import { useDocsStore } from '../store/docs-store'

export interface HudBarProps {
  connectionOk: boolean
}

function formatClock(total: number): string {
  const s = Math.max(0, total)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = m.toString().padStart(m >= 0 ? 2 : 1, '0')
  const ss = sec.toString().padStart(2, '0')
  return h > 0 ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  return s < 3 ? 'เมื่อไม่กี่วินาทีที่แล้ว' : `${s} วินาทีที่แล้ว`
}

/**
 * Top HUD Bar (checklist 2.5.3):
 * ชื่อวิชา • ข้าที่กำลังทำ • สถานะการบันทึกอัตโนมัติ • เวลาหน่วยที่เหลือ (สีเปลี่ยนตามเวลา)
 */
export default function HudBar(props: HudBarProps): React.JSX.Element {
  const examTitle = useStudentExamStore((s) => s.examTitle)
  const question = useStudentExamStore((s) => s.question)
  const remaining = useStudentExamStore((s) => s.remainingSeconds)
  const lastTickAtMs = useStudentExamStore((s) => s.lastTickAtMs)
  const lastDraftSavedAtMs = useStudentExamStore((s) => s.lastDraftSavedAtMs)
  const examMode = useStudentExamStore((s) => s.examMode)
  const docsOpen = useDocsStore((s) => s.docs?.open ?? false)
  const [, setNow] = useState(Date.now())

  // นาฬิกาแบบ derived: server tick เป็น authoritative แล้วลบเวลาที่ผ่านไปเอง
  // (ไม่ mutate store ทุกวิ — กันเดินซ้อนกับ exam:tick, TC-S18)
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  const tickAgeMs = lastTickAtMs === null ? 0 : Math.max(0, Date.now() - lastTickAtMs)
  const displayRemaining = Math.max(0, remaining - Math.floor(tickAgeMs / 1000))
  // เวลาประมาณเมื่อ tick ล่าสุดนานเกิน 2 วิ
  const approx = lastTickAtMs !== null && tickAgeMs > 2000

  const timerClass =
    displayRemaining <= 60
      ? 'text-red-400 border-red-800/60 bg-red-950/50'
      : displayRemaining <= 300
        ? 'text-orange-300 border-orange-800/50 bg-orange-950/40'
        : 'text-emerald-300 border-emerald-800/50 bg-emerald-950/30'

  return (
    <div className="flex items-center gap-4 border-b border-slate-800 bg-slate-950/90 px-6 py-3 text-sm">
      <div className="flex items-center gap-2 font-semibold text-slate-200">
        <BookOpenText size={16} className="text-sky-400" />
        <span className="max-w-[16rem] truncate">{examTitle ?? 'ข้อสอบ'}</span>
      </div>

      {question && (
        <div className="text-slate-400">
          ข้อที่ <span className="font-mono text-slate-100">{question.cursorIndex + 1}</span>
          {' / '}
          <span className="font-mono">{question.questionCount}</span>
        </div>
      )}

      {/* Phase 5 (Mode 2): ปุ่มเปิด/ปิดแผงเอกสารครึ่งขวา */}
      {examMode === 'in-app-docs' && (
        <button
          type="button"
          onClick={() => void window.ztExam.docsToggle({ open: !docsOpen })}
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
            docsOpen
              ? 'border-sky-700/60 bg-sky-950/50 text-sky-200'
              : 'border-slate-700 bg-slate-900/70 text-slate-300 hover:border-slate-500'
          }`}
        >
          <BookMarked size={13} />
          {docsOpen ? 'ปิดเอกสาร' : 'เปิดเอกสาร'}
        </button>
      )}

      <div className="ml-auto flex items-center gap-1.5 text-slate-400">
        <Save size={14} />
        <span>{lastDraftSavedAtMs ? `บันทึกอัตโนมัติ ${timeAgo(lastDraftSavedAtMs)}` : 'ยังไม่มีการบันทึก'}</span>
      </div>

      <div
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
          props.connectionOk ? 'text-emerald-300 border-emerald-800/60 bg-emerald-950/40' : 'text-red-300 border-red-800/60 bg-red-950/50'
        }`}
      >
        <Signal size={13} />
        {props.connectionOk ? 'เครื่องแม่' : 'ขาดการติดต่อ'}
      </div>

      <div className={`flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-base font-bold tabular-nums ${timerClass}`}>
        <AlarmClock size={16} />
        {approx ? '≈' : ''}{formatClock(displayRemaining)}
      </div>
    </div>
  )
}

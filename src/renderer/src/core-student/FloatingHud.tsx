import { useEffect } from 'react'
import { AlarmClock, ExternalLink, Signal, FileCode2 } from 'lucide-react'
import { useStudentExamStore } from '../store/exam-store'
import { useStudentNetworkStore } from '../store/network-store'

/* ============================================================
 * FloatingHud (Phase 5 — Mode 3): หน้าต่างจิ๋ว always-on-top
 * เวลาที่เหลือ + สถานะเชื่อมต่อ + ปุ่มเปิด VS Code ควบคุม + กลับมาดูโจทย์
 * เรนเดอร์ใน BrowserWindow แยก (hash `#floating-hud`) — store ของตัวเอง
 * ============================================================ */

function formatClock(total: number): string {
  const s = Math.max(0, total)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = m.toString().padStart(2, '0')
  const ss = sec.toString().padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

let hudSubscribed = false

export default function FloatingHud(): React.JSX.Element {
  const phase = useStudentExamStore((s) => s.phase)
  const question = useStudentExamStore((s) => s.question)
  const remaining = useStudentExamStore((s) => s.remainingSeconds)
  const connection = useStudentNetworkStore((s) => s.connection)

  useEffect(() => {
    if (hudSubscribed) return
    hudSubscribed = true
    window.ztExam.onEvent('exam:question', (payload) =>
      useStudentExamStore.getState().onQuestion(payload)
    )
    window.ztExam.onEvent('exam:tick', (payload) => useStudentExamStore.getState().onTick(payload))
    window.ztExam.onEvent('exam:recovery', (payload) => useStudentExamStore.getState().onRecovery(payload))
    window.ztExam.onEvent('exam:time-up', () => useStudentExamStore.getState().onTimeUp())
    window.ztExam.onEvent('exam:completed', (payload) => useStudentExamStore.getState().onCompleted(payload))
  }, [])

  useEffect(() => {
    if (remaining > 0) {
      const interval = window.setInterval(() => {
        useStudentExamStore.setState({ remainingSeconds: Math.max(0, remaining - 1) })
      }, 1000)
      return () => window.clearInterval(interval)
    }
    return undefined
  }, [remaining])

  const timerClass =
    remaining <= 60
      ? 'text-red-300'
      : remaining <= 300
        ? 'text-orange-200'
        : 'text-emerald-200'
  const frozen = connection.state === 'frozen' || connection.state === 'reconnecting'

  return (
    <div className="flex h-[76px] select-none items-center gap-3 border-b-2 border-sky-900/70 bg-slate-950/98 px-4 drag-none">
      <div className={`items-center gap-1.5 text-2xl font-bold tabular-nums ${timerClass} flex`}>
        <AlarmClock size={18} />
        {formatClock(remaining)}
      </div>

      {question && (
        <div className="text-xs text-slate-400">
          ข้อ <span className="font-mono text-slate-200">{question.cursorIndex + 1}</span>
          /<span className="font-mono">{question.questionCount}</span>
        </div>
      )}

      <div
        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
          frozen
            ? 'border-red-800/60 bg-red-950/50 text-red-200'
            : 'border-emerald-800/60 bg-emerald-950/40 text-emerald-200'
        }`}
      >
        <Signal size={12} />
        {frozen ? 'ขาดการติดต่อ' : 'เชื่อมแม่'}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => void window.ztExam.openVsCode()}
          className="flex items-center gap-1.5 rounded-lg border border-sky-800/70 bg-sky-950/60 px-2.5 py-1.5 text-xs text-sky-200 hover:bg-sky-900/60"
        >
          <FileCode2 size={13} />
          เปิด VS Code
        </button>
        <button
          type="button"
          onClick={() => void window.ztExam.focusExam()}
          className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
        >
          <ExternalLink size={13} />
          ดูโจทย์
        </button>
      </div>

      {phase === 'timeup' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/95 text-sm text-red-300">
          หมดเวลาสอบ — กลับไปที่หน้าข้อสอบเพื่อบันทึกคำตอบสุดท้าย
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { AlarmClock, ExternalLink, Signal, FileCode2, BookMarked } from 'lucide-react'
import { useStudentExamStore } from '../store/exam-store'
import { useStudentNetworkStore } from '../store/network-store'
import { useDocsStore } from '../store/docs-store'
import WatermarkOverlay from './WatermarkOverlay'

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

export default function FloatingHud(): React.JSX.Element {
  const phase = useStudentExamStore((s) => s.phase)
  const identity = useStudentExamStore((s) => s.identity)
  const examMode = useStudentExamStore((s) => s.examMode)
  const question = useStudentExamStore((s) => s.question)
  const remaining = useStudentExamStore((s) => s.remainingSeconds)
  const lastTickAtMs = useStudentExamStore((s) => s.lastTickAtMs)
  const connection = useStudentNetworkStore((s) => s.connection)
  const docsOpen = useDocsStore((s) => s.docs?.open ?? false)
  const [, setNow] = useState(Date.now())

  useEffect(() => {
    const store = useStudentExamStore.getState()
    const unsubs = [
      window.ztExam.onEvent('exam:started', (payload) => store.onExamStarted(payload)),
      window.ztExam.onEvent('exam:question', (payload) => store.onQuestion(payload)),
      window.ztExam.onEvent('exam:tick', (payload) => store.onTick(payload)),
      window.ztExam.onEvent('exam:recovery', (payload) => store.onRecovery(payload)),
      window.ztExam.onEvent('exam:submit-rejected', (payload) => store.onSubmitRejected(payload)),
      window.ztExam.onEvent('exam:module-state', (payload) => store.onModuleState(payload)),
      window.ztExam.onEvent('exam:module-ack', (payload) => store.onModuleAck(payload)),
      window.ztExam.onEvent('exam:time-up', () => store.onTimeUp()),
      window.ztExam.onEvent('exam:completed', (payload) => {
        store.onCompleted(payload)
        useDocsStore.getState().reset()
      }),
      window.ztExam.onEvent('exam:docs-state', (payload) => useDocsStore.getState().setDocs(payload))
    ]
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      unsubs.forEach((u) => u())
      window.clearInterval(interval)
    }
  }, [])

  // นาฬิกาแบบ derived จาก server tick (ไม่ mutate store — กันเดินซ้อนกับ exam:tick)
  const tickAgeMs = lastTickAtMs === null ? 0 : Math.max(0, Date.now() - lastTickAtMs)
  const displayRemaining = Math.max(0, remaining - Math.floor(tickAgeMs / 1000))
  const approx = lastTickAtMs !== null && tickAgeMs > 2000

  const timerClass =
    displayRemaining <= 60
      ? 'text-red-300'
      : displayRemaining <= 300
        ? 'text-orange-200'
        : 'text-emerald-200'
  const frozen = connection.state === 'frozen' || connection.state === 'reconnecting'

  return (
    <div className="flex h-[76px] select-none items-center gap-3 border-b-2 border-sky-900/70 bg-slate-950/98 px-4 drag-none">
      {identity && (
        <WatermarkOverlay
          studentId={identity.studentId}
          studentName={identity.studentName}
          deviceLabel={navigator.platform || 'desktop'}
        />
      )}
      <div className={`items-center gap-1.5 text-2xl font-bold tabular-nums ${timerClass} flex`}>
        <AlarmClock size={18} />
        {approx ? '≈' : ''}{formatClock(displayRemaining)}
      </div>

      {question && (
        <div className="text-xs text-slate-400">
          ข้อ <span className="font-mono text-slate-200">{question.cursorIndex + 1}</span>
          /<span className="font-mono">{question.questionCount}</span>
        </div>
      )}

      {examMode && (
        <div className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300">
          {examMode === 'in-app-docs' ? 'โหมดเอกสาร' : examMode === 'external-tools' ? 'โหมดเครื่องมือภายนอก' : examMode}
        </div>
      )}

      {examMode === 'in-app-docs' && docsOpen && (
        <div className="flex items-center gap-1 rounded-full border border-sky-800/60 bg-sky-950/40 px-2 py-0.5 text-[11px] text-sky-200">
          <BookMarked size={12} />
          เปิดเอกสารอยู่
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

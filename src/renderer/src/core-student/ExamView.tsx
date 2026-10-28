import { useEffect } from 'react'
import { CircleCheck, CloudOff } from 'lucide-react'
import WatermarkOverlay from './WatermarkOverlay'
import HudBar from './HudBar'
import QuestionRenderer from './QuestionRenderer'
import { useStudentExamStore } from '../store/exam-store'
import { useStudentNetworkStore } from '../store/network-store'

let subscribed = false

/** subscribe exam events ครั้งเดียวระดับโมดูล (กัน duplicate ตอน React strict) */
function useExamEventSubscription(): void {
  useEffect(() => {
    function subscribeExam(): () => void {
      const unsubs = [
        window.ztExam.onEvent('exam:started', (payload) =>
          useStudentExamStore.getState().onExamStarted(payload)
        ),
        window.ztExam.onEvent('exam:question', (payload) =>
          useStudentExamStore.getState().onQuestion(payload)
        ),
        window.ztExam.onEvent('exam:recovery', (payload) =>
          useStudentExamStore.getState().onRecovery(payload)
        ),
        window.ztExam.onEvent('exam:tick', (payload) =>
          useStudentExamStore.getState().onTick(payload)
        ),
        window.ztExam.onEvent('exam:submit-rejected', (payload) =>
          useStudentExamStore.getState().onSubmitRejected(payload)
        ),
        window.ztExam.onEvent('exam:time-up', () => useStudentExamStore.getState().onTimeUp()),
        window.ztExam.onEvent('exam:completed', (payload) =>
          useStudentExamStore.getState().onCompleted(payload)
        )
      ]
      return () => unsubs.forEach((u) => u())
    }
    if (subscribed) return
    subscribed = true
    subscribeExam()
  }, [])
}

export default function ExamView(): React.JSX.Element | null {
  const phase = useStudentExamStore((s) => s.phase)
  const identity = useStudentExamStore((s) => s.identity)
  const connection = useStudentNetworkStore((s) => s.connection)
  const remaining = useStudentExamStore((s) => s.remainingSeconds)
  const finishReason = useStudentExamStore((s) => s.finishReason)
  useExamEventSubscription()

  // เข้าโหมด kiosk ทันทีที่เริ่ม/กู้คืนการสอบ (main process ล็อกจอระดับ OS)
  useEffect(() => {
    if (phase === 'active') {
      void window.ztExam.enterKiosk()
    }
  }, [phase])

  // หมดเวลา → ยื่น final draft ที่กำลังพิมพ์ค้างไว้ภายใน grace period
  useEffect(() => {
    if (phase !== 'timeup') return
    const store = useStudentExamStore.getState()
    const question = store.question
    if (!question) return
    void window.ztExam.submitAnswer({
      questionId: question.questionId,
      cursorIndex: question.cursorIndex,
      answer: { type: 'text', content: store.draft?.type === 'text' ? store.draft.content : '' },
      timeSpentMs: 0
    })
  }, [phase])

  if (phase === 'idle' || phase === 'waiting' || !identity) return null

  if (phase === 'completed') {
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-slate-950">
        <WatermarkOverlay
          studentId={identity.studentId}
          studentName={identity.studentName}
          deviceLabel={navigator.platform || 'desktop'}
        />
        <CircleCheck size={56} className="mb-4 text-emerald-400" />
        <h2 className="text-xl font-semibold text-emerald-200">
          การสอบเสร็จสมบูรณ์{' '}
          {finishReason === 'time-up' ? '(หมดเวลา)' : finishReason === 'completed' ? '(ทำครบทุกข้อ)' : '(จบตามคำสั่งครู)'}
        </h2>
        <p className="mt-2 text-sm text-slate-400">โปรดแจ้งครูก่อนออกจากเครื่อง</p>
      </div>
    )
  }

  const frozen = connection.state === 'frozen' || connection.state === 'reconnecting'
  const timeup = phase === 'timeup'

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-slate-950">
      {/* Dynamic watermark ระบุตัวตนรายแอป */}
      <WatermarkOverlay
        studentId={identity.studentId}
        studentName={identity.studentName}
        deviceLabel={navigator.platform || 'desktop'}
      />

      <HudBar connectionOk={connection.state === 'ready'} />

      {/* Fail-closed overlay: ขาดการติดต่อกับเครื่องแม่ — บังโจทย์ทั้งหมด */}
      {frozen ? (
        <div className="flex flex-1 flex-col items-center justify-center">
          <CloudOff size={48} className="mb-4 text-amber-400" />
          <h2 className="text-lg font-semibold text-amber-200">ขาดการติดต่อกับเครื่องแม่</h2>
          <p className="mt-2 max-w-md text-center text-sm text-slate-400">
            ระบบซ่อนโจทย์ชั่วคราวเพื่อความปลอดภัยของข้อสอบ รอสักครู่จะกู้คืนข้อเดิมพร้อมคำตอบที่พิมพ์ค้างไว้ให้โดยอัตโนมัติ
          </p>
        </div>
      ) : timeup ? (
        <div className="flex flex-1 flex-col items-center justify-center">
          <CloudOff size={48} className="mb-4 text-red-400" />
          <h2 className="text-lg font-semibold text-red-200">หมดเวลาสอบ</h2>
          <p className="mt-2 text-sm text-slate-400">กำลังบันทึกคำตอบล่าสุดของข้อนี้…</p>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <QuestionRenderer />
        </div>
      )}

      {/* แถบนับถอยหลังสแตนดี้ บนจอ (สีเปลี่ยนเมื่อเวลาจะหมด) */}
      {remaining <= 0 && !frozen && !timeup && (
        <div className="border-t border-amber-800/60 bg-amber-950/40 px-4 py-2 text-center text-xs text-amber-200">
          รอข้อมูลเวลาจากเครื่องแม่…
        </div>
      )}
    </div>
  )
}

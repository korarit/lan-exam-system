import { useEffect, useState } from 'react'
import { AlarmClock, ExternalLink, Signal, SignalHigh, FileCode2, BookMarked } from 'lucide-react'
import { useStudentExamStore } from '../store/exam-store'
import { useStudentNetworkStore } from '../store/network-store'
import { useDocsStore } from '../store/docs-store'
import WatermarkOverlay from './WatermarkOverlay'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

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
      ? 'text-red-600 dark:text-red-400'
      : displayRemaining <= 300
        ? 'text-orange-600 dark:text-orange-400'
        : 'text-emerald-700 dark:text-emerald-400'
  const frozen = connection.state === 'frozen' || connection.state === 'reconnecting'

  return (
    <div className="flex h-[76px] select-none items-center gap-3 border-b border-border bg-card px-4">
      {identity && (
        <WatermarkOverlay
          studentId={identity.studentId}
          studentName={identity.studentName}
          deviceLabel={navigator.platform || 'desktop'}
        />
      )}
      <div className={cn('flex items-center gap-1.5 text-2xl font-bold tabular-nums', timerClass)} aria-live="off">
        <AlarmClock size={18} />
        {approx ? '≈' : ''}{formatClock(displayRemaining)}
      </div>

      {question && (
        <div className="text-xs tabular-nums text-muted-foreground">
          ข้อ <span className="font-mono text-foreground">{question.cursorIndex + 1}</span>
          /<span className="font-mono">{question.questionCount}</span>
        </div>
      )}

      {examMode && (
        <Badge variant="secondary">
          {examMode === 'in-app-docs' ? 'โหมดเอกสาร' : examMode === 'external-tools' ? 'โหมดเครื่องมือภายนอก' : examMode}
        </Badge>
      )}

      {examMode === 'in-app-docs' && docsOpen && (
        <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
          <BookMarked />
          เปิดเอกสารอยู่
        </Badge>
      )}

      <Badge
        variant="outline"
        className={cn(
          frozen
            ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
            : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
        )}
      >
        {frozen ? <Signal /> : <SignalHigh />}
        {frozen ? 'ขาดการติดต่อ' : 'เชื่อมแม่'}
      </Badge>

      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void window.ztExam.openVsCode()}
        >
          <FileCode2 />
          เปิด VS Code
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void window.ztExam.focusExam()}
        >
          <ExternalLink />
          ดูโจทย์
        </Button>
      </div>

      {phase === 'timeup' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/95 text-sm text-destructive">
          หมดเวลาสอบ — กลับไปที่หน้าข้อสอบเพื่อบันทึกคำตอบสุดท้าย
        </div>
      )}
    </div>
  )
}

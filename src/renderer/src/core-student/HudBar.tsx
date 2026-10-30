import { useEffect, useState } from 'react'
import { AlarmClock, BookOpenText, BookMarked, Save, Signal, SignalHigh } from 'lucide-react'
import { useStudentExamStore } from '../store/exam-store'
import { useDocsStore } from '../store/docs-store'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

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
 * สูงไม่เกิน 48px (h-12)
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

  const timerTone =
    displayRemaining <= 60
      ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
      : displayRemaining <= 300
        ? 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400'
        : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4 text-sm">
      {/* ซ้าย: ชื่อวิชา + ข้อที่ทำ (truncate) */}
      <div className="flex min-w-0 items-center gap-2 font-semibold">
        <BookOpenText size={16} className="shrink-0 text-primary" />
        <span className="max-w-40 truncate xl:max-w-56">{examTitle ?? 'ข้อสอบ'}</span>
        {question && (
          <span className="shrink-0 font-normal text-muted-foreground">
            ข้อที่ <span className="font-mono tabular-nums text-foreground">{question.cursorIndex + 1}</span>
            {' / '}
            <span className="font-mono tabular-nums">{question.questionCount}</span>
          </span>
        )}
      </div>

      {/* กลาง: docs toggle (ถ้า in-app-docs) + autosave status */}
      <div className="flex min-w-0 items-center gap-3">
        {examMode === 'in-app-docs' && (
          <Button
            type="button"
            variant={docsOpen ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => void window.ztExam.docsToggle({ open: !docsOpen })}
          >
            <BookMarked />
            {docsOpen ? 'ปิดเอกสาร' : 'เปิดเอกสาร'}
          </Button>
        )}
        <div className="hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
          <Save size={14} className="shrink-0" />
          <span className="truncate">
            {lastDraftSavedAtMs ? `บันทึกอัตโนมัติ ${timeAgo(lastDraftSavedAtMs)}` : 'ยังไม่มีการบันทึก'}
          </span>
        </div>
      </div>

      {/* ขวา: connection Badge + timer Badge */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            props.connectionOk
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
          )}
        >
          {props.connectionOk ? <SignalHigh /> : <Signal />}
          {props.connectionOk ? 'เครื่องแม่' : 'ขาดการติดต่อ'}
        </Badge>
        <Badge variant="outline" className={cn('font-mono tabular-nums', timerTone)} aria-live="off">
          <AlarmClock />
          {approx ? '≈' : ''}{formatClock(displayRemaining)}
        </Badge>
      </div>
    </div>
  )
}

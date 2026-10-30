import { useEffect, useState } from 'react'
import { AlertTriangle, Eye, Loader2, Monitor, Snowflake, WifiOff } from 'lucide-react'
import type { StudentTriageView } from '@shared/ipc-channels'
import { timeAgo } from '../../store/triage-store'
import { cn } from '@renderer/lib/utils'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'

interface Props {
  view: StudentTriageView
  name: string
  online: boolean
  progress: { answered: number; total: number } | null
  nowMs: number
  /** ภาพย่อล่าสุดจาก screen monitoring (Phase 3c — data URL, null = ยังไม่มี) */
  thumbnailSrc: string | null
  onSelect: () => void
  onOpenScreen: () => void
  onToggleFreeze: () => void
  freezing: boolean
}

const SEVERITY: Record<string, { label: string; className: string }> = {
  critical: {
    label: 'วิกฤต',
    className: 'border-destructive/50 bg-destructive/10 text-destructive'
  },
  warning: {
    label: 'เฝ้าระวัง',
    className: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  },
  normal: {
    label: 'ปกติ',
    className: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  }
}

export default function StudentTriageCard(props: Props): React.JSX.Element {
  const view = props.view
  const severity = SEVERITY[view.triageLevel] ?? SEVERITY.normal!
  const [freezeOpen, setFreezeOpen] = useState(false)
  const [thumbLoaded, setThumbLoaded] = useState(false)

  useEffect(() => {
    setThumbLoaded(false)
  }, [props.thumbnailSrc])

  const answered = props.progress ? Math.min(props.progress.answered, props.progress.total) : 0
  const total = props.progress?.total ?? 0
  const progressPct = total > 0 ? Math.min(100, Math.round((answered / total) * 100)) : 0

  function confirmFreeze(): void {
    setFreezeOpen(false)
    props.onToggleFreeze()
  }

  return (
    <Card
      className={cn(
        'space-y-2 p-3',
        view.triageLevel === 'critical' && 'border-destructive/60 ring-1 ring-destructive/40'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant="outline" className={severity.className}>
            {severity.label}
          </Badge>
          <Badge variant={props.online ? 'outline' : 'secondary'}>
            {props.online ? 'ออนไลน์' : 'ออฟไลน์'}
          </Badge>
          {view.disconnected && (
            <Badge variant="secondary">
              <WifiOff />
              ขาดการติดต่อ
            </Badge>
          )}
          {view.frozen && (
            <Badge variant="secondary">
              <Snowflake />
              แช่แข็ง
            </Badge>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div
            className={cn(
              'font-mono text-lg font-bold tabular-nums',
              view.activeSuspicionScore >= 40
                ? 'text-destructive'
                : view.activeSuspicionScore >= 15
                  ? 'text-amber-600 dark:text-amber-300'
                  : 'text-muted-foreground'
            )}
          >
            {view.activeSuspicionScore}
          </div>
          <div className="text-[10px] text-muted-foreground">คะแนน</div>
        </div>
      </div>

      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{props.name}</div>
        <div className="font-mono text-xs tabular-nums text-muted-foreground">{view.studentId}</div>
      </div>

      {props.progress && (
        <div className="space-y-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="text-[11px] tabular-nums text-muted-foreground">
            ข้อที่ {Math.min(props.progress.answered + 1, props.progress.total)} / {props.progress.total}
          </div>
        </div>
      )}

      {props.thumbnailSrc ? (
        <button
          type="button"
          onClick={props.onOpenScreen}
          className="relative block w-full overflow-hidden rounded-md border bg-muted"
          title="คลิกเพื่อเปิด Screen Inspector (ภาพสด / ย้อนหลัง 5 นาที) — การเปิดดูบันทึก audit ลง chain"
        >
          {!thumbLoaded && <Skeleton className="aspect-video w-full" />}
          <img
            src={props.thumbnailSrc}
            alt="ภาพย่อหน้าจอนักเรียน (เบลอ)"
            onLoad={() => setThumbLoaded(true)}
            className={cn('aspect-video w-full object-cover blur-md', !thumbLoaded && 'hidden')}
          />
          {thumbLoaded && (
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/45 text-[11px]">
              <span className="inline-flex items-center gap-1 rounded-full border bg-background/70 px-2.5 py-1 text-foreground">
                <Eye size={12} /> คลิกเพื่อเปิดดูจอ
              </span>
              <span className="text-[10px] text-muted-foreground">เปิดดู = บันทึก audit ลง chain</span>
            </span>
          )}
        </button>
      ) : null}

      {view.latestSummary && (
        <div className="rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs">
          <span className="mr-1 inline-flex items-center gap-1 font-medium">
            <AlertTriangle size={12} className={view.triageLevel === 'critical' ? 'text-destructive' : 'text-amber-600 dark:text-amber-300'} />
            {view.latestSummary}
          </span>
          <span className="ml-1 tabular-nums text-muted-foreground">{timeAgo(view.lastEventAtMs, props.nowMs)}</span>
          {view.unacknowledgedCriticalCount > 0 && (
            <Badge variant="destructive" className="ml-1 font-mono tabular-nums">
              รอตรวจ {view.unacknowledgedCriticalCount}
            </Badge>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" onClick={props.onSelect}>
          <Eye /> ดูหลักฐาน
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={!props.online} onClick={props.onOpenScreen}>
          <Monitor /> ดูหน้าจอ
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.freezing || !props.online}
          onClick={() => setFreezeOpen(true)}
        >
          {props.freezing ? <Loader2 className="animate-spin" /> : <Snowflake />}
          {view.frozen ? 'ปลด Freeze' : 'Freeze'}
        </Button>
      </div>

      {/* TRI-12: confirm กันกด Freeze พลาดจากการ์ด */}
      <Dialog open={freezeOpen} onOpenChange={setFreezeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {view.frozen ? 'ปลด Freeze' : 'สั่ง Freeze'} — {props.name}
            </DialogTitle>
            <DialogDescription>
              {view.frozen
                ? 'ปลดแช่แข็งหน้าจอนักเรียน กลับมาทำข้อสอบต่อได้ตามปกติ ดำเนินการต่อหรือไม่'
                : `สั่ง Freeze เครื่องของ ${view.studentId} หน้าจอนักเรียนจะถูกแช่แข็งทันทีจนกว่าจะปลด ดำเนินการต่อหรือไม่`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setFreezeOpen(false)}>
              ยกเลิก
            </Button>
            <Button
              type="button"
              variant={view.frozen ? 'default' : 'destructive'}
              disabled={props.freezing}
              onClick={confirmFreeze}
            >
              {props.freezing && <Loader2 className="animate-spin" />}
              ยืนยัน{view.frozen ? 'ปลด Freeze' : ' Freeze'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

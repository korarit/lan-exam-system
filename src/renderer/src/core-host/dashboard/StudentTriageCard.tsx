import { Eye, Monitor, Snowflake, WifiOff } from 'lucide-react'
import type { StudentTriageView } from '@shared/ipc-channels'
import { timeAgo } from '../../store/triage-store'

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

const LEVEL_STYLES: Record<string, { border: string; bg: string; badge: string; label: string }> = {
  critical: {
    border: 'border-red-700/70',
    bg: 'bg-red-950/30',
    badge: 'bg-red-900/60 text-red-200',
    label: 'วิกฤต'
  },
  warning: {
    border: 'border-amber-700/60',
    bg: 'bg-amber-950/20',
    badge: 'bg-amber-900/50 text-amber-200',
    label: 'เฝ้าระวัง'
  },
  normal: {
    border: 'border-slate-800',
    bg: 'bg-slate-950/40',
    badge: 'bg-emerald-900/50 text-emerald-200',
    label: 'ปกติ'
  }
}

export default function StudentTriageCard(props: Props): React.JSX.Element {
  const view = props.view
  const style = LEVEL_STYLES[view.triageLevel] ?? LEVEL_STYLES.normal!
  return (
    <div
      className={`rounded-xl border p-3 ${style.border} ${style.bg} ${
        view.triageLevel === 'critical' ? 'ring-1 ring-red-700/50' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${style.badge}`}>
              {style.label}
            </span>
            {view.disconnected && (
              <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
                <WifiOff size={11} /> ขาดการติดต่อ
              </span>
            )}
            {view.frozen && (
              <span className="inline-flex items-center gap-1 text-[10px] text-sky-300">
                <Snowflake size={11} /> แช่แข็ง
              </span>
            )}
          </div>
          <div className="mt-1 truncate text-sm font-medium text-slate-100">{props.name}</div>
          <div className="text-xs text-slate-500">{view.studentId}</div>
        </div>
        <div className="text-right">
          <div
            className={`font-mono text-lg font-bold ${
              view.activeSuspicionScore >= 40
                ? 'text-red-400'
                : view.activeSuspicionScore >= 15
                  ? 'text-amber-300'
                  : 'text-slate-500'
            }`}
          >
            {view.activeSuspicionScore}
          </div>
          <div className="text-[10px] text-slate-500">คะแนน</div>
        </div>
      </div>

      {props.progress && (
        <div className="mt-1.5 text-[11px] text-slate-500">
          ข้อที่ {Math.min(props.progress.answered + 1, props.progress.total)} / {props.progress.total}
        </div>
      )}

      {props.thumbnailSrc ? (
        <button
          type="button"
          onClick={props.onOpenScreen}
          className="relative mt-2 block w-full overflow-hidden rounded-lg border border-slate-800 bg-black"
          title="คลิกเพื่อเปิด Screen Inspector (ภาพสด / ย้อนหลัง 5 นาที) — การเปิดดูบันทึก audit ลง chain"
        >
          {/* Privacy: เบลอภาพย่อไว้ก่อนจนกว่าครูกดเปิดดู (ตอนนั้นลง PROCTOR_VIEWED_SCREEN อัตโนมัติ) */}
          <img src={props.thumbnailSrc} alt="thumbnail (เบลอ)" className="aspect-video w-full object-cover blur-md" />
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-slate-950/45 text-[11px] text-slate-200">
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-600 bg-slate-950/70 px-2.5 py-1">
              <Eye size={12} /> คลิกเพื่อเปิดดูจอ
            </span>
            <span className="text-[10px] text-slate-400">เปิดดู = บันทึก audit ลง chain</span>
          </span>
        </button>
      ) : null}

      {view.latestSummary && (
        <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-1.5 text-xs text-slate-300">
          <span className="mr-1">{view.triageLevel === 'critical' ? '🚨' : '⚠️'}</span>
          {view.latestSummary}
          <span className="ml-1 text-slate-500">· {timeAgo(view.lastEventAtMs, props.nowMs)}</span>
          {view.unacknowledgedCriticalCount > 0 && (
            <span className="ml-1 rounded bg-red-900/60 px-1 font-mono text-[10px] text-red-200">
              รอตรวจ {view.unacknowledgedCriticalCount}
            </span>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={props.onSelect}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800"
        >
          <Eye size={12} /> ดูหลักฐาน
        </button>
        <button
          type="button"
          disabled={!props.online}
          onClick={props.onOpenScreen}
          className="inline-flex items-center gap-1 rounded-lg border border-sky-700/60 px-2 py-1 text-[11px] text-sky-300 transition hover:bg-sky-950/40 disabled:opacity-40"
        >
          <Monitor size={12} /> ดูหน้าจอ
        </button>
        <button
          type="button"
          disabled={props.freezing || !props.online}
          onClick={props.onToggleFreeze}
          className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition disabled:opacity-40 ${
            view.frozen
              ? 'border-sky-700/60 text-sky-300 hover:bg-sky-950/40'
              : 'border-slate-700 text-slate-300 hover:bg-slate-800'
          }`}
        >
          <Snowflake size={12} /> {view.frozen ? 'ปลด Freeze' : 'Freeze'}
        </button>
      </div>
    </div>
  )
}

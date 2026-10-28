import { Search, Volume2, VolumeX, FileDown, ShieldCheck } from 'lucide-react'
import type { TriageCounts } from '@shared/ipc-channels'
import type { TriageFilter } from '../../store/triage-store'

interface Props {
  counts: TriageCounts | null
  filter: TriageFilter
  search: string
  muted: boolean
  canExport: boolean
  exporting: boolean
  onFilterChange: (filter: TriageFilter) => void
  onSearchChange: (search: string) => void
  onToggleMute: () => void
  onExportReport: () => void
  onExportBundle: () => void
}

const FILTER_BUTTONS: Array<{ key: TriageFilter; label: string; dot: string }> = [
  { key: 'all', label: 'ทั้งหมด', dot: 'bg-slate-500' },
  { key: 'critical', label: 'วิกฤต — ต้องตรวจทันที', dot: 'bg-red-500' },
  { key: 'warning', label: 'เฝ้าระวัง', dot: 'bg-amber-400' },
  { key: 'disconnected', label: 'ขาดการติดต่อ', dot: 'bg-slate-400' },
  { key: 'normal', label: 'ปกติ', dot: 'bg-emerald-500' }
]

export default function TriageSummaryHeader(props: Props): React.JSX.Element {
  const counts = props.counts ?? { total: 0, critical: 0, warning: 0, disconnected: 0, normal: 0 }
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {FILTER_BUTTONS.map((button) => (
          <button
            key={button.key}
            type="button"
            onClick={() => props.onFilterChange(button.key)}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
              props.filter === button.key
                ? 'border-sky-500/70 bg-sky-950/40 text-sky-200'
                : 'border-slate-700 text-slate-400 hover:bg-slate-800'
            }`}
          >
            <span className={`size-2 rounded-full ${button.dot}`} />
            {button.label}
            <span className="rounded-full bg-slate-800 px-1.5 font-mono text-[10px]">
              {counts[button.key === 'all' ? 'total' : button.key]}
            </span>
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={props.search}
              onChange={(event) => props.onSearchChange(event.target.value)}
              placeholder="ค้นหารหัส/ชื่อนักเรียน…"
              className="w-52 rounded-xl border border-slate-700 bg-slate-950 py-1.5 pl-8 pr-3 text-xs focus:border-sky-500 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={props.onToggleMute}
            title={props.muted ? 'เปิดเสียงเตือนเหตุการณ์วิกฤต' : 'ปิดเสียงเตือน'}
            className="rounded-xl border border-slate-700 p-1.5 text-slate-400 transition hover:bg-slate-800"
          >
            {props.muted ? <VolumeX size={15} /> : <Volume2 size={15} className="text-emerald-400" />}
          </button>
          <button
            type="button"
            disabled={!props.canExport || props.exporting}
            onClick={props.onExportReport}
            title="ส่งออกรายงานเหตุการณ์ (HTML)"
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          >
            <FileDown size={14} /> รายงานเหตุการณ์
          </button>
          <button
            type="button"
            disabled={!props.canExport || props.exporting}
            onClick={props.onExportBundle}
            title="ส่งออก Audit Bundle (.ztaudit)"
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          >
            <ShieldCheck size={14} /> .ztaudit
          </button>
        </div>
      </div>
    </div>
  )
}

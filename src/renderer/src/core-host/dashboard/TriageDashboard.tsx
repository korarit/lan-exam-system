import { useEffect, useMemo, useState } from 'react'
import { LayoutDashboard } from 'lucide-react'
import type { HostStudentSummary } from '@shared/ipc-channels'
import type { HostStudentStatus } from '@shared/protocol-schema'
import { matchesTriageFilter, useTriageStore } from '../../store/triage-store'
import { useAppStore } from '../../store/app-store'
import TriageSummaryHeader from './TriageSummaryHeader'
import StudentTriageCard from './StudentTriageCard'
import EvidenceTimelineDrawer from './EvidenceTimelineDrawer'

interface Props {
  students: HostStudentStatus[]
  summaries: HostStudentSummary[]
  canExport: boolean
}

/** Phase 3b: Dashboard คัดกรอง — ไม่มีผังที่นั่ง ดันการ์ดคนแดงขึ้นบนสุดเสมอ */
export default function TriageDashboard(props: Props): React.JSX.Element {
  const overview = useTriageStore((s) => s.overview)
  const setOverview = useTriageStore((s) => s.setOverview)
  const filter = useTriageStore((s) => s.filter)
  const setFilter = useTriageStore((s) => s.setFilter)
  const search = useTriageStore((s) => s.search)
  const setSearch = useTriageStore((s) => s.setSearch)
  const selectedStudentId = useTriageStore((s) => s.selectedStudentId)
  const setSelectedStudentId = useTriageStore((s) => s.setSelectedStudentId)
  const muted = useTriageStore((s) => s.muted)
  const setMuted = useTriageStore((s) => s.setMuted)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    void window.ztExam.getTriageOverview().then(setOverview)
    return window.ztExam.onEvent('host:triage-updated', setOverview)
  }, [setOverview])

  const names = useMemo(
    () => new Map(props.students.map((s) => [s.studentId, s.studentName])),
    [props.students]
  )
  const progressByStudent = useMemo(() => {
    const map = new Map<string, { answered: number; total: number }>()
    for (const summary of props.summaries) {
      map.set(summary.studentId, { answered: summary.maxReachedCursor, total: summary.totalQuestions })
    }
    return map
  }, [props.summaries])

  const nowMs = overview?.serverNowMs ?? Date.now()
  const visibleStudents = (overview?.students ?? []).filter(
    (view) =>
      matchesTriageFilter(view, filter) &&
      (search.trim() === '' ||
        (names.get(view.studentId) ?? view.studentId).toLowerCase().includes(search.trim().toLowerCase()) ||
        view.studentId.toLowerCase().includes(search.trim().toLowerCase()))
  )
  const selected = overview?.students.find((view) => view.studentId === selectedStudentId) ?? null
  const notify = useAppStore((s) => s.notify)

  async function exportWith(kind: 'report' | 'bundle'): Promise<void> {
    setExporting(true)
    try {
      const res =
        kind === 'report' ? await window.ztExam.exportIncidentReport() : await window.ztExam.exportAuditBundle()
      if (res.ok && res.filePath) {
        notify({ severity: 'info', message: `ส่งออกสำเร็จ: ${res.filePath}` })
      } else if (res.reason && res.reason !== 'CANCELLED') {
        notify({ severity: 'warning', message: `ส่งออกไม่สำเร็จ: ${res.reason}` })
      }
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
      <div className="mb-4 flex items-center gap-2">
        <LayoutDashboard size={18} className="text-sky-400" />
        <h3 className="font-semibold">Dashboard คัดกรอง (Triage)</h3>
        <span className="ml-auto text-xs text-slate-500">
          {overview ? `${overview.counts.total} คน · อัปเดตแบบ real-time` : 'รอข้อมูลจากเครื่องแม่…'}
        </span>
      </div>

      <div className="space-y-3">
        <TriageSummaryHeader
          counts={overview?.counts ?? null}
          filter={filter}
          search={search}
          muted={muted}
          canExport={props.canExport}
          exporting={exporting}
          onFilterChange={setFilter}
          onSearchChange={setSearch}
          onToggleMute={() => setMuted(!muted)}
          onExportReport={() => void exportWith('report')}
          onExportBundle={() => void exportWith('bundle')}
        />

        {visibleStudents.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            {overview && overview.counts.total > 0
              ? 'ไม่มีใครตรงกับตัวกรองนี้'
              : 'ยังไม่มีข้อมูลคัดกรอง — เหตุการณ์จากเครื่องนักเรียนจะเข้ามาที่นี่แบบ real-time'}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visibleStudents.map((view) => (
              <StudentTriageCard
                key={view.studentId}
                view={view}
                name={names.get(view.studentId) ?? view.studentId}
                online={props.students.find((s) => s.studentId === view.studentId)?.online ?? false}
                progress={progressByStudent.get(view.studentId) ?? null}
                nowMs={nowMs}
                onSelect={() => setSelectedStudentId(view.studentId)}
                onToggleFreeze={() => {
                  void window.ztExam
                    .setStudentFreeze({ studentId: view.studentId, frozen: !view.frozen })
                    .catch(() => undefined)
                }}
                freezing={false}
              />
            ))}
          </div>
        )}
      </div>

      {selected && (
        <EvidenceTimelineDrawer
          studentId={selected.studentId}
          name={names.get(selected.studentId) ?? selected.studentId}
          nowMs={nowMs}
          onClose={() => setSelectedStudentId(null)}
        />
      )}
    </div>
  )
}

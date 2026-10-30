import { useEffect, useMemo, useState } from 'react'
import { LayoutDashboard } from 'lucide-react'
import type { HostStudentSummary } from '@shared/ipc-channels'
import type { HostStudentStatus } from '@shared/protocol-schema'
import { matchesTriageFilter, shouldAlertToast, useTriageStore } from '../../store/triage-store'
import { useHostScreenStore } from '../../store/screen-store'
import { useAppStore } from '../../store/app-store'
import TriageSummaryHeader from './TriageSummaryHeader'
import StudentTriageCard from './StudentTriageCard'
import EvidenceTimelineDrawer from './EvidenceTimelineDrawer'
import ProctorScreenModal from './ProctorScreenModal'

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
  const toastSeverity = useTriageStore((s) => s.toastSeverity)
  const setToastSeverity = useTriageStore((s) => s.setToastSeverity)
  const [exporting, setExporting] = useState(false)
  const [ackingAll, setAckingAll] = useState(false)
  // Phase 3c: Screen Inspector modal + ภาพย่อของการ์ดแต่ละใบ
  const [screenInspectId, setScreenInspectId] = useState<string | null>(null)
  const thumbnails = useHostScreenStore((s) => s.thumbnails)
  const clearAllThumbnails = useHostScreenStore((s) => s.clearAll)

  useEffect(() => {
    const unsub = window.ztExam.onEvent('host:exam-completed', () => clearAllThumbnails())
    return unsub
  }, [clearAllThumbnails])

  const thumbnailByStudent = useMemo(() => {
    const latest = new Map<string, { timestampMs: number; src: string }>()
    for (const frame of Object.values(thumbnails)) {
      if (frame.mode !== 'thumbnail') continue
      const src = `data:${frame.mimeType};base64,${frame.imageBase64}`
      const existing = latest.get(frame.studentId)
      if (!existing || frame.timestampMs > existing.timestampMs) {
        latest.set(frame.studentId, { timestampMs: frame.timestampMs, src })
      }
    }
    return new Map([...latest.entries()].map(([studentId, entry]) => [studentId, entry.src]))
  }, [thumbnails])

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

  // TRI-12: confirm กันกด Freeze พลาดจากการ์ด + toast error แทนกลืนเงียบ (.catch(()=>undefined))
  async function toggleFreezeFromCard(studentId: string, currentlyFrozen: boolean): Promise<void> {
    if (!currentlyFrozen) {
      const ok = window.confirm(`สั่ง Freeze เครื่องของ ${studentId}?\nหน้าจอนักเรียนจะถูกแช่แข็งทันทีจนกว่าจะปลด`)
      if (!ok) return
    }
    try {
      const res = await window.ztExam.setStudentFreeze({ studentId, frozen: !currentlyFrozen })
      if (!res.ok) {
        notify({ severity: 'critical', message: `สั่ง ${currentlyFrozen ? 'ปลด Freeze' : 'Freeze'} ไม่สำเร็จ — เครื่องนักเรียนอาจไม่ได้รับคำสั่ง` })
      }
    } catch (err) {
      notify({ severity: 'critical', message: err instanceof Error ? err.message : 'สั่ง Freeze ไม่สำเร็จ' })
    }
  }

  // TRI-06: รับทราบเหตุการณ์ค้างของทุกคนที่เห็นอยู่ (กัน alert fatigue ตอนแดงพร้อมกันหลายคน)
  async function ackAllVisible(): Promise<void> {
    const targets = visibleStudents.filter((v) => v.unacknowledgedCriticalCount > 0 || v.unacknowledgedWarningCount > 0)
    if (targets.length === 0) return
    const ok = window.confirm(`รับทราบเหตุการณ์ค้างของ ${targets.length} คนทั้งหมด?\n(บันทึก cleared ลง audit chain)`)
    if (!ok) return
    setAckingAll(true)
    try {
      let cleared = 0
      for (const target of targets) {
        try {
          const res = await window.ztExam.resolveTriage({ studentId: target.studentId, resolution: 'cleared' })
          cleared += res.affectedAlerts
        } catch {
          /* รายคนล้มเหลวข้ามไป — จะ toast สรุปตอนท้าย */
        }
      }
      if (shouldAlertToast('info', { muted, toastSeverity })) {
        notify({ severity: 'info', message: `รับทราบทั้งหมดแล้ว (${cleared} เหตุการณ์ / ${targets.length} คน)` })
      }
    } finally {
      setAckingAll(false)
    }
  }

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
          toastSeverity={toastSeverity}
          canExport={props.canExport}
          exporting={exporting}
          pendingAckCount={visibleStudents.filter((v) => v.unacknowledgedCriticalCount > 0 || v.unacknowledgedWarningCount > 0).length}
          ackingAll={ackingAll}
          onFilterChange={setFilter}
          onSearchChange={setSearch}
          onToggleMute={() => setMuted(!muted)}
          onToastSeverityChange={setToastSeverity}
          onAckAll={() => void ackAllVisible()}
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
                thumbnailSrc={thumbnailByStudent.get(view.studentId) ?? null}
                onSelect={() => setSelectedStudentId(view.studentId)}
                onOpenScreen={() => setScreenInspectId(view.studentId)}
                onToggleFreeze={() => void toggleFreezeFromCard(view.studentId, view.frozen)}
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

      {screenInspectId && (
        <ProctorScreenModal
          studentId={screenInspectId}
          name={names.get(screenInspectId) ?? screenInspectId}
          nowMs={nowMs}
          onClose={() => setScreenInspectId(null)}
        />
      )}
    </div>
  )
}

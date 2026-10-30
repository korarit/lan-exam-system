import { useEffect, useMemo, useState } from 'react'
import { Inbox, LayoutDashboard, SearchX } from 'lucide-react'
import type { HostStudentSummary } from '@shared/ipc-channels'
import type { HostStudentStatus } from '@shared/protocol-schema'
import { matchesTriageFilter, shouldAlertToast, useTriageStore } from '../../store/triage-store'
import { useHostScreenStore } from '../../store/screen-store'
import { useAppStore } from '../../store/app-store'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Skeleton } from '@renderer/components/ui/skeleton'
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
  const pendingAckCount = visibleStudents.filter(
    (v) => v.unacknowledgedCriticalCount > 0 || v.unacknowledgedWarningCount > 0
  ).length
  const selected = overview?.students.find((view) => view.studentId === selectedStudentId) ?? null
  const notify = useAppStore((s) => s.notify)

  // TRI-12: การ์ดยืนยันผ่าน Dialog ก่อนแล้ว — ตรงนี้ยิงคำสั่ง Freeze ได้เลย + toast error แทนกลืนเงียบ
  async function toggleFreezeFromCard(studentId: string, currentlyFrozen: boolean): Promise<void> {
    try {
      const res = await window.ztExam.setStudentFreeze({ studentId, frozen: !currentlyFrozen })
      if (!res.ok) {
        notify({ severity: 'critical', message: `สั่ง ${currentlyFrozen ? 'ปลด Freeze' : 'Freeze'} ไม่สำเร็จ — เครื่องนักเรียนอาจไม่ได้รับคำสั่ง` })
      }
    } catch (err) {
      notify({ severity: 'critical', message: err instanceof Error ? err.message : 'สั่ง Freeze ไม่สำเร็จ' })
    }
  }

  // TRI-06: รับทราบเหตุการณ์ค้างของทุกคนที่เห็นอยู่ (ยืนยันผ่าน Dialog ใน header แล้ว)
  async function ackAllVisible(): Promise<void> {
    const targets = visibleStudents.filter((v) => v.unacknowledgedCriticalCount > 0 || v.unacknowledgedWarningCount > 0)
    if (targets.length === 0) return
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
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0 pb-3">
        <LayoutDashboard size={18} className="text-primary" />
        <CardTitle className="text-base">Dashboard คัดกรอง (Triage)</CardTitle>
        <Badge variant="secondary" className="tabular-nums">
          {overview ? `${overview.counts.total} คน` : 'กำลังโหลด…'}
        </Badge>
        {overview && overview.counts.critical > 0 && (
          <Badge variant="destructive" className="tabular-nums">
            วิกฤต {overview.counts.critical}
          </Badge>
        )}
        {overview && overview.counts.warning > 0 && (
          <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 tabular-nums text-amber-700 dark:text-amber-300">
            เฝ้าระวัง {overview.counts.warning}
          </Badge>
        )}
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
          {overview ? 'อัปเดตแบบ real-time' : 'รอข้อมูลจากเครื่องแม่…'}
        </span>
      </CardHeader>

      <CardContent className="space-y-3">
        <TriageSummaryHeader
          counts={overview?.counts ?? null}
          filter={filter}
          search={search}
          muted={muted}
          toastSeverity={toastSeverity}
          canExport={props.canExport}
          exporting={exporting}
          pendingAckCount={pendingAckCount}
          ackingAll={ackingAll}
          onFilterChange={setFilter}
          onSearchChange={setSearch}
          onToggleMute={() => setMuted(!muted)}
          onToastSeverityChange={setToastSeverity}
          onAckAll={() => void ackAllVisible()}
          onExportReport={() => void exportWith('report')}
          onExportBundle={() => void exportWith('bundle')}
        />

        {!overview ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="กำลังโหลดข้อมูลคัดกรอง">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-44 w-full" />
            ))}
          </div>
        ) : visibleStudents.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            {overview.counts.total > 0 ? (
              <>
                <SearchX size={28} className="text-muted-foreground" />
                <p className="text-sm text-muted-foreground">ไม่มีใครตรงกับตัวกรองนี้</p>
                <p className="text-xs text-muted-foreground">ลองเปลี่ยนตัวกรองหรือล้างคำค้นหา</p>
              </>
            ) : (
              <>
                <Inbox size={28} className="text-muted-foreground" />
                <p className="text-sm text-muted-foreground">ยังไม่มีข้อมูลคัดกรอง</p>
                <p className="text-xs text-muted-foreground">เหตุการณ์จากเครื่องนักเรียนจะเข้ามาที่นี่แบบ real-time</p>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
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
      </CardContent>

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
    </Card>
  )
}

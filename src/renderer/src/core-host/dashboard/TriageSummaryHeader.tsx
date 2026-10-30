import { useState } from 'react'
import { BellRing, CheckCheck, FileDown, Loader2, Search, ShieldCheck, Volume2, VolumeX } from 'lucide-react'
import type { TriageCounts } from '@shared/ipc-channels'
import type { TriageFilter, TriageToastSeverity } from '../../store/triage-store'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@renderer/components/ui/tooltip'

interface Props {
  counts: TriageCounts | null
  filter: TriageFilter
  search: string
  muted: boolean
  toastSeverity: TriageToastSeverity
  canExport: boolean
  exporting: boolean
  /** จำนวนคนที่มี alert รอตรวจ (สำหรับปุ่มรับทราบทั้งหมด) */
  pendingAckCount: number
  ackingAll: boolean
  onFilterChange: (filter: TriageFilter) => void
  onSearchChange: (search: string) => void
  onToggleMute: () => void
  onToastSeverityChange: (level: TriageToastSeverity) => void
  onAckAll: () => void
  onExportReport: () => void
  onExportBundle: () => void
}

const FILTER_BUTTONS: Array<{ key: TriageFilter; label: string; dot: string }> = [
  { key: 'all', label: 'ทั้งหมด', dot: 'bg-muted-foreground' },
  { key: 'critical', label: 'วิกฤต', dot: 'bg-destructive' },
  { key: 'warning', label: 'เฝ้าระวัง', dot: 'bg-amber-400' },
  { key: 'disconnected', label: 'ขาดการติดต่อ', dot: 'bg-muted-foreground' },
  { key: 'normal', label: 'ปกติ', dot: 'bg-emerald-500' }
]

export default function TriageSummaryHeader(props: Props): React.JSX.Element {
  const counts = props.counts ?? { total: 0, critical: 0, warning: 0, disconnected: 0, normal: 0 }
  const [ackOpen, setAckOpen] = useState(false)
  const [exportKind, setExportKind] = useState<'report' | 'bundle' | null>(null)

  function confirmAck(): void {
    setAckOpen(false)
    props.onAckAll()
  }

  function confirmExport(): void {
    const kind = exportKind
    setExportKind(null)
    if (kind === 'report') props.onExportReport()
    else if (kind === 'bundle') props.onExportBundle()
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="ตัวกรองสถานะ" className="flex flex-wrap items-center gap-1.5">
          {FILTER_BUTTONS.map((button) => (
            <Button
              key={button.key}
              type="button"
              size="sm"
              variant={props.filter === button.key ? 'default' : 'outline'}
              onClick={() => props.onFilterChange(button.key)}
            >
              <span className={cn('size-2 rounded-full', button.dot)} />
              {button.label}
              <span className="font-mono tabular-nums opacity-80">
                {counts[button.key === 'all' ? 'total' : button.key]}
              </span>
            </Button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={props.search}
              onChange={(event) => props.onSearchChange(event.target.value)}
              placeholder="ค้นหารหัส/ชื่อนักเรียน…"
              className="w-52 pl-8 text-xs"
            />
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={props.onToggleMute}
                  aria-pressed={props.muted}
                  aria-label={props.muted ? 'เปิดเสียงแจ้งเตือน' : 'ปิดเสียงแจ้งเตือน'}
                >
                  {props.muted ? <VolumeX /> : <Volume2 />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {props.muted ? 'เปิดเสียง/แจ้งเตือนเหตุการณ์วิกฤต' : 'ปิดเสียง + ซ่อน toast แจ้งเตือน'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {/* TRI-06: กรอง severity ของ toast กัน alert fatigue */}
          <Select value={props.toastSeverity} onValueChange={(v) => props.onToastSeverityChange(v as TriageToastSeverity)}>
            <SelectTrigger className="w-auto gap-2 text-xs" aria-label="เลือก severity ที่ยอมให้ขึ้น toast">
              <BellRing size={13} className="text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="critical">เตือนเฉพาะวิกฤต</SelectItem>
              <SelectItem value="all">เตือนทั้งหมด</SelectItem>
            </SelectContent>
          </Select>
          {/* TRI-06: รับทราบ alert ที่ค้างทั้งหมดในครั้งเดียว */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.ackingAll || props.pendingAckCount === 0}
            onClick={() => setAckOpen(true)}
            title={`รับทราบเหตุการณ์ค้างทั้งหมด (${props.pendingAckCount} คน)`}
            className="border-destructive/50 text-destructive hover:bg-destructive/10"
          >
            {props.ackingAll ? <Loader2 className="animate-spin" /> : <CheckCheck />}
            {props.ackingAll ? 'กำลังรับทราบ…' : `รับทราบทั้งหมด${props.pendingAckCount > 0 ? ` (${props.pendingAckCount})` : ''}`}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!props.canExport || props.exporting}
            onClick={() => setExportKind('report')}
            title="ส่งออกรายงานเหตุการณ์ (HTML)"
          >
            {props.exporting ? <Loader2 className="animate-spin" /> : <FileDown />}
            รายงานเหตุการณ์
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!props.canExport || props.exporting}
            onClick={() => setExportKind('bundle')}
            title="ส่งออก Audit Bundle (.ztaudit)"
          >
            {props.exporting ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            .ztaudit
          </Button>
        </div>
      </div>

      {/* ยืนยันรับทราบทั้งหมด — destructive ต้อง confirm 2 ชั้น */}
      <Dialog open={ackOpen} onOpenChange={setAckOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>รับทราบเหตุการณ์ค้างทั้งหมด</DialogTitle>
            <DialogDescription>
              รับทราบเหตุการณ์ค้างของ {props.pendingAckCount} คนทั้งหมด (บันทึก cleared ลง audit chain)
              ดำเนินการต่อหรือไม่
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAckOpen(false)}>
              ยกเลิก
            </Button>
            <Button type="button" variant="destructive" onClick={confirmAck}>
              ยืนยันรับทราบทั้งหมด
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ยืนยันส่งออกไฟล์ */}
      <Dialog open={exportKind !== null} onOpenChange={(open) => { if (!open) setExportKind(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {exportKind === 'report' ? 'ส่งออกรายงานเหตุการณ์ (HTML)' : 'ส่งออก Audit Bundle (.ztaudit)'}
            </DialogTitle>
            <DialogDescription>
              {exportKind === 'report'
                ? 'สร้างไฟล์รายงานเหตุการณ์สำหรับส่งผู้คุมสอบ ดำเนินการต่อหรือไม่'
                : 'สร้างไฟล์ Audit Bundle พร้อม hash chain สำหรับตรวจสอบย้อนหลัง ดำเนินการต่อหรือไม่'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setExportKind(null)}>
              ยกเลิก
            </Button>
            <Button type="button" onClick={confirmExport}>
              ยืนยันส่งออก
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

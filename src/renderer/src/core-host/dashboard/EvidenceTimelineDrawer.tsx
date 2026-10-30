import { useEffect, useState } from 'react'
import { History, Loader2, Send, ShieldCheck, ShieldX, Snowflake } from 'lucide-react'
import type { AuditEntryView, ChainVerification, StudentEvidenceResponse } from '@shared/ipc-channels'
import { useAppStore } from '../../store/app-store'
import { timeAgo } from '../../store/triage-store'
import { cn } from '@renderer/lib/utils'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@renderer/components/ui/sheet'
import { Skeleton } from '@renderer/components/ui/skeleton'

interface Props {
  studentId: string
  name: string
  nowMs: number
  onClose: () => void
}

const SEVERITY_BADGE: Record<string, { label: string; className?: string; variant?: 'destructive' | 'outline' | 'secondary' }> = {
  critical: { label: 'วิกฤต', variant: 'destructive' },
  warning: { label: 'เฝ้าระวัง', variant: 'outline', className: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  info: { label: 'ทั่วไป', variant: 'secondary' }
}

/** แผงด้านข้าง: ข้อมูลเครื่อง + Timeline หลักฐาน + แผงบันทึกการตรวจของผู้คุม */
export default function EvidenceTimelineDrawer(props: Props): React.JSX.Element {
  const notify = useAppStore((s) => s.notify)
  const [data, setData] = useState<StudentEvidenceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [resolution, setResolution] = useState<'cleared' | 'confirmed'>('cleared')
  const [note, setNote] = useState('')
  const [warningText, setWarningText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [confirmResolveOpen, setConfirmResolveOpen] = useState(false)
  const [freezeOpen, setFreezeOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.ztExam
      .getStudentEvidence({ studentId: props.studentId })
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [props.studentId])

  async function doSubmitResolution(): Promise<void> {
    setSubmitting(true)
    try {
      const res = await window.ztExam.resolveTriage({
        studentId: props.studentId,
        resolution,
        note: note.trim() ? note.trim() : undefined
      })
      notify({
        severity: resolution === 'confirmed' ? 'critical' : 'info',
        message:
          resolution === 'cleared'
            ? `บันทึกผลตรวจแล้ว (เคลียร์ ${res.affectedAlerts} เหตุการณ์) — ลง audit chain แล้ว`
            : `ยืนยันพบการทุจริต (${res.affectedAlerts} เหตุการณ์) — ปักหมุดหลักฐานแล้ว`
      })
      setNote('')
      const refreshed = await window.ztExam.getStudentEvidence({ studentId: props.studentId })
      setData(refreshed)
    } catch (err) {
      notify({ severity: 'warning', message: err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ' })
    } finally {
      setSubmitting(false)
      setConfirmResolveOpen(false)
    }
  }

  function handleSubmitResolution(): void {
    // TRI-12: ยืนยันพบทุจริตต้อง confirm 2 ชั้น (ปักหมุดถาวรลง audit chain)
    if (resolution === 'confirmed') {
      setConfirmResolveOpen(true)
      return
    }
    void doSubmitResolution()
  }

  async function sendWarning(): Promise<void> {
    if (!warningText.trim()) return
    try {
      await window.ztExam.sendProctorWarning({ studentId: props.studentId, message: warningText.trim() })
      // TRI-19: warn ที่ส่งขณะ frozen จะถูกคิวไว้ฝั่งนักเรียน (ไม่แสดงจนกว่าปลด Freeze)
      if (data?.info?.frozen) {
        notify({ severity: 'warning', message: 'ส่งแล้ว แต่เครื่องนักเรียนถูก Freeze — ข้อความจะค้างแสดงหลังปลด Freeze (หรือส่งซ้ำหลังปลด)' })
      } else {
        notify({ severity: 'info', message: 'ส่งข้อความเตือนขึ้นจอนักเรียนแล้ว' })
      }
      setWarningText('')
    } catch (err) {
      notify({ severity: 'warning', message: err instanceof Error ? err.message : 'ส่งไม่สำเร็จ' })
    }
  }

  async function doToggleFreeze(): Promise<void> {
    const frozen = !(data?.info?.frozen ?? false)
    try {
      await window.ztExam.setStudentFreeze({ studentId: props.studentId, frozen })
      notify({
        severity: frozen ? 'critical' : 'info',
        message: frozen ? 'สั่ง Freeze เครื่องนักเรียนแล้ว' : 'ปลด Freeze แล้ว'
      })
      const refreshed = await window.ztExam.getStudentEvidence({ studentId: props.studentId })
      setData(refreshed)
    } catch (err) {
      notify({ severity: 'warning', message: err instanceof Error ? err.message : 'สั่งไม่สำเร็จ' })
    } finally {
      setFreezeOpen(false)
    }
  }

  function handleToggleFreeze(): void {
    // TRI-12: confirm ก่อนสั่ง Freeze กันกดผิด
    if (!(data?.info?.frozen ?? false)) {
      setFreezeOpen(true)
      return
    }
    void doToggleFreeze()
  }

  const info = data?.info
  const chain: ChainVerification | null = data?.chain ?? null
  const entries: AuditEntryView[] = data?.entries ?? []

  return (
    <Sheet open onOpenChange={(open) => { if (!open) props.onClose() }}>
      <SheetContent side="right" className="flex w-[26rem] max-w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-4 py-3 text-left">
          <SheetTitle className="text-sm">{props.name}</SheetTitle>
          <SheetDescription className="font-mono text-[11px] tabular-nums">{props.studentId}</SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 px-4 py-3">
            {loading && (
              <div className="space-y-2" aria-label="กำลังโหลดหลักฐาน">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            )}

            {!loading && info && (
              <>
                <div className="rounded-md border bg-muted/40 p-3 text-xs">
                  <div className="mb-1.5 font-medium">ข้อมูลเครื่อง</div>
                  <div className="grid grid-cols-2 gap-y-1 text-muted-foreground">
                    <span>สถานะ:</span>
                    <span className={info.online ? 'text-emerald-600 dark:text-emerald-300' : 'text-destructive'}>
                      {info.online ? 'ออนไลน์' : 'ออฟไลน์'} ({info.status})
                    </span>
                    <span>โฟกัส:</span>
                    <span>{info.focusState ?? '—'}</span>
                    <span>VM:</span>
                    <span className={info.vmSuspected ? 'text-amber-600 dark:text-amber-300' : ''}>
                      {info.vmSuspected ? 'สัญญาณน่าสงสัย' : 'ไม่พบสัญญาณ'}
                    </span>
                    <span>Remote:</span>
                    <span className={info.remoteSuspected ? 'text-amber-600 dark:text-amber-300' : ''}>
                      {info.remoteSuspected ? 'สัญญาณน่าสงสัย' : 'ไม่พบสัญญาณ'}
                    </span>
                    <span>เข้าห้อง:</span>
                    <span className="tabular-nums">{timeAgo(info.joinedAtMs, props.nowMs) || '—'}</span>
                    <span>Last seen:</span>
                    <span className="tabular-nums">{timeAgo(info.lastSeenAtMs, props.nowMs) || '—'}</span>
                  </div>
                </div>

                {chain && (
                  <div
                    className={cn(
                      'flex items-center gap-2 rounded-md border px-3 py-2 text-xs',
                      chain.valid
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'border-destructive/60 bg-destructive/10 text-destructive'
                    )}
                  >
                    {chain.valid ? <ShieldCheck size={14} /> : <ShieldX size={14} />}
                    Hash Chain: {chain.valid ? 'Verified' : `TAMPERED (seq ${chain.firstTamperedSeqNo ?? '?'})`}
                    <Badge variant="secondary" className="ml-auto font-mono tabular-nums">
                      {chain.totalEntries} รายการ
                    </Badge>
                  </div>
                )}

                {/* Timeline หลักฐาน — เรียงจากล่าสุดขึ้นบน */}
                <div>
                  <div className="mb-1.5 text-xs font-medium">
                    Timeline เหตุการณ์ <span className="tabular-nums">({entries.length})</span>
                  </div>
                  {entries.length === 0 ? (
                    <div className="flex flex-col items-center gap-1.5 py-6 text-center">
                      <History size={24} className="text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">ไม่มีเหตุการณ์บันทึกไว้</p>
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {entries.map((entry) => {
                        const sev = SEVERITY_BADGE[entry.severity] ?? SEVERITY_BADGE.info!
                        return (
                          <li key={entry.seqNo} className="rounded-md border bg-card px-3 py-2 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex min-w-0 flex-wrap items-center gap-1.5 font-medium">
                                <Badge variant={sev.variant} className={sev.className}>
                                  {sev.label}
                                </Badge>
                                {entry.studentId === 'HOST' && (
                                  <Badge variant="outline">HOST</Badge>
                                )}
                                <span className="break-words">{entry.summaryText || entry.eventCode}</span>
                              </span>
                              <span className="shrink-0 tabular-nums text-muted-foreground">
                                {timeAgo(entry.serverTimestampMs, props.nowMs)}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              {entry.scoreDelta > 0 && (
                                <Badge variant="secondary" className="font-mono tabular-nums">
                                  +{entry.scoreDelta} คะแนน
                                </Badge>
                              )}
                              {entry.eventCode !== entry.summaryText && (
                                <span className="font-mono text-[10px] text-muted-foreground">{entry.eventCode}</span>
                              )}
                            </div>
                            {Object.keys(entry.evidence).length > 0 && (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-[11px] text-primary hover:underline">
                                  ข้อมูลทางเทคนิค
                                </summary>
                                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-[10px] text-muted-foreground">
                                  {JSON.stringify(entry.evidence, null, 1)}
                                </pre>
                                <div className="mt-0.5 font-mono text-[9px] tabular-nums text-muted-foreground">
                                  seq #{entry.seqNo} · hash {entry.entryHash.slice(0, 20)}…
                                </div>
                              </details>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        </ScrollArea>

        {/* แผงบันทึกการตรวจของผู้คุมสอบ */}
        {info && (
          <div className="border-t px-4 py-3">
            <div className="mb-1.5 text-xs font-medium">บันทึกผลการตรวจของผู้คุม</div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                size="sm"
                variant={resolution === 'cleared' ? 'default' : 'outline'}
                onClick={() => setResolution('cleared')}
              >
                ตรวจแล้ว / เข้าใจผิด
              </Button>
              <Button
                type="button"
                size="sm"
                variant={resolution === 'confirmed' ? 'destructive' : 'outline'}
                onClick={() => setResolution('confirmed')}
              >
                ยืนยันพบการทุจริต
              </Button>
            </div>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              maxLength={500}
              placeholder="หมายเหตุของผู้คุม เช่น ตรวจที่เครื่องแล้วพบสคริปต์ต่อ API ข้างนอกจริง"
              className="mt-2 min-h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={resolution === 'confirmed' ? 'destructive' : 'default'}
                disabled={submitting}
                onClick={handleSubmitResolution}
                className="flex-1"
              >
                {submitting && <Loader2 className="animate-spin" />}
                บันทึกลง Audit Chain
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleToggleFreeze}
              >
                <Snowflake /> {info.frozen ? 'ปลด Freeze' : 'Freeze'}
              </Button>
            </div>
            {info.frozen && (
              <p className="mt-2 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-[11px] text-primary">
                เครื่องนี้ถูก Freeze — ข้อความเตือนจะค้างแสดงหลังปลด Freeze (TRI-19)
              </p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <Input
                value={warningText}
                onChange={(event) => setWarningText(event.target.value)}
                maxLength={300}
                placeholder="ข้อความเตือนขึ้นจอนักเรียน…"
                className="text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!warningText.trim()}
                onClick={() => void sendWarning()}
              >
                <Send /> ส่ง
              </Button>
            </div>
          </div>
        )}

        {/* TRI-12: ยืนยันพบทุจริต 2 ชั้น — ปักหมุดถาวรลง audit chain */}
        <Dialog open={confirmResolveOpen} onOpenChange={setConfirmResolveOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>ยืนยันพบการทุจริต — {props.name}</DialogTitle>
              <DialogDescription>
                ผลจะถูกปักหมุดถาวรลง audit chain ตรวจสอบหลักฐานให้แน่ใจก่อนกดยืนยัน
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmResolveOpen(false)}>
                ยกเลิก
              </Button>
              <Button type="button" variant="destructive" disabled={submitting} onClick={() => void doSubmitResolution()}>
                {submitting && <Loader2 className="animate-spin" />}
                ยืนยันพบการทุจริต
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* TRI-12: confirm ก่อนสั่ง Freeze กันกดผิด */}
        <Dialog open={freezeOpen} onOpenChange={setFreezeOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>สั่ง Freeze — {props.name}</DialogTitle>
              <DialogDescription>
                {`สั่ง Freeze เครื่องของ ${props.studentId} หน้าจอนักเรียนจะถูกแช่แข็งทันทีจนกว่าจะปลด ดำเนินการต่อหรือไม่`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFreezeOpen(false)}>
                ยกเลิก
              </Button>
              <Button type="button" variant="destructive" onClick={() => void doToggleFreeze()}>
                ยืนยัน Freeze
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { History, Loader2, Monitor, Pin, Radio, Snowflake, X } from 'lucide-react'
import type { RingSegmentMeta } from '@shared/screen-protocol'
import { useHostScreenStore } from '../../store/screen-store'
import { useTriageStore } from '../../store/triage-store'
import { useAppStore } from '../../store/app-store'
import { cn } from '@renderer/lib/utils'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'

interface Props {
  studentId: string
  name: string
  nowMs: number
  onClose: () => void
}

const HISTORY_WINDOW_MS = 5 * 60 * 1000

/**
 * Phase 3c: Screen Inspector ของผู้คุมสอบ
 * - สลับดูหลายจอ (Display 1 / Display 2 / …) และสลับโหมด ดูสด ↔ ย้อนหลัง 5 นาที
 * - Timeline 5 นาที: บล็อกเซกเมนต์ + จุดมาร์ก Alert (เหลือง/แดง) + เซกเมนต์ที่ Pin
 * - คลิกเซกเมนต์ → ดึงไฟล์ถอดรหัสจากเครื่องนักเรียนมาเล่นทันที (Pull-on-Demand)
 * - ทุกการเปิดดูถูกบันทึกลง Audit Log โดยเครื่องแม่ (PROCTOR_VIEWED_SCREEN)
 */
export default function ProctorScreenModal(props: Props): React.JSX.Element {
  const thumbnails = useHostScreenStore((s) => s.thumbnails)
  const segmentsByStudent = useHostScreenStore((s) => s.segmentsByStudent)
  const segmentData = useHostScreenStore((s) => s.segmentData)
  const ingestThumbnail = useHostScreenStore((s) => s.ingestThumbnail)
  const ingestSegments = useHostScreenStore((s) => s.ingestSegments)
  const ingestSegmentData = useHostScreenStore((s) => s.ingestSegmentData)
  const ingestLiveSegment = useHostScreenStore((s) => s.ingestLiveSegment)
  const overview = useTriageStore((s) => s.overview)
  const notify = useAppStore((s) => s.notify)
  const [mode, setMode] = useState<'live' | 'playback'>('playback')
  const [selectedDisplayId, setSelectedDisplayId] = useState<string | null>(null)
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [stillLoaded, setStillLoaded] = useState(false)
  const [freezeOpen, setFreezeOpen] = useState(false)
  const [freezing, setFreezing] = useState(false)
  /** โหมดสด: ติดตามเซกเมนต์ใหม่อัตโนมัติ (ปิดเมื่อผู้คุมลาก timeline ไปย้อนหลัง) */
  const [followLive, setFollowLive] = useState(true)

  useEffect(() => {
    const unsubThumb = window.ztExam.onEvent('host:screen-thumbnail', (event) => {
      if (event.studentId === props.studentId) ingestThumbnail(event)
    })
    const unsubSegments = window.ztExam.onEvent('host:screen-segments', (event) => {
      if (event.studentId === props.studentId) ingestSegments(event)
    })
    const unsubData = window.ztExam.onEvent('host:screen-segment-data', (event) => {
      if (event.studentId === props.studentId) {
        ingestSegmentData(event)
        setFetching(false)
      }
    })
    // Phase 3c (UDP): เซกเมนต์สด 720p/30fps สตรีมมาทาง UDP — DVR timeline เล่นได้ทันที
    const unsubLive = window.ztExam.onEvent('host:screen-live-segment', (event) => {
      if (event.studentId === props.studentId) ingestLiveSegment(event)
    })
    return () => {
      unsubThumb()
      unsubSegments()
      unsubData()
      unsubLive()
    }
  }, [props.studentId, ingestThumbnail, ingestSegments, ingestSegmentData, ingestLiveSegment])

  // เปิด modal = ขอรายการวิดีโอย้อนหลัง 5 นาทีทันที (ลง Audit ให้เองที่เครื่องแม่)
  useEffect(() => {
    void window.ztExam.screenInspect({ studentId: props.studentId, mode: 'playback' }).catch(() => undefined)
    return () => {
      void window.ztExam.screenInspect({ studentId: props.studentId, mode: 'stop' }).catch(() => undefined)
    }
  }, [props.studentId])

  /* ---------- ข้อมูลจอ + เซกเมนต์ ---------- */

  const displayIds = useMemo(() => {
    const ids = new Set<string>()
    for (const frame of Object.values(thumbnails)) {
      if (frame.studentId === props.studentId) ids.add(frame.displayId)
    }
    const perStudent = segmentsByStudent[props.studentId]
    if (perStudent) for (const displayId of Object.keys(perStudent)) ids.add(displayId)
    return [...ids].sort()
  }, [thumbnails, segmentsByStudent, props.studentId])

  const activeDisplayId = selectedDisplayId ?? displayIds[0] ?? null
  const segments: RingSegmentMeta[] = activeDisplayId
    ? (segmentsByStudent[props.studentId]?.[activeDisplayId] ?? [])
    : []

  // เฟรมล่าสุดของจอที่เลือก (โหมดสดใช้เฟรม mode=live ถ้ามี, ไม่งั้นภาพย่อล่าสุด)
  const liveFrame = useMemo(() => {
    let best: (typeof thumbnails)[string] | undefined
    for (const frame of Object.values(thumbnails)) {
      if (frame.studentId !== props.studentId) continue
      if (activeDisplayId && frame.displayId !== activeDisplayId) continue
      if (frame.mode !== (mode === 'live' ? 'live' : 'thumbnail')) continue
      if (!best || frame.timestampMs > best.timestampMs) best = frame
    }
    return best
  }, [thumbnails, props.studentId, activeDisplayId, mode])

  const stillSrc = liveFrame ? `data:${liveFrame.mimeType};base64,${liveFrame.imageBase64}` : null

  useEffect(() => {
    setStillLoaded(false)
  }, [stillSrc])

  const videoUrl = useMemo(() => {
    if (!selectedSegmentId) return null
    const entry = segmentData[selectedSegmentId]
    if (!entry) return null
    try {
      const binary = atob(entry.dataBase64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      return URL.createObjectURL(new Blob([bytes], { type: entry.mimeType }))
    } catch {
      return null
    }
  }, [selectedSegmentId, segmentData])

  /* ---------- DVR (โหมดสด): ติดตามเซกเมนต์ใหม่อัตโนมัติ + เลื่อนย้อนได้เหมือน YouTube ---------- */

  const newestSegment = segments.length > 0 ? segments[segments.length - 1] : null

  // โหมดสด + followLive: ค้างอยู่ตัวใหม่ล่าสุดเมื่อข้อมูลมาถึง (ผู้คุมลาก timeline → follow จะปิดเอง)
  useEffect(() => {
    if (mode !== 'live' || !followLive) return
    if (!newestSegment) return
    if (!segmentData[newestSegment.segmentId]) return
    setSelectedSegmentId(newestSegment.segmentId)
  }, [mode, followLive, newestSegment, segmentData])

  /** เลือกเซกเมนต์เอง = ปิดการติดตามสด (ดูย้อนหลัง) */
  function selectSegment(segment: RingSegmentMeta): void {
    setFollowLive(false)
    setSelectedSegmentId(segment.segmentId)
  }

  /** เซกเมนต์จบ → วิ่งไปตัวถัดไป (ต่อเนื่องเหมือน YouTube) */
  function advanceToNext(): void {
    if (segments.length === 0) return
    const index = segments.findIndex((segment) => segment.segmentId === selectedSegmentId)
    const next = segments[index + 1]
    if (next) {
      setSelectedSegmentId(next.segmentId)
      return
    }
    // ถึงตัวล่าสุดแล้ว — กลับไปติดตามสดต่อเมื่ออยู่โหมด live
    if (mode === 'live') setFollowLive(true)
  }

  /** กลับเข้าสู่ไหลสดล่าสุด (ตามจอใหม่ล่าสุดทันที) */
  function followLatestLive(): void {
    setFollowLive(true)
  }

  const nowMs = Math.max(props.nowMs, Date.now())
  const historyStartMs = nowMs - HISTORY_WINDOW_MS
  const unpinnedOldest = segments.find((s) => s.pinnedReason === undefined)
  const countdownSeconds = unpinnedOldest
    ? Math.max(0, Math.floor((unpinnedOldest.startTimeMs + HISTORY_WINDOW_MS - nowMs) / 1000))
    : null

  // มาร์กตำแหน่ง Alert บน timeline (จาก triage ของนักเรียนคนนี้ในช่วง 5 นาที)
  const alertMarkers = useMemo(() => {
    const view = overview?.students.find((s) => s.studentId === props.studentId)
    if (!view) return []
    return view.alerts
      .filter((alert) => alert.lastSeenAtMs >= historyStartMs)
      .map((alert) => ({ atMs: alert.lastSeenAtMs, severity: alert.severity, text: alert.summaryText }))
  }, [overview, props.studentId, historyStartMs])

  const frozen = overview?.students.find((s) => s.studentId === props.studentId)?.frozen ?? false

  async function switchMode(next: 'live' | 'playback'): Promise<void> {
    if (next === mode) return
    setMode(next)
    setSelectedSegmentId(null)
    setFollowLive(true)
    await window.ztExam
      .screenInspect({ studentId: props.studentId, mode: next === 'live' ? 'live' : 'playback' })
      .catch(() => undefined)
  }

  function fetchSegment(segment: RingSegmentMeta): void {
    // คลิก Timeline = ผู้คุมเลือกดูเอง → ปิดการติดตามสดชั่วคราว
    selectSegment(segment)
    if (segmentData[segment.segmentId]) return
    setFetching(true)
    void window.ztExam
      .fetchRingSegment({ studentId: props.studentId, segmentId: segment.segmentId })
      .catch(() => setFetching(false))
  }

  async function doToggleFreeze(): Promise<void> {
    setFreezing(true)
    try {
      const res = await window.ztExam.setStudentFreeze({ studentId: props.studentId, frozen: !frozen })
      if (!res.ok) {
        notify({ severity: 'critical', message: `สั่ง ${frozen ? 'ปลด Freeze' : 'Freeze'} ไม่สำเร็จ` })
      } else {
        notify({ severity: frozen ? 'info' : 'critical', message: frozen ? 'ปลด Freeze แล้ว' : 'สั่ง Freeze เครื่องนักเรียนแล้ว' })
      }
    } catch (err) {
      notify({ severity: 'warning', message: err instanceof Error ? err.message : 'สั่งไม่สำเร็จ' })
    } finally {
      setFreezing(false)
      setFreezeOpen(false)
    }
  }

  const waitingLive = mode === 'live' && !videoUrl && !stillSrc

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose() }}>
      <DialogContent className="flex max-h-[92vh] max-w-4xl flex-col gap-0 overflow-hidden p-0">
        {/* Header */}
        <DialogHeader className="border-b px-5 py-3 text-left">
          <div className="flex items-center gap-2">
            <Monitor size={18} className="shrink-0 text-primary" />
            <DialogTitle className="text-base">Screen Inspector — {props.name}</DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto"
              onClick={props.onClose}
              aria-label="ปิด Screen Inspector"
            >
              <X size={16} />
            </Button>
          </div>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <span className="font-mono tabular-nums">{props.studentId}</span>
            {frozen && (
              <Badge variant="secondary">
                <Snowflake />
                แช่แข็ง
              </Badge>
            )}
            <span>ทุกการเปิดดูถูกบันทึกลง Audit Log (hash chain) · วิดีโอย้อนหลังเก็บที่เครื่องนักเรียน 5 นาทีล่าสุด</span>
          </DialogDescription>
        </DialogHeader>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2">
          <Button
            type="button"
            size="sm"
            variant={mode === 'live' ? 'destructive' : 'outline'}
            onClick={() => void switchMode('live')}
          >
            <Radio /> ดูสด (720p · UDP)
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === 'playback' ? 'default' : 'outline'}
            onClick={() => void switchMode('playback')}
          >
            <History /> ย้อนหลัง 5 นาที
          </Button>
          {mode === 'live' && !followLive && (
            <Button type="button" size="sm" variant="destructive" onClick={followLatestLive}>
              <Radio /> กลับไปดูสด
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void window.ztExam
                .pinScreenBuffer({ studentId: props.studentId, reason: 'PROCTOR_PIN-DASHBOARD' })
                .catch(() => undefined)
            }}
            className="border-amber-500/50 text-amber-700 dark:text-amber-300"
          >
            <Pin /> Pin ล็อกหลักฐาน
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={freezing}
            onClick={() => (frozen ? void doToggleFreeze() : setFreezeOpen(true))}
          >
            {freezing ? <Loader2 className="animate-spin" /> : <Snowflake />}
            {frozen ? 'ปลด Freeze' : 'Freeze'}
          </Button>
          {countdownSeconds !== null && mode === 'playback' && (
            <span className="ml-auto text-xs tabular-nums text-amber-700 dark:text-amber-300">
              วิดีโอย้อนหลังช่วงนี้จะถูกเขียนทับในอีก {Math.floor(countdownSeconds / 60)}:{String(countdownSeconds % 60).padStart(2, '0')} นาที
            </span>
          )}
        </div>

        {/* Display tabs */}
        {displayIds.length > 1 && (
          <div className="flex gap-1 border-b px-5 py-2">
            {displayIds.map((displayId, index) => (
              <Button
                key={displayId}
                type="button"
                size="sm"
                variant={activeDisplayId === displayId ? 'secondary' : 'ghost'}
                onClick={() => setSelectedDisplayId(displayId)}
              >
                Display {index + 1}
              </Button>
            ))}
          </div>
        )}

        {/* Viewer */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
          {videoUrl ? (
            <video
              key={videoUrl}
              src={videoUrl}
              controls
              autoPlay
              onEnded={advanceToNext}
              className="max-h-[46vh] w-full rounded-md border bg-muted object-contain"
            />
          ) : stillSrc ? (
            <div className="relative">
              {!stillLoaded && <Skeleton className="h-[30vh] w-full" />}
              <img
                src={stillSrc}
                alt="ภาพหน้าจอนักเรียน"
                onLoad={() => setStillLoaded(true)}
                className={cn(
                  'max-h-[46vh] w-full rounded-md border bg-muted object-contain',
                  !stillLoaded && 'hidden'
                )}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2" aria-label="กำลังโหลดภาพหน้าจอ">
              {(fetching || waitingLive) && <Skeleton className="h-[30vh] w-full" />}
              <div className="flex items-center justify-center gap-2 rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
                {fetching ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin" /> กำลังดึงเซกเมนต์จากเครื่องนักเรียน…
                  </span>
                ) : mode === 'live' ? (
                  'กำลังรอวิดีโอสด 720p/30fps ผ่านช่องทาง UDP…'
                ) : (
                  'ยังไม่มีภาพ — คลิกเซกเมนต์บน Timeline ด้านล่าง'
                )}
              </div>
            </div>
          )}

          {/* Timeline 5 นาที */}
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
              <span>-5 นาที</span>
              <span>Timeline วิดีโอย้อนหลัง ({segments.length} เซกเมนต์ · คลิกเพื่อดู)</span>
              <span>ตอนนี้</span>
            </div>
            <div className="relative h-9 overflow-hidden rounded-md border bg-muted/40">
              {segments.map((segment) => {
                const offset = Math.min(
                  100,
                  Math.max(0, ((segment.startTimeMs - historyStartMs) / HISTORY_WINDOW_MS) * 100)
                )
                const width = Math.max(1.2, ((segment.endTimeMs - segment.startTimeMs) / HISTORY_WINDOW_MS) * 100)
                const isSelected = segment.segmentId === selectedSegmentId
                return (
                  <button
                    key={segment.segmentId}
                    type="button"
                    title={`เซกเมนต์ #${segment.seqNo}${segment.pinnedReason ? ' (Pin: ' + segment.pinnedReason + ')' : ''}`}
                    onClick={() => fetchSegment(segment)}
                    style={{ left: `${offset}%`, width: `${width}%` }}
                    className={cn(
                      'absolute top-1 h-7 rounded transition',
                      segment.pinnedReason !== undefined
                        ? 'bg-amber-500/80 hover:bg-amber-500'
                        : 'bg-primary/70 hover:bg-primary',
                      isSelected && 'ring-2 ring-ring'
                    )}
                  />
                )
              })}
              {alertMarkers.map((marker, index) => {
                const offset = Math.min(100, Math.max(0, ((marker.atMs - historyStartMs) / HISTORY_WINDOW_MS) * 100))
                return (
                  <span
                    key={`${marker.atMs}-${index}`}
                    title={marker.text}
                    style={{ left: `${offset}%` }}
                    className={cn(
                      'absolute top-0 h-full w-1 -translate-x-1/2',
                      marker.severity === 'critical' ? 'bg-destructive' : 'bg-amber-400'
                    )}
                  />
                )
              })}
            </div>
          </div>
        </div>

        {/* ยืนยัน Freeze จากห้องตรวจจอ */}
        <Dialog open={freezeOpen} onOpenChange={setFreezeOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>สั่ง Freeze — {props.name}</DialogTitle>
              <DialogDescription>
                {`สั่ง Freeze เครื่องของ ${props.studentId} หน้าจอนักเรียนจะถูกแช่แข็งทันทีจนกว่าจะปลด ดำเนินการต่อหรือไม่`}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
              <Button type="button" variant="outline" onClick={() => setFreezeOpen(false)}>
                ยกเลิก
              </Button>
              <Button type="button" variant="destructive" disabled={freezing} onClick={() => void doToggleFreeze()}>
                {freezing && <Loader2 className="animate-spin" />}
                ยืนยัน Freeze
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}

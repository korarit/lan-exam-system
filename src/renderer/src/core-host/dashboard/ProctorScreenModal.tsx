import { useEffect, useMemo, useState } from 'react'
import { Monitor, X, History, Radio, Pin, Loader2 } from 'lucide-react'
import type { RingSegmentMeta } from '@shared/screen-protocol'
import { useHostScreenStore } from '../../store/screen-store'
import { useTriageStore } from '../../store/triage-store'

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
  const overview = useTriageStore((s) => s.overview)
  const [mode, setMode] = useState<'live' | 'playback'>('playback')
  const [selectedDisplayId, setSelectedDisplayId] = useState<string | null>(null)
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)

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
    return () => {
      unsubThumb()
      unsubSegments()
      unsubData()
    }
  }, [props.studentId, ingestThumbnail, ingestSegments, ingestSegmentData])

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

  async function switchMode(next: 'live' | 'playback'): Promise<void> {
    if (next === mode) return
    setMode(next)
    setSelectedSegmentId(null)
    await window.ztExam
      .screenInspect({ studentId: props.studentId, mode: next === 'live' ? 'live' : 'playback' })
      .catch(() => undefined)
  }

  function fetchSegment(segment: RingSegmentMeta): void {
    setSelectedSegmentId(segment.segmentId)
    if (segmentData[segment.segmentId]) return
    setFetching(true)
    void window.ztExam
      .fetchRingSegment({ studentId: props.studentId, segmentId: segment.segmentId })
      .catch(() => setFetching(false))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
      <div className="flex h-full max-h-[92vh] w-full max-w-4xl flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <Monitor size={18} className="text-sky-400" />
          <div>
            <h3 className="font-semibold text-slate-100">Screen Inspector — {props.name}</h3>
            <p className="text-[11px] text-slate-500">
              ทุกการเปิดดูถูกบันทึกลง Audit Log (hash chain) · วิดีโอย้อนหลังเก็บที่เครื่องนักเรียน 5 นาทีล่าสุด
            </p>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            className="ml-auto rounded-lg border border-slate-700 p-2 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
          >
            <X size={16} />
          </button>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-5 py-2">
          <button
            type="button"
            onClick={() => void switchMode('live')}
            className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              mode === 'live' ? 'bg-red-700 text-white' : 'border border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            <Radio size={13} /> ดูสด
          </button>
          <button
            type="button"
            onClick={() => void switchMode('playback')}
            className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              mode === 'playback' ? 'bg-sky-700 text-white' : 'border border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            <History size={13} /> ย้อนหลัง 5 นาที
          </button>
          <button
            type="button"
            onClick={() => {
              void window.ztExam
                .pinScreenBuffer({ studentId: props.studentId, reason: 'PROCTOR_PIN-DASHBOARD' })
                .catch(() => undefined)
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-amber-700/60 px-3 py-1.5 text-xs font-medium text-amber-300 transition hover:bg-amber-950/40"
          >
            <Pin size={13} /> Pin ล็อกหลักฐาน
          </button>
          {countdownSeconds !== null && mode === 'playback' && (
            <span className="ml-auto text-xs text-amber-300">
              วิดีโอย้อนหลังช่วงนี้จะถูกเขียนทับในอีก {Math.floor(countdownSeconds / 60)}:{String(countdownSeconds % 60).padStart(2, '0')} นาที
            </span>
          )}
        </div>

        {/* Display tabs */}
        {displayIds.length > 1 && (
          <div className="flex gap-1 border-b border-slate-800 px-5 py-2">
            {displayIds.map((displayId, index) => (
              <button
                key={displayId}
                type="button"
                onClick={() => setSelectedDisplayId(displayId)}
                className={`rounded px-3 py-1 text-xs transition ${
                  activeDisplayId === displayId
                    ? 'bg-sky-700/40 text-sky-200'
                    : 'text-slate-400 hover:bg-slate-800'
                }`}
              >
                Display {index + 1}
              </button>
            ))}
          </div>
        )}

        {/* Viewer */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
          {videoUrl && mode === 'playback' ? (
            <video
              key={videoUrl}
              src={videoUrl}
              controls
              autoPlay
              className="max-h-[46vh] w-full rounded-xl border border-slate-800 bg-black"
            />
          ) : liveFrame ? (
            <img
              src={`data:${liveFrame.mimeType};base64,${liveFrame.imageBase64}`}
              alt="student screen"
              className="max-h-[46vh] w-full rounded-xl border border-slate-800 bg-black object-contain"
            />
          ) : (
            <div className="flex h-[30vh] items-center justify-center rounded-xl border border-dashed border-slate-800 text-sm text-slate-500">
              {fetching ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" /> กำลังดึงเซกเมนต์จากเครื่องนักเรียน…
                </span>
              ) : mode === 'live' ? (
                'กำลังรอภาพสดจากเครื่องนักเรียน… (5-10 fps)'
              ) : (
                'ยังไม่มีภาพ — รอเครื่องนักเรียนส่งภาพย่อ / รายการวิดีโอย้อนหลัง'
              )}
            </div>
          )}

          {/* Timeline 5 นาที */}
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
              <span>-5 นาที</span>
              <span>Timeline วิดีโอย้อนหลัง ({segments.length} เซกเมนต์ · คลิกเพื่อดู)</span>
              <span>ตอนนี้</span>
            </div>
            <div className="relative h-9 overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
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
                    className={`absolute top-1 h-7 rounded transition ${
                      segment.pinnedReason !== undefined
                        ? 'bg-amber-600/80 hover:bg-amber-500'
                        : 'bg-sky-800/80 hover:bg-sky-700'
                    } ${isSelected ? 'ring-2 ring-white/70' : ''}`}
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
                    className={`absolute top-0 h-full w-1 -translate-x-1/2 ${
                      marker.severity === 'critical' ? 'bg-red-500' : 'bg-amber-400'
                    }`}
                  />
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

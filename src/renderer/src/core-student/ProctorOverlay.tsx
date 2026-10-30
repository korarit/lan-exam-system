import { useEffect, useRef, useState } from 'react'
import { Snowflake, MessageSquareWarning } from 'lucide-react'

/* ============================================================
 * Phase 3b: ผลของการกดปุ่มผู้คุมสอบฝั่งเครื่องนักเรียน
 * - PROCTOR_WARNING → แถบข้อความเตือนขึ้นจอ ~10 วินาที
 * - FREEZE_EXAM / UNFREEZE_EXAM → overlay แช่หน้าจอเต็มจอ
 * ============================================================ */

const WARNING_VISIBLE_MS = 10_000

export default function ProctorOverlay(): React.JSX.Element {
  const [frozen, setFrozen] = useState(false)
  const [freezeReason, setFreezeReason] = useState('')
  const [warning, setWarning] = useState<string | null>(null)
  /** TRI-19: warn ที่มาถึงขณะ frozen — คิวไว้แสดงหลังปลด Freeze แทนการทิ้ง */
  const [queuedWarning, setQueuedWarning] = useState<string | null>(null)
  /** Privacy: ไฟสถานะเมื่อครูกำลังดูจอ (screen:inspect live/playback) */
  const [inspectMode, setInspectMode] = useState<'live' | 'playback' | null>(null)
  const warningTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frozenRef = useRef(false)

  function showWarning(message: string): void {
    setWarning(message)
    if (warningTimer.current) clearTimeout(warningTimer.current)
    warningTimer.current = setTimeout(() => setWarning(null), WARNING_VISIBLE_MS)
  }

  useEffect(() => {
    const unsubFreeze = window.ztExam.onEvent('exam:freeze-state', (event) => {
      frozenRef.current = event.frozen
      setFrozen(event.frozen)
      setFreezeReason(event.reason ?? '')
      if (!event.frozen) {
        // TRI-19: ปลด Freeze แล้ว — ปล่อยข้อความที่ค้างออกมา + ล้างคิว
        setQueuedWarning((queued) => {
          if (queued) showWarning(queued)
          return null
        })
      }
    })
    const unsubWarning = window.ztExam.onEvent('exam:proctor-warning', (event) => {
      if (frozenRef.current) {
        setQueuedWarning(event.message)
      } else {
        showWarning(event.message)
      }
    })
    const unsubInspect = window.ztExam.onEvent('screen:inspect', (event) => {
      setInspectMode(event.mode === 'stop' ? null : event.mode)
    })
    return () => {
      unsubFreeze()
      unsubWarning()
      unsubInspect()
      if (warningTimer.current) clearTimeout(warningTimer.current)
    }
  }, [])

  return (
    <>
      {/* Privacy: ไฟสถานะ/consent banner — บอกนักเรียนชัดว่ากำลังถูกดูจอ + ลง audit แล้ว */}
      {inspectMode && (
        <div className="fixed inset-x-0 top-0 z-[55] flex justify-center p-3">
          <div className="flex items-center gap-2 rounded-xl border border-red-600/70 bg-red-950/95 px-4 py-2 text-sm text-red-100 shadow-lg">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
            </span>
            <span>
              <strong className="mr-1">ครูกำลังดูหน้าจอของคุณ</strong>
              ({inspectMode === 'live' ? 'สด' : 'ย้อนหลัง'} · บันทึก audit แล้ว)
            </span>
          </div>
        </div>
      )}
      {warning && !frozen && (
        <div className="fixed inset-x-0 top-0 z-50 flex justify-center p-3">
          <div className="flex items-center gap-2 rounded-xl border border-amber-600/70 bg-amber-950/95 px-4 py-3 text-sm text-amber-100 shadow-lg">
            <MessageSquareWarning size={16} className="shrink-0 text-amber-400" />
            <span>
              <strong className="mr-1">ข้อความจากผู้คุมสอบ:</strong>
              {warning}
            </span>
          </div>
        </div>
      )}

      {frozen && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-slate-950/98 backdrop-blur-sm">
          <Snowflake size={56} className="mb-4 text-sky-400" />
          <h2 className="text-xl font-semibold text-slate-100">เครื่องถูกแช่แข็งชั่วคราว</h2>
          <p className="mt-2 max-w-md text-center text-sm text-slate-400">
            {freezeReason || 'ผู้คุมสอบสั่งหยุดการทำข้อสอบชั่วคราว'}
          </p>
          <p className="mt-4 text-xs text-slate-500">รอผู้คุมสอบปลดล็อก… ห้ามปิดแอป</p>
          {queuedWarning && (
            <p className="mt-2 max-w-md text-center text-xs text-amber-300">
              มีข้อความจากผู้คุมสอบค้างอยู่ 1 ข้อความ — จะแสดงหลังปลด Freeze
            </p>
          )}
        </div>
      )}
    </>
  )
}

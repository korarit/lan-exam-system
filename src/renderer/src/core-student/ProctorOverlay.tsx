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
  const warningTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const unsubFreeze = window.ztExam.onEvent('exam:freeze-state', (event) => {
      setFrozen(event.frozen)
      setFreezeReason(event.reason ?? '')
      if (!event.frozen) setWarning(null)
    })
    const unsubWarning = window.ztExam.onEvent('exam:proctor-warning', (event) => {
      setWarning(event.message)
      if (warningTimer.current) clearTimeout(warningTimer.current)
      warningTimer.current = setTimeout(() => setWarning(null), WARNING_VISIBLE_MS)
    })
    return () => {
      unsubFreeze()
      unsubWarning()
      if (warningTimer.current) clearTimeout(warningTimer.current)
    }
  }, [])

  return (
    <>
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
        </div>
      )}
    </>
  )
}

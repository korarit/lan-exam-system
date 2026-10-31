import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronsLeft, ChevronsRight, ChevronsUp, ChevronsDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

/* ============================================================
 * ResizableSplit — ตัวแบ่งปรับขนาดได้ (ลาก / ดับเบิลคลิก reset / ซ่อน)
 * - direction 'horizontal': ซ้าย | ขวา (mobile จะ stack แนวตั้งอัตโนมัติ)
 * - direction 'vertical': บน | ล่าง
 * - จำ ratio ลง localStorage ต่อ storageKey
 * ============================================================ */

interface Props {
  direction: 'horizontal' | 'vertical'
  /** ratio เริ่มต้นของ pane แรก (0-1) */
  defaultRatio: number
  /** key สำหรับจำค่า (ไม่ส่ง = ไม่จำ) */
  storageKey?: string
  minRatio?: number
  maxRatio?: number
  first: React.ReactNode
  second: React.ReactNode
  firstLabel?: string
  secondLabel?: string
  className?: string
}

type Collapsed = null | 'first' | 'second'

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function loadRatio(key: string | undefined, fallback: number, lo: number, hi: number): number {
  if (key === undefined) return fallback
  try {
    const raw = localStorage.getItem(`codeide-split:${key}`)
    if (raw === null) return fallback
    const v = Number(raw)
    if (!Number.isFinite(v)) return fallback
    return clamp(v, lo, hi)
  } catch {
    return fallback
  }
}

export default function ResizableSplit(props: Props): React.JSX.Element {
  const lo = props.minRatio ?? 0.15
  const hi = props.maxRatio ?? 0.85
  const [ratio, setRatio] = useState(() => loadRatio(props.storageKey, props.defaultRatio, lo, hi))
  const [collapsed, setCollapsed] = useState<Collapsed>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef(false)
  const isHorizontal = props.direction === 'horizontal'

  useEffect(() => {
    if (props.storageKey === undefined) return
    try {
      localStorage.setItem(`codeide-split:${props.storageKey}`, String(ratio))
    } catch {
      /* จำไม่ได้ — ข้าม */
    }
  }, [ratio, props.storageKey])

  const ratioFromPointer = useCallback(
    (clientX: number, clientY: number): number => {
      const el = containerRef.current
      if (el === null) return props.defaultRatio
      const rect = el.getBoundingClientRect()
      // horizontal บนจอ lg = แบ่งซ้าย/ขวา (แกน X) นอกนั้นแบ่งบน/ล่าง (แกน Y)
      const lg = window.matchMedia('(min-width: 1024px)').matches
      if (isHorizontal && lg) {
        if (rect.width <= 0) return props.defaultRatio
        return clamp((clientX - rect.left) / rect.width, lo, hi)
      }
      if (rect.height <= 0) return props.defaultRatio
      return clamp((clientY - rect.top) / rect.height, lo, hi)
    },
    [isHorizontal, lo, hi, props.defaultRatio]
  )

  function onPointerDown(e: React.PointerEvent): void {
    e.preventDefault()
    dragRef.current = true
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent): void {
    if (!dragRef.current) return
    setRatio(ratioFromPointer(e.clientX, e.clientY))
    if (collapsed !== null) setCollapsed(null)
  }

  function endDrag(): void {
    dragRef.current = false
  }

  function reset(): void {
    setRatio(props.defaultRatio)
    setCollapsed(null)
  }

  const showFirst = collapsed !== 'first'
  const showSecond = collapsed !== 'second'
  // flexBasis % ใช้ได้ทั้ง row (กว้าง) และ col (สูง) — mobile ที่ stack ก็แบ่ง 40/60 ตามแนวตั้งให้เอง
  const firstBasis = collapsed === 'second' ? '100%' : collapsed === 'first' ? '0%' : `${ratio * 100}%`
  const secondBasis = collapsed === 'first' ? '100%' : collapsed === 'second' ? '0%' : `${(1 - ratio) * 100}%`

  return (
    <div
      ref={containerRef}
      className={cn('flex min-h-0 min-w-0 flex-1', isHorizontal ? 'flex-col lg:flex-row' : 'flex-col', props.className)}
    >
      {showFirst && (
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden" style={{ flexBasis: firstBasis, flexGrow: 0, flexShrink: 0 }}>
          {props.first}
        </div>
      )}

      {showFirst && showSecond && (
        <div
          role="separator"
          aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
          title={`ลากเพื่อปรับขนาด — ดับเบิลคลิกเพื่อรีเซ็ต (${Math.round(ratio * 100)}/${Math.round((1 - ratio) * 100)})`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={reset}
          className={cn(
            'group relative z-10 flex shrink-0 touch-none select-none items-center justify-center bg-border/60 hover:bg-primary/40',
            isHorizontal
              ? 'h-2 cursor-row-resize flex-row lg:h-auto lg:w-2 lg:cursor-col-resize lg:flex-col'
              : 'h-2 cursor-row-resize flex-row'
          )}
        >
          {/* ปุ่มซ่อน/แสดง */}
          <span
            className="absolute flex items-center gap-0.5 rounded-full border bg-card px-1 py-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Button
              type="button" variant="ghost" size="icon" className="h-5 w-5"
              title={isHorizontal ? 'ซ่อนแผงซ้าย' : 'ซ่อนแผงบน'}
              onClick={() => setCollapsed('first')}
            >
              {isHorizontal ? <ChevronsLeft size={12} /> : <ChevronsUp size={12} />}
            </Button>
            <Button
              type="button" variant="ghost" size="icon" className="h-5 w-5"
              title="รีเซ็ตขนาด"
              onClick={reset}
            >
              <span className="font-mono text-[10px] tabular-nums">{Math.round(ratio * 100)}</span>
            </Button>
            <Button
              type="button" variant="ghost" size="icon" className="h-5 w-5"
              title={isHorizontal ? 'ซ่อนแผงขวา' : 'ซ่อนแผงล่าง'}
              onClick={() => setCollapsed('second')}
            >
              {isHorizontal ? <ChevronsRight size={12} /> : <ChevronsDown size={12} />}
            </Button>
          </span>
          <span
            className={cn(
              'rounded-full bg-muted-foreground/40 group-hover:bg-primary',
              isHorizontal ? 'h-8 w-1 lg:h-8 lg:w-1' : 'h-1 w-8'
            )}
          />
        </div>
      )}

      {/* แถบกู้คืนเมื่อซ่อนฝั่งใดฝั่งหนึ่ง */}
      {!showFirst || !showSecond ? (
        <button
          type="button"
          onClick={() => setCollapsed(null)}
          title="คลิกเพื่อแสดงแผงที่ซ่อนไว้"
          className={cn(
            'flex shrink-0 items-center justify-center bg-muted/60 text-[11px] text-muted-foreground hover:bg-primary/20 hover:text-primary',
            isHorizontal ? 'h-6 w-full lg:h-auto lg:w-6' : 'h-6 w-full'
          )}
        >
          {collapsed === 'first'
            ? (props.firstLabel ?? (isHorizontal ? 'แสดงแผงซ้าย' : 'แสดงแผงบน'))
            : (props.secondLabel ?? (isHorizontal ? 'แสดงแผงขวา' : 'แสดงแผงล่าง'))}
        </button>
      ) : null}

      {showSecond && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={{ flexBasis: secondBasis, flexGrow: 0, flexShrink: 0 }}>
          {props.second}
        </div>
      )}
    </div>
  )
}

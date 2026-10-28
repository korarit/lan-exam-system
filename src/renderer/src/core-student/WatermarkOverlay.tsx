import { useEffect, useRef } from 'react'

export interface WatermarkOverlayProps {
  studentId: string
  studentName: string
  deviceLabel: string
}

/**
 * Dynamic canvas watermark (checklist 2.5.2):
 * - ลายน้ำแนวทแยงทั่วหน้าจอ opacity ต่ำ (0.10), pointer-events none, z-index สูงสุด
 * - เนื้อหา: รหัสนักเรียน • ชื่อ • เครื่อง • เวลาปัจจุบัน
 * - ขยับตำแหน่งเล็กน้อยทุก 30 วินาที กันการปลอม/ลบเป็นชุดเดียวกัน
 */
export default function WatermarkOverlay(props: WatermarkOverlayProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let raf = 0
    let shift = 0
    const draw = (): void => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const width = window.innerWidth
      const height = window.innerHeight
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      ctx.clearRect(0, 0, width, height)
      const stamp = new Date().toLocaleTimeString('th-TH', { hour12: false })
      const line = `${props.studentId} • ${props.studentName} • ${props.deviceLabel} • ${stamp}`
      ctx.save()
      ctx.font = '600 16px "Sarabun", system-ui, sans-serif'
      ctx.fillStyle = 'rgba(148, 163, 184, 0.10)'
      ctx.translate(shift % 96, shift % 96)
      for (let y = -height; y < height * 2; y += 96) {
        ctx.save()
        ctx.translate(0, y)
        ctx.rotate(-Math.PI / 9)
        ctx.fillText(line, -width * 0.4, 0)
        ctx.fillText(line, -width * 0.4 + width * 0.85, 0)
        ctx.restore()
      }
      ctx.restore()
    }
    const schedule = (): void => {
      raf = window.setTimeout(() => {
        draw()
        schedule()
      }, 1000)
    }
    draw()
    schedule()
    const interval = window.setInterval(() => {
      shift += 21
      draw()
    }, 30_000)
    return () => {
      window.clearTimeout(raf)
      window.clearInterval(interval)
    }
  }, [props.studentId, props.studentName, props.deviceLabel])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-[9999]"
      style={{ opacity: 1 }}
    />
  )
}

import { describe, expect, it } from 'vitest'
import { classifyWindows, type WindowInspection, type Rect } from './overlay-inspector'

const examBounds: Rect = { left: 0, top: 0, right: 1920, bottom: 1080 }

function win(partial: Partial<WindowInspection>): WindowInspection {
  return {
    pid: 100,
    exeName: 'someapp.exe',
    title: 'Some App',
    exStyle: 0,
    displayAffinity: 0,
    left: 100,
    top: 100,
    right: 400,
    bottom: 300,
    ...partial
  }
}

describe('classifyWindows — Stealth Overlay Detection', () => {
  it('หน้าต่างที่ซ่อนตัวจากการจับภาพ (WDA_EXCLUDEFROMCAPTURE = 0x11) → CRITICAL สูงสุด', () => {
    const events = classifyWindows([win({ displayAffinity: 0x11, title: 'Helper' })], examBounds, 1)
    expect(events).toHaveLength(1)
    expect(events[0]!.code).toBe('CAPTURE_EVADING_WINDOW_DETECTED')
    expect(events[0]!.severity).toBe('critical')
  })

  it('WDA_MONITOR (0x01) ก็ถือเป็นการหลบการจับภาพ', () => {
    const events = classifyWindows([win({ displayAffinity: 0x01 })], examBounds, 1)
    expect(events[0]!.code).toBe('CAPTURE_EVADING_WINDOW_DETECTED')
  })

  it('overlay ลอยทับจอข้อสอบ: topmost + click-through → TOPMOST_OVERLAY_WINDOW_DETECTED', () => {
    const events = classifyWindows(
      [win({ exStyle: 0x8 | 0x20 | 0x80000 })], // TOPMOST | TRANSPARENT | LAYERED
      examBounds,
      1
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.code).toBe('TOPMOST_OVERLAY_WINDOW_DETECTED')
    expect(events[0]!.detail.clickThrough).toBe('true')
  })

  it('topmost แต่อยู่นอกพื้นที่จอข้อสอบ → ไม่ฟ้อง', () => {
    const events = classifyWindows(
      [win({ exStyle: 0x8 | 0x20, left: -800, top: -600, right: -400, bottom: -500 })],
      examBounds,
      1
    )
    expect(events).toHaveLength(0)
  })

  it('topmost ที่คลิกไม่ทะลุและไม่ layered (dialog OS ทั่วไป) → ไม่ฟ้อง', () => {
    const events = classifyWindows([win({ exStyle: 0x8 })], examBounds, 1)
    expect(events).toHaveLength(0)
  })

  it('topmost ธรรมดาที่คลุมพื้นที่สอบชัดเจน → TOPMOST_OVERLAY_WINDOW_DETECTED (น้ำหนักต่ำ)', () => {
    const events = classifyWindows(
      [win({ exStyle: 0x8, left: 0, top: 0, right: 1920, bottom: 1080 })],
      examBounds,
      1
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.code).toBe('LARGE_TOPMOST_WINDOW_DETECTED')
    expect(events[0]!.detail.overlayKind).toBe('topmost')
    expect(events[0]!.score).toBe(15)
  })

  it('หน้าต่าง shell OS ปกติไม่ถูกฟ้อง แต่ถ้าซ่อนจากการจับภาพต้องฟ้อง', () => {
    const normal = classifyWindows(
      [win({ exeName: 'searchhost.exe', exStyle: 0x8 | 0x20 })],
      examBounds,
      1
    )
    expect(normal).toHaveLength(0)

    const hidden = classifyWindows(
      [win({ exeName: 'explorer.exe', displayAffinity: 0x11, exStyle: 0x8 | 0x20 })],
      examBounds,
      1
    )
    expect(hidden).toHaveLength(1)
    expect(hidden[0]!.code).toBe('CAPTURE_EVADING_WINDOW_DETECTED')
  })

  it('หน้าต่างของตัวแอปสอบเอง (ownPid) ถูกข้าม', () => {
    const events = classifyWindows(
      [win({ pid: 777, displayAffinity: 0x11 })],
      examBounds,
      777
    )
    expect(events).toHaveLength(0)
  })
})

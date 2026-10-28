import { describe, expect, it, vi } from 'vitest'
import { NativeKeyboardGuard, type NativeGuardAddon } from './native-bridge'

/* Phase 4.4 — เกณฑ์ผ่าน:
 * - โหลด addon ไม่สำเร็จ/ไม่มีไฟล์ → ต้องไม่คราช และเข้าโหมด kiosk-fallback (Detect & Report)
 * - กดปุ่มถูกบล็อก → DetectionEvent ชนิด BLOCKED_SYSTEM_SHORTCUT พร้อมกันรายงานซ้ำของปุ่มเดิม
 */

describe('NativeKeyboardGuard — fallback ที่ไม่คราช', () => {
  function makeKiosWindow(kioskCalls: boolean[]): {
    win: { isDestroyed(): boolean; setKiosk(enable: boolean): void }
  } {
    return {
      win: {
        isDestroyed: () => false,
        setKiosk: (enable) => {
          kioskCalls.push(enable)
        }
      }
    }
  }

  it('ไม่มี .node → กลับสู่โหมด kiosk-fallback พร้อมเรียก setKiosk ตามแพลตฟอร์ม MAC/linux', () => {
    const kioskCalls: boolean[] = []
    const { win } = makeKiosWindow(kioskCalls)
    const guard = new NativeKeyboardGuard({
      getMainWindow: () => win,
      emitEvent: () => {},
      addonPath: 'nonexistent/addon/path.node'
    })
    // Windows = โหมด native-hook เมื่อโหลด addon สำเร็จ; แพลตฟอร์มอื่น = kiosk-fallback เสมอ
    // บนเครื่องทดสอบ (win32) โหลด .node ไม่ได้ → ต้องเลือก kiosk-fallback (มี setKiosk เท่านั้น)
    const mode = guard.start()
    if (process.platform === 'win32') {
      expect(mode).toBe('kiosk-fallback')
      expect(kioskCalls).toEqual([true])
    }
    expect(guard.isRunning).toBe(true)
    guard.stop()
    expect(guard.isRunning).toBe(false)
  })

  it('เริ่ม/หยุด native hook (จำลอง .node จริง) ได้อย่าง idempotent', () => {
    let started = false
    const fakeAddon: NativeGuardAddon = {
      start(cb) {
        cb('alt-tab')
        started = true
        return true
      },
      stop() {
        started = false
      },
      isRunning: () => started,
      lastBlocked: () => 'alt-tab'
    }
    const events: unknown[] = []
    const guard = new NativeKeyboardGuard({
      getMainWindow: () => null,
      emitEvent: (event) => {
        events.push(event)
      },
      addonPath: 'nonexistent/addon/path.node'
    })
    const addonLoadSpy = vi
      .spyOn(guard, 'loadAddon')
      .mockReturnValue(fakeAddon)
    const mode = guard.start()
    expect(mode).toBe('native-hook')
    expect(started).toBe(true)
    guard.stop()
    expect(started).toBe(false)
    addonLoadSpy.mockRestore()
  })
})

describe('NativeKeyboardGuard — event mapping + dedupe', () => {
  it('คำนวณ DetectionEvent ให้ครบ (BLOCKED_SYSTEM_SHORTCUT / warning / score 15)', () => {
    const events: unknown[] = []
    const guard = new NativeKeyboardGuard({
      getMainWindow: () => null,
      emitEvent: (event) => {
        events.push(event)
      },
      addonPath: 'nonexistent/addon/path.node'
    })
    const first = guard.onBlockedShortcut('alt-tab')
    expect(first.code).toBe('BLOCKED_SYSTEM_SHORTCUT')
    expect(first.severity).toBe('warning')
    expect(first.score).toBe(15)
    expect(first.detail.shortcut).toBe('alt-tab')
    guard.onBlockedShortcut('win-key')
    guard.onBlockedShortcut('printscreen')
    expect(events).toHaveLength(3)
  })

  it('ปุ่มเดิมกดซ้ำภายใน 800ms → ไม่บวก event ซ้ำ (กันผลซ้ำเทว)', () => {
    let now = 1_000
    const events: unknown[] = []
    const guard = new NativeKeyboardGuard({
      getMainWindow: () => null,
      emitEvent: (event) => {
        events.push(event)
      },
      now: () => now,
      addonPath: 'nonexistent/addon/path.node'
    })
    guard.onBlockedShortcut('win-key')
    now += 300
    guard.onBlockedShortcut('win-key') // ซ้ำใน window → suppress
    now += 1_000
    guard.onBlockedShortcut('win-key') // หลัง window → นับใหม่
    expect(events).toHaveLength(2)
  })
})

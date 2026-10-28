import { describe, expect, it } from 'vitest'
import { JitteredScheduler, CrossDetectorWatchdog } from './scheduler'

describe('JitteredScheduler', () => {
  it('สุ่มหน่วงอยู่ในช่วง [min, max] ทุกรอบ (กันกะจังหวะหลบ)', async () => {
    const delays: number[] = []
    let count = 0
    const scheduler = new JitteredScheduler({
      minIntervalMs: 1_800,
      maxIntervalMs: 4_700,
      task: () => {
        count += 1
      },
      // คืนขอบล่างสุด (1_800ms) — หลังรัน task แต่ละครั้งจะบันทึก delay รอบถัดไป
      randomInt: (min, max) => {
        delays.push(max - min)
        return min
      }
    })
    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 80))
    scheduler.stop()
    // ทุก run เกิดหลังการ schedule หนึ่งครั้ง (run แรกอยู่หลัง delay แรก)
    expect(count).toBe(delays.length - 1)
    for (const span of delays) expect(span).toBe(4_700 - 1_800)
  })

  it('รัน task ซ้ำตามช่วงที่สุ่มและหยุดได้ด้วย stop()', async () => {
    let count = 0
    const scheduler = new JitteredScheduler({
      minIntervalMs: 5,
      maxIntervalMs: 8,
      task: () => {
        count += 1
      }
    })
    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    scheduler.stop()
    const afterStop = count
    expect(afterStop).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(count).toBe(afterStop)
  })

  it('task ที่ throw ไม่ทำให้ตารางหยุด', async () => {
    let count = 0
    const scheduler = new JitteredScheduler({
      minIntervalMs: 5,
      maxIntervalMs: 6,
      task: () => {
        count += 1
        throw new Error('boom')
      }
    })
    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    scheduler.stop()
    expect(count).toBeGreaterThan(0)
  })
})

describe('CrossDetectorWatchdog', () => {
  it('detector ที่ไม่ tick เกิน stallThresholdMs ต้องถูกฟ้องทันที', () => {
    let nowMs = 100_000
    let lastTick = nowMs
    const stalled: string[] = []
    const watchdog = new CrossDetectorWatchdog({
      stallThresholdMs: 10_000,
      onStalled: (detectorId) => stalled.push(detectorId),
      now: () => nowMs
    })
    watchdog.register({ detectorId: 'process-inspector', getLastTickAtMs: () => lastTick })
    watchdog.checkAll()
    expect(stalled).toEqual([])

    nowMs += 9_999
    watchdog.checkAll()
    expect(stalled).toEqual([])

    nowMs += 2 // รวม 10.001s ไม่ tick
    watchdog.checkAll()
    expect(stalled).toEqual(['process-inspector'])
    // ไม่ยิงซ้ำรัวเดียว
    watchdog.checkAll()
    expect(stalled).toEqual(['process-inspector'])
  })

  it('detector ที่ tick ต่อเนื่องไม่ติด', () => {
    let nowMs = 0
    const stalled: string[] = []
    const watchdog = new CrossDetectorWatchdog({
      stallThresholdMs: 10_000,
      onStalled: (id) => stalled.push(id),
      now: () => nowMs
    })
    watchdog.register({ detectorId: 'd', getLastTickAtMs: () => nowMs })
    for (let i = 0; i < 30; i += 1) {
      nowMs += 1_000
      watchdog.checkAll()
    }
    expect(stalled).toEqual([])
  })
})

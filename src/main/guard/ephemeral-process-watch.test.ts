import { describe, expect, it } from 'vitest'
import { stepProcessTable, type TrackedProcess } from './ephemeral-process-watch'

describe('stepProcessTable — short-lived process detection', () => {
  it('baseline ไม่รายงานโปรเซสที่รันอยู่ก่อนเริ่มสอบ', () => {
    const { next, shortLived } = stepProcessTable(
      new Map(),
      new Map([[1, 'explorer.exe'], [2, 'code.exe']]),
      1_000,
      2_000,
      true
    )
    expect(shortLived).toHaveLength(0)
    expect([...next.keys()].sort()).toEqual([1, 2])
  })

  it('โปรเซสใหม่ที่หายภายใน maxVisibleMs → รายงาน', () => {
    const baseline = stepProcessTable(
      new Map(),
      new Map([[1, 'explorer.exe']]),
      1_000,
      2_000,
      true
    )
    const appeared = stepProcessTable(
      baseline.next,
      new Map([[1, 'explorer.exe'], [3, 'curl.exe']]),
      1_400,
      2_000,
      false
    )
    expect(appeared.shortLived).toHaveLength(0)
    const vanished = stepProcessTable(
      appeared.next,
      new Map([[1, 'explorer.exe']]),
      1_900,
      2_000,
      false
    )
    expect(vanished.shortLived).toEqual([{ pid: 3, name: 'curl.exe' }])
  })

  it('โปรเซสที่อยู่นานกว่า maxVisibleMs ไม่ถูกรายงานว่าเป็น ephemeral', () => {
    const baseline = stepProcessTable(new Map(), new Map([[1, 'explorer.exe']]), 1_000, 2_000, true)
    const appeared = stepProcessTable(baseline.next, new Map([[1, 'explorer.exe'], [9, 'long.exe']]), 1_500, 2_000, false)
    const vanished = stepProcessTable(appeared.next, new Map([[1, 'explorer.exe']]), 5_000, 2_000, false)
    expect(vanished.shortLived).toHaveLength(0)
  })

  it('โปรเซส baseline ที่หายไปไม่ถูกรายงาน', () => {
    const baseline = stepProcessTable(new Map(), new Map([[1, 'explorer.exe'], [2, 'svc.exe']]), 1_000, 2_000, true)
    const vanished = stepProcessTable(baseline.next, new Map([[1, 'explorer.exe']]), 1_200, 2_000, false)
    expect(vanished.shortLived).toHaveLength(0)
  })

  it('ชื่อว่างกลายเป็น unknown ไม่ทำให้ event หาย', () => {
    const tracked: Map<number, TrackedProcess> = new Map([[7, { name: '', firstSeenAtMs: 1_000, baseline: false }]])
    const result = stepProcessTable(tracked, new Map(), 1_100, 2_000, false)
    expect(result.shortLived).toEqual([{ pid: 7, name: 'unknown' }])
  })
})

import { describe, expect, it } from 'vitest'
import { DisconnectWatch, type DisconnectScheduler, type DisconnectTimer } from './disconnect-watch'

function manualScheduler(): DisconnectScheduler & { advance: (ms: number) => void; now: () => number } {
  let now = 0
  const pending: Array<{ at: number; fn: () => void; id: DisconnectTimer }> = []
  return {
    setTimeout: (fn, ms) => {
      const id = { at: now + ms } as unknown as DisconnectTimer
      pending.push({ at: now + ms, fn, id })
      return id
    },
    clearTimeout: (handle) => {
      const index = pending.findIndex((p) => p.id === handle)
      if (index >= 0) pending.splice(index, 1)
    },
    advance: (ms) => {
      now += ms
      for (const entry of [...pending]) {
        if (entry.at <= now) {
          const index = pending.indexOf(entry)
          if (index >= 0) pending.splice(index, 1)
          entry.fn()
        }
      }
    },
    now: () => now
  }
}

describe('DisconnectWatch', () => {
  it('freezes only after the configured offline window', () => {
    const scheduler = manualScheduler()
    const expired: Array<{ studentId: string; offlineForMs: number }> = []
    const watch = new DisconnectWatch({
      freezeAfterMs: 30_000,
      onExpired: (info) => expired.push(info),
      scheduler,
      now: scheduler.now
    })
    watch.markOffline('std-1')
    scheduler.advance(29_000)
    expect(expired).toHaveLength(0)
    scheduler.advance(1_000)
    expect(expired).toEqual([{ studentId: 'std-1', offlineForMs: 30_000 }])
  })

  it('cancels the freeze when the student reconnects', () => {
    const scheduler = manualScheduler()
    const expired: Array<{ studentId: string; offlineForMs: number }> = []
    const watch = new DisconnectWatch({
      freezeAfterMs: 10_000,
      onExpired: (info) => expired.push(info),
      scheduler,
      now: scheduler.now
    })
    watch.markOffline('std-1')
    scheduler.advance(4_000)
    expect(watch.markOnline('std-1')).toEqual({ offlineForMs: 4_000 })
    scheduler.advance(20_000)
    expect(expired).toHaveLength(0)
  })

  it('does not double-count repeated offline notifications', () => {
    const scheduler = manualScheduler()
    const expired: Array<{ studentId: string; offlineForMs: number }> = []
    const watch = new DisconnectWatch({
      freezeAfterMs: 5_000,
      onExpired: (info) => expired.push(info),
      scheduler,
      now: scheduler.now
    })
    watch.markOffline('std-1')
    scheduler.advance(2_000)
    watch.markOffline('std-1')
    scheduler.advance(3_000)
    expect(expired).toEqual([{ studentId: 'std-1', offlineForMs: 5_000 }])
  })
})

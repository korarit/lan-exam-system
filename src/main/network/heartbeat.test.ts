import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HeartbeatMonitor, nextReconnectDelayMs } from './heartbeat'

describe('HeartbeatMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends a ping at the configured interval', () => {
    const sendPing = vi.fn()
    const monitor = new HeartbeatMonitor({ intervalMs: 3000, sendPing, onTimeout: () => undefined })
    monitor.start()
    vi.advanceTimersByTime(7000)
    expect(sendPing).toHaveBeenCalledTimes(2)
    monitor.stop()
  })

  it('fires onTimeout when no activity arrives within the timeout window', () => {
    const onTimeout = vi.fn()
    const monitor = new HeartbeatMonitor({
      intervalMs: 3000,
      timeoutMs: 8000,
      sendPing: () => undefined,
      onTimeout
    })
    monitor.start()
    vi.advanceTimersByTime(8500)
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('keeps running while activity keeps arriving (recordActivity resets the clock)', () => {
    const onTimeout = vi.fn()
    const monitor = new HeartbeatMonitor({
      intervalMs: 3000,
      timeoutMs: 8000,
      sendPing: () => undefined,
      onTimeout
    })
    monitor.start()
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(2000)
      monitor.recordActivity()
    }
    expect(onTimeout).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('stops firing after stop()', () => {
    const sendPing = vi.fn()
    const monitor = new HeartbeatMonitor({ intervalMs: 3000, sendPing, onTimeout: () => undefined })
    monitor.start()
    vi.advanceTimersByTime(3000)
    monitor.stop()
    vi.advanceTimersByTime(10000)
    expect(sendPing).toHaveBeenCalledTimes(1)
  })

  it('backoff grows 1s → 2s → 4s and caps at 5s', () => {
    expect(nextReconnectDelayMs(1)).toBe(1000)
    expect(nextReconnectDelayMs(2)).toBe(2000)
    expect(nextReconnectDelayMs(3)).toBe(4000)
    expect(nextReconnectDelayMs(4)).toBe(5000)
    expect(nextReconnectDelayMs(10)).toBe(5000)
  })
})

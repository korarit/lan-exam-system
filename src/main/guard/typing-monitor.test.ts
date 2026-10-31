import { describe, expect, it } from 'vitest'
import { TypingIntervalCollector } from './typing-monitor'

describe('TypingIntervalCollector', () => {
  it('collects inter-key intervals and flushes after idle', () => {
    const collector = new TypingIntervalCollector({ idleResetMs: 1_000, minSamples: 2, maxSamples: 5 })
    collector.record(0, true)
    collector.record(100, true)
    collector.record(220, true)
    expect(collector.tick(500)).toBeNull()
    expect(collector.tick(1_400)).toEqual([100, 120])
  })

  it('flushes immediately when maxSamples is reached', () => {
    const collector = new TypingIntervalCollector({ idleResetMs: 1_000, minSamples: 2, maxSamples: 3 })
    collector.record(0, true)
    collector.record(10, true)
    collector.record(20, true)
    expect(collector.record(30, true)).toEqual([10, 10, 10])
  })

  it('drops the sample on a long idle gap and starts over', () => {
    const collector = new TypingIntervalCollector({ idleResetMs: 1_000, minSamples: 1, maxSamples: 5 })
    collector.record(0, true)
    collector.record(1_500, true)
    collector.record(1_600, true)
    expect(collector.tick(2_700)).toEqual([100])
  })

  it('ignores non-printable keys', () => {
    const collector = new TypingIntervalCollector({ idleResetMs: 1_000, minSamples: 1, maxSamples: 5 })
    expect(collector.record(0, false)).toBeNull()
  })
})

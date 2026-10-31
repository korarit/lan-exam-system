import { describe, expect, it } from 'vitest'
import { detectSessionChange, SessionSwitchGuard } from './session-switch-guard'
import type { DetectionEvent } from '@shared/policy-schema'

describe('detectSessionChange', () => {
  it('baseline แรกไม่รายงาน', () => {
    expect(detectSessionChange(null, { activeTty: 'tty1' })).toBeNull()
  })

  it('VT เปลี่ยน = vt-switch', () => {
    expect(detectSessionChange({ activeTty: 'tty1' }, { activeTty: 'tty3' })).toBe('vt-switch')
  })

  it('console user เปลี่ยน = console-user-switch', () => {
    expect(
      detectSessionChange({ consoleUser: 'student' }, { consoleUser: 'other' })
    ).toBe('console-user-switch')
  })

  it('ไม่เปลี่ยน = null', () => {
    expect(detectSessionChange({ activeTty: 'tty1' }, { activeTty: 'tty1' })).toBeNull()
  })
})

describe('SessionSwitchGuard', () => {
  it('รายงาน event เมื่อ snapshot เปลี่ยนหลัง baseline', async () => {
    const events: DetectionEvent[] = []
    let tty = 'tty1'
    const guard = new SessionSwitchGuard({
      emit: (event) => events.push(event),
      platform: 'linux',
      readSnapshot: async () => ({ activeTty: tty }),
      now: () => 1_000
    })
    await guard.checkNow() // baseline
    tty = 'tty2'
    await guard.checkNow()
    expect(events).toHaveLength(1)
    expect(events[0]!.code).toBe('SESSION_SWITCH_DETECTED')
    expect(events[0]!.detail.reason).toBe('vt-switch')
  })
})

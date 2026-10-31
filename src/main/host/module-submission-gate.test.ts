import { describe, expect, it } from 'vitest'
import { evaluateModuleSubmissionGate } from './core-session-manager'

const base = {
  state: 'running' as const,
  frozen: false,
  nowMs: 1_000,
  examEndsAtMs: 10_000,
  gracePeriodMs: 3_000
}

describe('evaluateModuleSubmissionGate (VULN-57)', () => {
  it('running + ไม่ frozen + ยังไม่หมดเวลา → รับ', () => {
    expect(evaluateModuleSubmissionGate(base)).toEqual({ ok: true })
  })

  it('นักเรียนถูก freeze → ปฏิเสธ แม้ใช้ module transport', () => {
    expect(evaluateModuleSubmissionGate({ ...base, frozen: true })).toEqual({
      ok: false,
      reason: 'frozen'
    })
  })

  it('หมดเวลาเกิน grace → time-expired', () => {
    expect(evaluateModuleSubmissionGate({ ...base, nowMs: 13_001 })).toEqual({
      ok: false,
      reason: 'time-expired'
    })
  })

  it('ยังอยู่ใน grace period → รับ (final flush)', () => {
    expect(evaluateModuleSubmissionGate({ ...base, nowMs: 12_000 })).toEqual({ ok: true })
  })

  it('ห้องไม่ running → EXAM_NOT_RUNNING', () => {
    expect(evaluateModuleSubmissionGate({ ...base, state: 'collecting' })).toEqual({
      ok: false,
      reason: 'EXAM_NOT_RUNNING'
    })
  })
})

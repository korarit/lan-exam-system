import { describe, expect, it } from 'vitest'
import { evaluateScreenLiveness } from './proctor-view-service'

describe('evaluateScreenLiveness (VULN-51)', () => {
  it('ยังไม่มีเฟรมและเริ่มเกิน threshold → stale', () => {
    expect(evaluateScreenLiveness(1_000, null, 20_000, 15_000)).toEqual({
      stale: true,
      ageMs: 19_000
    })
  })

  it('มีเฟรมล่าสุดสด → ไม่ stale', () => {
    expect(evaluateScreenLiveness(1_000, 19_000, 20_000, 15_000)).toEqual({
      stale: false,
      ageMs: 1_000
    })
  })

  it('เฟรมเก่าเกิน threshold → stale', () => {
    expect(evaluateScreenLiveness(1_000, 2_000, 20_000, 15_000)).toEqual({
      stale: true,
      ageMs: 18_000
    })
  })

  it('ยังไม่เริ่ม session (reference = 0) → ไม่ stale', () => {
    expect(evaluateScreenLiveness(0, null, 20_000, 15_000).stale).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { AuthorizedChildProcessRegistry } from './authorized-process-registry'

describe('AuthorizedChildProcessRegistry (Phase 9.5)', () => {
  it('pid ที่ลงทะเบียนและยังมีชีวิต → authorized', () => {
    const reg = new AuthorizedChildProcessRegistry()
    reg.register(process.pid, 'test', 60_000)
    expect(reg.isAuthorized(process.pid)).toBe(true)
    expect(reg.size()).toBe(1)
  })

  it('unregister แล้ว → ไม่อนุญาต', () => {
    const reg = new AuthorizedChildProcessRegistry()
    reg.register(process.pid, 'test', 60_000)
    reg.unregister(process.pid)
    expect(reg.isAuthorized(process.pid)).toBe(false)
    expect(reg.size()).toBe(0)
  })

  it('pid ที่ตายแล้ว (ไม่มีจริง) → ไม่อนุญาตและถูก prune', () => {
    const reg = new AuthorizedChildProcessRegistry()
    reg.register(999_999_999, 'ghost', 60_000)
    expect(reg.isAuthorized(999_999_999)).toBe(false)
    expect(reg.size()).toBe(0)
  })

  it('หมดอายุแล้ว → ไม่อนุญาต', () => {
    const reg = new AuthorizedChildProcessRegistry()
    reg.register(process.pid, 'expired', -1)
    expect(reg.isAuthorized(process.pid)).toBe(false)
  })

  it('pid ไม่เคยลงทะเบียน → ไม่อนุญาต', () => {
    const reg = new AuthorizedChildProcessRegistry()
    expect(reg.isAuthorized(process.pid)).toBe(false)
  })

  it('pid ผิดปกติ (0 / ติดลบ) ถูกปฏิเสธตั้งแต่ register', () => {
    const reg = new AuthorizedChildProcessRegistry()
    reg.register(0, 'bad')
    reg.register(-5, 'bad')
    expect(reg.size()).toBe(0)
  })
})

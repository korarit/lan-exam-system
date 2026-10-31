import { describe, expect, it } from 'vitest'
import { powershellExecutable, resolveTrustedExecutable } from './trusted-binary'

describe('trusted-binary', () => {
  it('resolveTrustedExecutable เลือก absolute path แรกที่มีอยู่', () => {
    const exists = (p: string): boolean => p === '/usr/bin/who'
    expect(resolveTrustedExecutable('who', 'linux', exists)).toBe('/usr/bin/who')
  })

  it('resolveTrustedExecutable ไม่คืน relative path จาก PATH', () => {
    const result = resolveTrustedExecutable('ps', 'linux', () => false)
    expect(result).toBe('ps')
  })

  it('powershellExecutable อยู่ใต้ System32 ของ Windows', () => {
    const result = powershellExecutable('win32', { SystemRoot: 'D:\\Windows' })
    expect(result.replace(/\\/g, '/')).toBe('D:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
  })

  it('powershellExecutable บน non-Windows คืนชื่อเดิม (ให้ probe ล้มชัดเจน)', () => {
    expect(powershellExecutable('linux', {})).toBe('powershell.exe')
  })
})

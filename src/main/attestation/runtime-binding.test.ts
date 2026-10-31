import { describe, expect, it } from 'vitest'
import type { RuntimeBinding } from '@shared/attestation-schema'
import { findRuntimeBindingViolation } from './runtime-binding'

function binding(partial: Partial<RuntimeBinding> = {}): RuntimeBinding {
  return {
    executablePath: 'C:\\Program Files\\ZT-Exam\\zt-exam.exe',
    resourcesPath: 'C:\\Program Files\\ZT-Exam\\resources',
    commandLine: '"C:\\Program Files\\ZT-Exam\\zt-exam.exe" --role=student',
    packaged: true,
    defaultApp: false,
    platform: 'win32',
    addonPath: 'C:\\Program Files\\ZT-Exam\\resources\\native\\os_guard.node',
    ...partial
  }
}

describe('runtime binding — wrapper detection (VULN-05/62)', () => {
  it('packaged ปกติ → ผ่าน', () => {
    expect(findRuntimeBindingViolation(binding())).toBeNull()
  })

  it('defaultApp / unpackaged → ปฏิเสธ', () => {
    expect(findRuntimeBindingViolation(binding({ defaultApp: true }))).toBe('runtime-default-app')
    expect(findRuntimeBindingViolation(binding({ packaged: false }))).toBe('runtime-unpackaged')
  })

  it('resources path ผิด / addon นอก resources → ปฏิเสธ', () => {
    expect(
      findRuntimeBindingViolation(binding({ resourcesPath: 'C:\\Program Files\\ZT-Exam\\app' }))
    ).toBe('runtime-resources-path')
    expect(
      findRuntimeBindingViolation(binding({ addonPath: 'C:\\Users\\stu\\os_guard.node' }))
    ).toBe('runtime-addon-outside-resources')
  })

  it('command line มี --app / path .asar นอก resources → ปฏิเสธ', () => {
    expect(
      findRuntimeBindingViolation(
        binding({ commandLine: 'zt-exam.exe --app="C:\\evil\\app.asar"' })
      )
    ).toMatch(/^runtime-(command-line-flag|external-app-path)/)
    expect(
      findRuntimeBindingViolation(
        binding({ executablePath: 'C:\\Program Files\\ZT-Exam\\zt-exam.exe', commandLine: 'zt-exam.exe "C:\\evil\\app.asar"' })
      )
    ).toBe('runtime-external-app-path')
  })

  it('macOS Resources (ตัวพิมพ์ใหญ่) → ผ่าน', () => {
    expect(
      findRuntimeBindingViolation(
        binding({
          platform: 'darwin',
          executablePath: '/Applications/ZT-Exam.app/Contents/MacOS/ZT-Exam',
          resourcesPath: '/Applications/ZT-Exam.app/Contents/Resources',
          addonPath: '/Applications/ZT-Exam.app/Contents/Resources/native/os_guard.node',
          commandLine: '/Applications/ZT-Exam.app/Contents/MacOS/ZT-Exam'
        })
      )
    ).toBeNull()
  })
})

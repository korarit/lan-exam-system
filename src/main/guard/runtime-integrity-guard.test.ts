import { describe, expect, it } from 'vitest'
import {
  analyzeRuntimeSnapshot,
  findDangerousRuntimeFlags,
  isUserWritableModulePath,
  parseCommandLineArgs,
  parseLinuxCommandLine,
  parseMacVmmapPaths,
  RuntimeIntegrityGuard,
  type RuntimeSnapshot
} from './runtime-integrity-guard'
import type { DetectionEvent } from '@shared/policy-schema'

const expectation = {
  packaged: true,
  executableName: 'zt-exam.exe',
  resourcesPath: 'C:\\Program Files\\ZT-Exam\\resources',
  addonPath: 'C:\\Program Files\\ZT-Exam\\resources\\native\\os_guard.node',
  allowedRoots: ['C:\\Program Files\\ZT-Exam']
}

function snapshot(partial: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    platform: 'win32',
    executablePath: 'C:\\Program Files\\ZT-Exam\\zt-exam.exe',
    commandLine: '"C:\\Program Files\\ZT-Exam\\zt-exam.exe" --role=student',
    resourcesPath: 'C:\\Program Files\\ZT-Exam\\resources',
    addonPath: 'C:\\Program Files\\ZT-Exam\\resources\\native\\os_guard.node',
    defaultApp: false,
    packaged: true,
    modules: [
      { path: 'C:\\Program Files\\ZT-Exam\\resources\\native\\os_guard.node', baseAddress: 0x1000, size: 0x2000 },
      { path: 'C:\\Windows\\System32\\kernel32.dll', baseAddress: 0x5000, size: 0x2000 }
    ],
    threads: [{ id: 1, startAddress: 0x1100 }],
    ...partial
  }
}

describe('runtime integrity — wrapper / injection', () => {
  it('wrapper ที่รันแบบ unpackaged → RUNTIME_PATH_TAMPERED', () => {
    const findings = analyzeRuntimeSnapshot(snapshot({ packaged: false }), expectation)
    expect(findings.some((f) => f.code === 'RUNTIME_PATH_TAMPERED' && f.reason === 'unpackaged-runtime')).toBe(true)
  })

  it('defaultApp=true → RUNTIME_PATH_TAMPERED', () => {
    const findings = analyzeRuntimeSnapshot(snapshot({ defaultApp: true }), expectation)
    expect(findings.some((f) => f.reason === 'default-app')).toBe(true)
  })

  it('รันด้วย --app ชี้ .asar นอก resources → ตรวจได้', () => {
    const findings = analyzeRuntimeSnapshot(
      snapshot({ commandLine: '"C:\\Program Files\\ZT-Exam\\zt-exam.exe" --app="C:\\evil\\app.asar"' }),
      expectation
    )
    expect(findings.some((f) => f.reason === 'external-app-path')).toBe(true)
    expect(findDangerousRuntimeFlags('zt-exam.exe --app=C:\\evil\\app.asar')).toContain('--app')
  })

  it('โมดูลจากโฟลเดอร์ผู้ใช้ → FOREIGN_MODULE_INJECTED', () => {
    const findings = analyzeRuntimeSnapshot(
      snapshot({
        modules: [
          ...snapshot().modules,
          { path: 'C:\\Users\\stu\\AppData\\Local\\Temp\\hook.dll', baseAddress: 0x9000, size: 0x1000 }
        ]
      }),
      expectation
    )
    expect(findings.some((f) => f.code === 'FOREIGN_MODULE_INJECTED')).toBe(true)
  })

  it('macOS: โมดูลที่โหลดจาก path ผู้ใช้ → ตรวจได้ (เดิมไม่มี probe)', () => {
    const findings = analyzeRuntimeSnapshot(
      snapshot({
        platform: 'darwin',
        executablePath: '/Applications/ZT-Exam.app/Contents/MacOS/ZT-Exam',
        resourcesPath: '/Applications/ZT-Exam.app/Contents/Resources',
        commandLine: '/Applications/ZT-Exam.app/Contents/MacOS/ZT-Exam',
        modules: [
          { path: '/Applications/ZT-Exam.app/Contents/MacOS/ZT-Exam', baseAddress: 0x1000, size: 0x1000 },
          { path: '/Users/stu/Library/evil.dylib', baseAddress: 0x5000, size: 0x1000 }
        ],
        threads: []
      }),
      { packaged: true, allowedRoots: ['/Applications/ZT-Exam.app'] }
    )
    expect(findings.some((f) => f.code === 'FOREIGN_MODULE_INJECTED')).toBe(true)
  })

  it('เธรดที่เริ่มนอกโมดูล → INJECTED_THREAD_DETECTED', () => {
    const findings = analyzeRuntimeSnapshot(
      snapshot({ threads: [{ id: 7, startAddress: 0xdeadbeef }] }),
      expectation
    )
    expect(findings.some((f) => f.code === 'INJECTED_THREAD_DETECTED')).toBe(true)
  })

  it('snapshot ปกติ → ไม่มี finding', () => {
    expect(analyzeRuntimeSnapshot(snapshot(), expectation)).toEqual([])
  })

  it('parse command line / /proc / vmmap helpers', () => {
    expect(parseCommandLineArgs('"C:\\a b\\x.exe" --role=student')).toEqual(['C:\\a b\\x.exe', '--role=student'])
    expect(parseLinuxCommandLine('/usr/bin/zt-exam\0--role=student\0')).toBe('/usr/bin/zt-exam --role=student')
    expect(
      parseMacVmmapPaths('__TEXT 0000-1000 r-x/r-x SM=COW /Users/stu/Library/evil.dylib')
    ).toEqual(['/Users/stu/Library/evil.dylib'])
    expect(isUserWritableModulePath('C:\\Users\\stu\\hook.dll')).toBe(true)
  })
})

describe('RuntimeIntegrityGuard.scanOnce', () => {
  it('อ่าน snapshot ไม่ได้ติดกัน → GUARD_PROBE_FAILED', async () => {
    const events: DetectionEvent[] = []
    const guard = new RuntimeIntegrityGuard({
      emit: (e) => events.push(e),
      getExpectation: () => expectation,
      readSnapshot: async () => null,
      minScanIntervalMs: 0,
      now: () => 1
    })
    await guard.scanOnce()
    await guard.scanOnce()
    expect(events.some((e) => e.code === 'GUARD_PROBE_FAILED')).toBe(true)
  })

  it('snapshot ที่มี injected thread → ส่ง event ออก', async () => {
    const events: DetectionEvent[] = []
    const guard = new RuntimeIntegrityGuard({
      emit: (e) => events.push(e),
      getExpectation: () => expectation,
      readSnapshot: async () => snapshot({ threads: [{ id: 9, startAddress: 0x900000 }] }),
      now: () => 1
    })
    const produced = await guard.scanOnce()
    expect(produced.some((e) => e.code === 'INJECTED_THREAD_DETECTED')).toBe(true)
    expect(events.some((e) => e.code === 'INJECTED_THREAD_DETECTED')).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { isKnownInjectionTool, ProcessInspector, type ProcessSnapshot } from './process-inspector'
import type { DetectionEvent } from '@shared/policy-schema'
import { buildDefaultPolicy, DetectionPolicyBodySchema } from '@shared/policy-schema'

const policy = DetectionPolicyBodySchema.parse(buildDefaultPolicy('closed'))

function buildInspector(processes: ProcessSnapshot[], events: DetectionEvent[]): ProcessInspector {
  return new ProcessInspector({
    getPolicy: () => policy,
    emit: (event) => events.push(event),
    listProcesses: async () => processes,
    listListeningPorts: async () => [],
    startProcessTrace: () => null,
    now: () => 1
  })
}

describe('injection tool heuristics (VULN-05)', () => {
  it('ชื่อ/คำสั่งของเครื่องมือฉีดโค้ดที่รู้จัก', () => {
    expect(isKnownInjectionTool('frida-server', '')).toBe(true)
    expect(isKnownInjectionTool('x64dbg.exe', '')).toBe(true)
    expect(isKnownInjectionTool('cheatengine-x86_64.exe', '')).toBe(true)
    expect(isKnownInjectionTool('notepad.exe', 'notepad.exe')).toBe(false)
    expect(isKnownInjectionTool('injector.exe', '')).toBe(true)
  })

  it('โปรเซสลูกของแอปสอบที่ไม่อยู่ใน authorized registry → INJECTION_TOOL_DETECTED', async () => {
    const events: DetectionEvent[] = []
    const inspector = buildInspector(
      [
        {
          pid: 4242,
          ppid: process.pid,
          exeName: 'helper.exe',
          exePath: 'C:\\Users\\a\\AppData\\Local\\Temp\\helper.exe',
          commandLine: 'helper.exe',
          memBytes: 0,
          cpuPercent: 0
        }
      ],
      events
    )
    const produced = await inspector.scanOnce()
    expect(produced.some((e) => e.code === 'INJECTION_TOOL_DETECTED')).toBe(true)
  })

  it('โปรเซสที่ชื่อเป็น injection tool → INJECTION_TOOL_DETECTED แม้ path ดูปกติ', async () => {
    const events: DetectionEvent[] = []
    const inspector = buildInspector(
      [
        {
          pid: 5151,
          exeName: 'frida-server.exe',
          exePath: 'C:\\Program Files\\Common Files\\frida-server.exe',
          commandLine: 'frida-server.exe',
          memBytes: 0,
          cpuPercent: 0
        }
      ],
      events
    )
    const produced = await inspector.scanOnce()
    expect(produced.some((e) => e.code === 'INJECTION_TOOL_DETECTED')).toBe(true)
  })

  it('powershell ที่แอป spawn เอง (System32) → ไม่ถูกตีความเป็น injection tool จาก child rule', async () => {
    const events: DetectionEvent[] = []
    const inspector = buildInspector(
      [
        {
          pid: 7171,
          ppid: process.pid,
          exeName: 'powershell.exe',
          exePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          commandLine: 'powershell.exe -NoProfile -Command Get-Process',
          memBytes: 0,
          cpuPercent: 0
        }
      ],
      events
    )
    const produced = await inspector.scanOnce()
    expect(
      produced.some(
        (e) => e.code === 'INJECTION_TOOL_DETECTED' && e.detail.reason === 'untrusted-child-process'
      )
    ).toBe(false)
  })

  it('notepad ปกติ → ไม่มี INJECTION_TOOL_DETECTED', async () => {
    const events: DetectionEvent[] = []
    const inspector = buildInspector(
      [
        {
          pid: 6161,
          exeName: 'notepad.exe',
          exePath: 'C:\\Windows\\System32\\notepad.exe',
          commandLine: 'notepad.exe',
          memBytes: 0,
          cpuPercent: 0
        }
      ],
      events
    )
    const produced = await inspector.scanOnce()
    expect(produced.some((e) => e.code === 'INJECTION_TOOL_DETECTED')).toBe(false)
  })
})

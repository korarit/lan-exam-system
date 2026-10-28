import { describe, expect, it } from 'vitest'
import { isForeignModulePath, SelfIntegrityGuard } from './self-integrity-guard'
import type { DetectionEvent } from '@shared/policy-schema'

describe('isForeignModulePath — Injected DLL / Frida Detection', () => {
  it('frida-agent / cheat engine hook ต้องติด', () => {
    expect(isForeignModulePath('C:\\Temp\\frida-agent-64.dll')).toBe(true)
    expect(isForeignModulePath('C:\\Games\\vehdebug-x86_64.dll')).toBe(true)
    expect(isForeignModulePath('C:\\cheatengine\\speedhack-i386.dll')).toBe(true)
    expect(isForeignModulePath('/tmp/frida-gum.so')).toBe(true)
  })

  it('DLL ที่ถูกโหลดจากโฟลเดอร์ Temp / Downloads ต้องติด', () => {
    const temp = process.env.TEMP ?? 'C:\\Users\\x\\AppData\\Local\\Temp'
    expect(isForeignModulePath(`${temp}\\evil.dll`)).toBe(true)
    expect(isForeignModulePath('C:\\Users\\stu\\Downloads\\hook.dll')).toBe(true)
  })

  it('system DLL ปกติไม่ติด', () => {
    expect(isForeignModulePath('C:\\Windows\\System32\\kernel32.dll')).toBe(false)
    expect(isForeignModulePath('C:\\Program Files\\nodejs\\node.exe')).toBe(false)
  })
})

describe('SelfIntegrityGuard.scanOnce', () => {
  it('ตรวจพบ debugger → DEBUGGER_ATTACHED (critical)', async () => {
    const events: DetectionEvent[] = []
    const guard = new SelfIntegrityGuard({
      emit: (e) => events.push(e),
      checkDebugger: async () => true,
      listForeignModules: async () => [],
      now: () => 5
    })
    const produced = await guard.scanOnce()
    expect(produced.some((e) => e.code === 'DEBUGGER_ATTACHED')).toBe(true)
    expect(produced[0]!.severity).toBe('critical')
  })

  it('พบโมดูลแปลกปลอม → FOREIGN_MODULE_INJECTED พร้อมพาธ', async () => {
    const events: DetectionEvent[] = []
    const guard = new SelfIntegrityGuard({
      emit: (e) => events.push(e),
      checkDebugger: async () => false,
      listForeignModules: async () => ['C:\\Temp\\frida-agent-64.dll'],
      now: () => 5
    })
    const produced = await guard.scanOnce()
    expect(produced).toHaveLength(1)
    expect(produced[0]!.code).toBe('FOREIGN_MODULE_INJECTED')
    expect(produced[0]!.detail.modulePath).toContain('frida-agent')
  })

  it('ปกติ (ไม่มี debugger / ไม่มีโมดูลแปลกปลอม) → ไม่ฟ้อง', async () => {
    const events: DetectionEvent[] = []
    const guard = new SelfIntegrityGuard({
      emit: (e) => events.push(e),
      checkDebugger: async () => false,
      listForeignModules: async () => [],
      now: () => 5
    })
    expect(await guard.scanOnce()).toEqual([])
    expect(events).toEqual([])
  })
})

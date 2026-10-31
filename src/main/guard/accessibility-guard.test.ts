import { describe, expect, it } from 'vitest'
import {
  AccessibilityGuard,
  analyzeAccessibilitySnapshot,
  matchAssistiveProcesses,
  normalizeProcessName
} from './accessibility-guard'
import type { DetectionEvent } from '@shared/policy-schema'

describe('accessibility snapshot analysis (VULN-38)', () => {
  it('พบ NVDA/Narrator → critical ACCESSIBILITY_EXFILTRATION_DETECTED', () => {
    const findings = analyzeAccessibilitySnapshot({
      platform: 'win32',
      processes: ['NVDA.exe', 'chrome.exe'],
      screenReaderFlag: true
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('ACCESSIBILITY_EXFILTRATION_DETECTED')
    expect(findings[0]!.detail.processName).toBe('nvda')
  })

  it('มีแค่ UIA client ฟังอยู่ → warning ACCESSIBILITY_CLIENT_DETECTED', () => {
    const findings = analyzeAccessibilitySnapshot({
      platform: 'win32',
      processes: [],
      uiaClientsListening: true
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('ACCESSIBILITY_CLIENT_DETECTED')
  })

  it('Linux toolkit-accessibility / macOS VoiceOver → critical', () => {
    expect(
      analyzeAccessibilitySnapshot({ platform: 'linux', processes: [], toolkitAccessibility: true })[0]?.code
    ).toBe('ACCESSIBILITY_EXFILTRATION_DETECTED')
    expect(
      analyzeAccessibilitySnapshot({ platform: 'darwin', processes: [], voiceOver: true })[0]?.code
    ).toBe('ACCESSIBILITY_EXFILTRATION_DETECTED')
  })

  it('accessibility tree ถูกเปิดระหว่างสอบ → warning', () => {
    const findings = analyzeAccessibilitySnapshot({ platform: 'win32', processes: [], treeEnabled: true })
    expect(findings[0]?.code).toBe('ACCESSIBILITY_CLIENT_DETECTED')
  })

  it('ปกติ → ไม่มี finding', () => {
    expect(
      analyzeAccessibilitySnapshot({ platform: 'win32', processes: ['explorer.exe'], uiaClientsListening: false })
    ).toEqual([])
  })

  it('normalize/match process name', () => {
    expect(normalizeProcessName('C:\\Program Files\\NVDA\\nvda.exe')).toBe('nvda')
    expect(matchAssistiveProcesses(['/usr/bin/orca', 'bash'])).toEqual(['orca'])
  })
})

describe('AccessibilityGuard.scanOnce', () => {
  it('emit event เมื่อ snapshot มี assistive client', async () => {
    const events: DetectionEvent[] = []
    const guard = new AccessibilityGuard({
      emit: (e) => events.push(e),
      readSnapshot: async () => ({ platform: 'win32', processes: ['narrator.exe'] }),
      now: () => 1
    })
    const produced = await guard.scanOnce()
    expect(produced.some((e) => e.code === 'ACCESSIBILITY_EXFILTRATION_DETECTED')).toBe(true)
    expect(events.some((e) => e.code === 'ACCESSIBILITY_EXFILTRATION_DETECTED')).toBe(true)
  })

  it('probe ล้มติดกัน → GUARD_PROBE_FAILED', async () => {
    const events: DetectionEvent[] = []
    const guard = new AccessibilityGuard({
      emit: (e) => events.push(e),
      readSnapshot: async () => null,
      minScanIntervalMs: 0,
      now: () => 1
    })
    await guard.scanOnce()
    await guard.scanOnce()
    expect(events.some((e) => e.code === 'GUARD_PROBE_FAILED')).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import {
  analyzeRemoteSession,
  analyzeVmFingerprint,
  HardwareVmGuard
} from './hardware-vm-guard'
import type { DetectionEvent } from '@shared/policy-schema'

describe('analyzeVmFingerprint — VM / Hypervisor Fingerprinting', () => {
  it('เครื่องจริง (Dell + Intel GPU) ไม่ติด VM', () => {
    const result = analyzeVmFingerprint({
      manufacturer: 'Dell Inc.',
      model: 'OptiPlex 7080',
      gpuNames: ['Intel(R) UHD Graphics 630'],
      macAddresses: ['a4:bb:6d:11:22:33']
    })
    expect(result.isVm).toBe(false)
    expect(result.signals).toEqual([])
  })

  it('VMware (BIOS + MAC prefix 00:0c:29) → isVm พร้อม signals', () => {
    const result = analyzeVmFingerprint({
      manufacturer: 'VMware, Inc.',
      model: 'VMware Virtual Platform',
      gpuNames: ['VMware SVGA II Adapter'],
      macAddresses: ['00:0c:29:aa:bb:cc']
    })
    expect(result.isVm).toBe(true)
    expect(result.signals.length).toBeGreaterThanOrEqual(2)
  })

  it('VirtualBox ที่ซ่อนชื่อ BIOS แต่ MAC เป็น 08:00:27 ยังติด', () => {
    const result = analyzeVmFingerprint({
      manufacturer: 'innotek GmbH',
      model: 'Desktop PC',
      gpuNames: ['Some GPU'],
      macAddresses: ['08:00:27:12:34:56']
    })
    expect(result.isVm).toBe(true)
    expect(result.signals.join(';')).toContain('08:00:27')
  })
})

describe('analyzeRemoteSession — cross-platform remote detection', () => {
  it('Windows: query session ที่ active เป็น RDP → remote', () => {
    const verdict = analyzeRemoteSession({
      platform: 'win32',
      env: {},
      querySession: ' SESSIONNAME       USERNAME   ID  STATE   TYPE\n>rdp-tcp#3         student     2  Active  rdpwd'
    })
    expect(verdict.remote).toBe(true)
    expect(verdict.source).toBe('rdp')
  })

  it('Windows: console ที่ใช้งานปกติ → ไม่ remote', () => {
    const verdict = analyzeRemoteSession({
      platform: 'win32',
      env: { SESSIONNAME: 'Console' },
      querySession: ' SESSIONNAME       USERNAME   ID  STATE   TYPE\n>console           teacher     1  Active'
    })
    expect(verdict.remote).toBe(false)
  })

  it('Linux: SSH_CONNECTION → remote', () => {
    const verdict = analyzeRemoteSession({
      platform: 'linux',
      env: { SSH_CONNECTION: '10.0.0.5 51234 10.0.0.1 22' }
    })
    expect(verdict.remote).toBe(true)
    expect(verdict.source).toBe('ssh')
  })

  it('Linux: loginctl Remote=yes → remote', () => {
    const verdict = analyzeRemoteSession({
      platform: 'linux',
      env: {},
      loginctl: 'Remote=yes\nType=x11'
    })
    expect(verdict.remote).toBe(true)
    expect(verdict.source).toBe('loginctl')
  })

  it('macOS: who มี host ในวงเล็บ → remote', () => {
    const verdict = analyzeRemoteSession({
      platform: 'darwin',
      env: {},
      who: 'student   ttys000   Oct 31 09:00 (10.0.0.55)'
    })
    expect(verdict.remote).toBe(true)
    expect(verdict.source).toBe('who')
  })

  it('macOS: console ปกติ → ไม่ remote', () => {
    const verdict = analyzeRemoteSession({
      platform: 'darwin',
      env: {},
      who: 'student   console   Oct 31 08:00'
    })
    expect(verdict.remote).toBe(false)
  })
})

describe('HardwareVmGuard — Display Hotplug', () => {
  function makeGuard(events: DetectionEvent[], sessionName = 'Console'): HardwareVmGuard {
    return new HardwareVmGuard({
      getPolicy: () => null,
      emit: (e) => events.push(e),
      getActiveSessionName: async () => sessionName,
      now: () => 1_000
    })
  }

  it('ยังไม่ start → ไม่มี event', () => {
    const events: DetectionEvent[] = []
    const guard = makeGuard(events)
    guard.handleDisplayChanged('added', 2)
    expect(events).toHaveLength(0)
  })

  it('จอ baseline แรกไม่ถูกนับเป็น hotplug', () => {
    const events: DetectionEvent[] = []
    const guard = makeGuard(events)
    guard.start()
    guard.handleDisplayChanged('metrics-changed', 1)
    expect(events).toHaveLength(0)
  })

  it('เสียบจอเพิ่มระหว่างสอบ → DISPLAY_CONFIG_CHANGED', () => {
    const events: DetectionEvent[] = []
    const guard = makeGuard(events)
    guard.start()
    guard.handleDisplayChanged('metrics-changed', 1) // baseline
    guard.handleDisplayChanged('added', 2)
    expect(events).toHaveLength(1)
    expect(events[0]!.code).toBe('DISPLAY_CONFIG_CHANGED')
    expect(events[0]!.detail.change).toBe('added')
  })

  it('remote session (RDP) ตรวจได้ทุกกรณี → REMOTE_SESSION_SUSPECTED', async () => {
    const events: DetectionEvent[] = []
    const guard = makeGuard(events, 'RDP-Tcp#0')
    guard.start()
    const produced = await guard.scanOnce()
    expect(produced.some((e) => e.code === 'REMOTE_SESSION_SUSPECTED')).toBe(true)
  })
})

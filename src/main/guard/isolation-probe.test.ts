import { describe, expect, it } from 'vitest'
import { analyzeIsolation, countPidNamespaceLayers } from './isolation-probe'

describe('isolation-probe', () => {
  it('NSpid หลายชั้น = nested PID namespace', () => {
    const status = 'Name:\tnode\nNSpid:\t1234\t1\n'
    expect(countPidNamespaceLayers(status)).toBe(2)
  })

  it('NSpid ชั้นเดียว = host namespace', () => {
    expect(countPidNamespaceLayers('Name:\tnode\nNSpid:\t1234\n')).toBe(1)
  })

  it('ตรวจ WSL env', () => {
    const result = analyzeIsolation({ platform: 'win32', env: { WSL_DISTRO_NAME: 'Ubuntu' } })
    expect(result.isolated).toBe(true)
    expect(result.signals).toContain('wsl-env')
  })

  it('ตรวจ container marker + cgroup', () => {
    const result = analyzeIsolation({
      platform: 'linux',
      env: {},
      dockerEnv: true,
      cgroup: '0::/docker/abc123'
    })
    expect(result.signals).toContain('container:docker-marker')
    expect(result.signals).toContain('container:cgroup')
  })

  it('ตรวจ utility VM จาก process list', () => {
    const result = analyzeIsolation({
      platform: 'win32',
      env: {},
      processNames: ['explorer.exe', 'vmmemWSL']
    })
    expect(result.signals.some((s) => s.startsWith('utility-vm:'))).toBe(true)
  })

  it('สภาพแวดล้อมปกติไม่ฟ้อง', () => {
    const result = analyzeIsolation({
      platform: 'linux',
      env: {},
      procStatus: 'Name:\tnode\nNSpid:\t42\n',
      cgroup: '0::/user.slice/session-1.scope',
      processNames: ['node', 'electron']
    })
    expect(result.isolated).toBe(false)
  })
})

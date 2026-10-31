import { describe, expect, it } from 'vitest'
import {
  disableGatewayForwarding,
  parseForwardingFlag,
  parseForwardingTokens,
  parseSysctlForwarding,
  parseWindowsPostureOutput,
  readGatewayPosture,
  type PostureExec
} from './gateway-posture'

const LINUX_V4 = '/proc/sys/net/ipv4/ip_forward'
const LINUX_V6 = '/proc/sys/net/ipv6/conf/all/forwarding'

describe('posture parsers', () => {
  it('parses forwarding tokens and flags', () => {
    expect(parseForwardingTokens('Enabled,Disabled')).toBe(true)
    expect(parseForwardingTokens('Disabled')).toBe(false)
    expect(parseForwardingTokens('')).toBeNull()
    expect(parseForwardingFlag('1')).toBe(true)
    expect(parseForwardingFlag('0')).toBe(false)
    expect(parseForwardingFlag('2')).toBeNull()
    expect(parseSysctlForwarding('net.inet.ip.forwarding: 1\n')).toBe(true)
    expect(parseSysctlForwarding('0')).toBe(false)
  })

  it('parses Windows JSON with interface + registry + ICS', () => {
    const parsed = parseWindowsPostureOutput(
      JSON.stringify({ v4: 'Disabled', v6: 'Enabled', ics: 'Running', router: '1' })
    )
    expect(parsed.ipv4Forwarding).toBe(true) // registry IPEnableRouter=1
    expect(parsed.ipv6Forwarding).toBe(true)
    expect(parsed.icsEnabled).toBe(true)
  })

  it('reports null when Windows output is unusable', () => {
    const parsed = parseWindowsPostureOutput('not-json')
    expect(parsed).toEqual({ ipv4Forwarding: null, ipv6Forwarding: null, icsEnabled: null })
  })
})

describe('gateway posture (simulated, no privileged commands)', () => {
  it('reads Linux procfs posture and warns while forwarding is on', async () => {
    const files = new Map<string, string>([
      [LINUX_V4, '1\n'],
      [LINUX_V6, '1\n']
    ])
    const posture = await readGatewayPosture({
      platform: 'linux',
      readFile: async (path) => {
        const value = files.get(path)
        if (value === undefined) throw new Error('ENOENT')
        return value
      }
    })
    expect(posture.ipv4Forwarding).toBe(true)
    expect(posture.ipv6Forwarding).toBe(true)
    expect(posture.canDisable).toBe(false)
    expect(posture.warnings.some((warning) => warning.includes('IPv6'))).toBe(true)
  })

  it('disables Linux forwarding when write succeeds', async () => {
    const files = new Map<string, string>([
      [LINUX_V4, '1\n'],
      [LINUX_V6, '1\n']
    ])
    const posture = await disableGatewayForwarding({
      platform: 'linux',
      readFile: async (path) => files.get(path) ?? Promise.reject(new Error('ENOENT')),
      writeFile: async (path, data) => {
        files.set(path, data)
      }
    })
    expect(posture.ipv4Forwarding).toBe(false)
    expect(posture.ipv6Forwarding).toBe(false)
    expect(posture.canDisable).toBe(true)
    expect(posture.changed).toContain(`write ${LINUX_V4}=0`)
    expect(posture.changed).toContain(`write ${LINUX_V6}=0`)
  })

  it('reports permission failure instead of claiming enforcement', async () => {
    const files = new Map<string, string>([
      [LINUX_V4, '1\n'],
      [LINUX_V6, '0\n']
    ])
    const posture = await disableGatewayForwarding({
      platform: 'linux',
      readFile: async (path) => files.get(path) ?? Promise.reject(new Error('ENOENT')),
      writeFile: async () => {
        throw new Error('EACCES')
      }
    })
    expect(posture.ipv4Forwarding).toBe(true)
    expect(posture.canDisable).toBe(false)
    expect(posture.warnings.some((warning) => warning.includes('ไม่สำเร็จ'))).toBe(true)
  })

  it('reads macOS sysctl output', async () => {
    const exec: PostureExec = async (_file, args) => {
      const key = args[args.length - 1]
      return { ok: true, stdout: key === 'net.inet.ip.forwarding' ? '1\n' : '0\n' }
    }
    const posture = await readGatewayPosture({ platform: 'darwin', exec })
    expect(posture.ipv4Forwarding).toBe(true)
    expect(posture.ipv6Forwarding).toBe(false)
    expect(posture.canDisable).toBe(false)
  })

  it('uses Windows read + disable scripts and re-reads the result', async () => {
    let readCount = 0
    const exec: PostureExec = async (_file, args) => {
      const script = args[args.length - 1] ?? ''
      if (script.includes('Set-NetIPInterface')) {
        return {
          ok: true,
          stdout: JSON.stringify({
            changes: ['Set-NetIPInterface IPv4 Forwarding=Disabled'],
            errors: []
          })
        }
      }
      readCount += 1
      const first = readCount === 1
      return {
        ok: true,
        stdout: JSON.stringify({
          v4: first ? 'Enabled' : 'Disabled',
          v6: first ? 'Enabled' : 'Disabled',
          ics: 'Stopped',
          router: '0'
        })
      }
    }
    const posture = await disableGatewayForwarding({ platform: 'win32', exec })
    expect(posture.ipv4Forwarding).toBe(false)
    expect(posture.ipv6Forwarding).toBe(false)
    expect(posture.canDisable).toBe(true)
    expect(posture.changed).toContain('Set-NetIPInterface IPv4 Forwarding=Disabled')
  })

  it('surfaces ICS as a critical gap on Windows', async () => {
    const exec: PostureExec = async () => ({
      ok: true,
      stdout: JSON.stringify({ v4: 'Disabled', v6: 'Disabled', ics: 'Running', router: '0' })
    })
    const posture = await readGatewayPosture({ platform: 'win32', exec })
    expect(posture.icsEnabled).toBe(true)
    expect(posture.canDisable).toBe(false)
    expect(posture.warnings.some((warning) => warning.includes('SharedAccess'))).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { applyRuntimeArgPolicy, parseRuntimeArgs } from './runtime-args'

describe('parseRuntimeArgs', () => {
  it('returns defaults when no flags are present', () => {
    const args = parseRuntimeArgs(['electron.exe', '.'])
    expect(args).toEqual({ profileId: 'default', role: 'unselected', windowedKiosk: false })
  })

  it('parses profile, role, and windowed-kiosk flags', () => {
    const args = parseRuntimeArgs([
      'electron',
      '.',
      '--profile=student-2',
      '--role=student',
      '--windowed-kiosk'
    ])
    expect(args.profileId).toBe('student-2')
    expect(args.role).toBe('student')
    expect(args.windowedKiosk).toBe(true)
  })

  it('ignores unknown or malformed flags instead of crashing', () => {
    const args = parseRuntimeArgs(['electron', '--remote-debugging-port=9222', '--role=??', '--profile='])
    expect(args.role).toBe('unselected')
    expect(args.profileId).toBe('default')
  })

  it('rejects profile ids with unsafe characters', () => {
    const args = parseRuntimeArgs(['--profile=../../etc'])
    expect(args.profileId).toBe('default')
  })
})

describe('applyRuntimeArgPolicy', () => {
  const requested = (): ReturnType<typeof parseRuntimeArgs> =>
    parseRuntimeArgs(['--profile=student-2', '--role=student', '--windowed-kiosk'])

  it('leaves flags untouched outside release builds', () => {
    const args = applyRuntimeArgPolicy(requested(), { production: false })
    expect(args).toEqual({ profileId: 'student-2', role: 'student', windowedKiosk: true })
  })

  it('clears windowed kiosk in release builds unless explicitly allowed', () => {
    const args = applyRuntimeArgPolicy(requested(), { production: true })
    expect(args.windowedKiosk).toBe(false)
    expect(args.profileId).toBe('student-2')

    const allowed = applyRuntimeArgPolicy(requested(), {
      production: true,
      allowWindowedKiosk: true
    })
    expect(allowed.windowedKiosk).toBe(true)
  })

  it('falls back to the default profile when an allowlist is configured', () => {
    const blocked = applyRuntimeArgPolicy(requested(), {
      production: true,
      allowedProfiles: ['seat-01', 'seat-02']
    })
    expect(blocked.profileId).toBe('default')

    const permitted = applyRuntimeArgPolicy(requested(), {
      production: true,
      allowedProfiles: ['student-2']
    })
    expect(permitted.profileId).toBe('student-2')
  })

  it('treats an explicitly empty allowlist as deny-all overrides', () => {
    const args = applyRuntimeArgPolicy(requested(), { production: true, allowedProfiles: [] })
    expect(args.profileId).toBe('default')
  })
})

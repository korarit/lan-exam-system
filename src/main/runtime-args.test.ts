import { describe, it, expect } from 'vitest'
import { parseRuntimeArgs } from './runtime-args'

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

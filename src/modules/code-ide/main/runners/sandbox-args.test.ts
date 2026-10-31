import { describe, expect, it } from 'vitest'
import { sandboxArgsFor } from './cli-runner'

describe('sandboxArgsFor — cross-platform runtime hardening', () => {
  it('Node ใช้ permission model จำกัด read/write ที่ runDir + offline libs', () => {
    const args = sandboxArgsFor('javascript', '/tmp/run', ['/deps/node_modules'])
    expect(args).toContain('--permission')
    expect(args).toContain('--allow-fs-read=/tmp/run')
    expect(args).toContain('--allow-fs-read=/deps/node_modules')
    expect(args).toContain('--allow-fs-write=/tmp/run')
  })

  it('Python ไม่โหลด user site-packages และไม่เขียน .pyc', () => {
    const args = sandboxArgsFor('python', '/tmp/run')
    expect(args).toContain('-B')
    expect(args).toContain('-s')
  })

  it('PHP ใช้ open_basedir + disable_functions', () => {
    const args = sandboxArgsFor('php', '/tmp/run')
    expect(args.join(' ')).toContain('open_basedir=')
    expect(args.join(' ')).toContain('disable_functions=')
  })

  it('ภาษาไบนารีไม่มี flag เฉพาะ (คอมไพล์แยก)', () => {
    expect(sandboxArgsFor('c', '/tmp/run')).toEqual([])
  })
})

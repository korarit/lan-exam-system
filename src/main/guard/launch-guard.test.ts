import { describe, expect, it } from 'vitest'
import {
  describeFindings,
  inspectLaunch,
  isAllowedInDev
} from './launch-guard'

/* Phase 4.3 — ค่าผ่าน (Definition of Done #3):
 * ทดสอบส่ง `--remote-debugging-port=9222` → ต้องคืนสถานะถูกบล็อกพร้อมระบุชื่อ flag
 */

const emptyBrackets = (): boolean => false

describe('launch guard CLI switches', () => {
  it('จับ --remote-debugging-port พร้อมค่า', () => {
    const findings = inspectLaunch({
      argv: ['ZT-Exam.exe', '--remote-debugging-port=9222'],
      execArgv: [],
      env: {},
      hasChromiumSwitch: emptyBrackets
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'cli-switch', name: '--remote-debugging-port', value: '9222' })
    expect(describeFindings(findings)).toContain('flag --remote-debugging-port=9222')
  })

  it('จับแบบไม่มีค่า (--inspect-brk) และจาก execArgv', () => {
    const findings = inspectLaunch({
      argv: ['app.exe', '--inspect-brk'],
      execArgv: ['--inspect-port=9330'],
      env: {},
      hasChromiumSwitch: emptyBrackets
    })
    const names = findings.map((f) => `${f.kind}:${f.name}`)
    expect(names).toEqual(['cli-switch:--inspect-brk', 'exec-arg:--inspect-port'])
  })

  it('VULN-44: จับ --no-sandbox / --js-flags / --disable-features ที่เคยหลุด denylist', () => {
    const findings = inspectLaunch({
      argv: [
        'ZT-Exam.exe',
        '--no-sandbox',
        '--js-flags=--allow-natives-syntax',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      execArgv: [],
      env: {},
      hasChromiumSwitch: emptyBrackets
    })
    expect(findings.map((f) => f.name)).toEqual([
      '--no-sandbox',
      '--js-flags',
      '--disable-features'
    ])
  })

  it('จับเพิ่มจาก app.commandLine.hasSwitch', () => {
    const findings = inspectLaunch({
      argv: [],
      execArgv: [],
      env: {},
      hasChromiumSwitch: (name) => name === '--remote-allow-origins'
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.name).toBe('--remote-allow-origins')
  })
})

describe('launch guard environment variables', () => {
  it('จับ ELECTRON_RUN_AS_NODE / NODE_OPTIONS / LD_PRELOAD', () => {
    const findings = inspectLaunch({
      argv: [],
      execArgv: [],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--require pwned.js',
        LD_PRELOAD: '/tmp/shim.so'
      },
      hasChromiumSwitch: emptyBrackets
    })
    expect(findings.map((f) => f.name)).toEqual([
      'ELECTRON_RUN_AS_NODE',
      'NODE_OPTIONS',
      'LD_PRELOAD'
    ])
    expect(findings.every((f) => f.kind === 'env')).toBe(true)
  })

  it('ไม่ว่าง่า (แบบ clean) → ไม่มีพบ', () => {
    const findings = inspectLaunch({
      argv: ['ZT-Exam.exe', '--profile=host', '--role=student'],
      execArgv: [],
      env: { PATH: 'C:\\Windows' },
      hasChromiumSwitch: emptyBrackets
    })
    expect(findings).toHaveLength(0)
  })

  it('ค่าว่างของ env ไม่ถือเป็นการตรวจพบ', () => {
    const findings = inspectLaunch({
      argv: [],
      execArgv: [],
      env: { ELECTRON_RUN_AS_NODE: '' },
      hasChromiumSwitch: emptyBrackets
    })
    expect(findings).toHaveLength(0)
  })
})

describe('dev-mode allowances', () => {
  it('ELECTRON_RENDERER_URL ยอมรับได้เฉพาะโหมด dev', () => {
    const finding = inspectLaunch({
      argv: [],
      execArgv: [],
      env: { ELECTRON_RENDERER_URL: 'http://localhost:5173' },
      hasChromiumSwitch: emptyBrackets
    })[0]
    expect(finding).toBeTruthy()
    expect(isAllowedInDev(finding!)).toBe(true)
    expect(isAllowedInDev({ kind: 'env', name: 'ELECTRON_RUN_AS_NODE', value: '1' })).toBe(false)
  })

  it('ปกติ: production พบ ELECTRON_RUN_AS_NODE → ถูกปิดทันทีที่ index.ts (ตามที่ build ครูเรียก)', () => {
    // ทดสอบการจัดรูปข้อความที่จะแสดงตอนปฏิเสธการรัน
    const findings = inspectLaunch({
      argv: ['app.exe', '--disable-web-security'],
      execArgv: [],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      hasChromiumSwitch: emptyBrackets
    })
    const summary = describeFindings(findings)
    expect(summary).toContain('ELECTRON_RUN_AS_NODE')
    expect(summary).toContain('--disable-web-security')
  })
})

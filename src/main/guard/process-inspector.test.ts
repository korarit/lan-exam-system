import { describe, expect, it } from 'vitest'
import { matchProcessRules, makeDetectionEvent, ProcessInspector, type ProcessSnapshot } from './process-inspector'
import type { BinaryMetadata } from './binary-metadata'
import type { DetectionPolicyBody, DetectionEvent } from '@shared/policy-schema'
import { buildDefaultPolicy, DetectionPolicyBodySchema } from '@shared/policy-schema'

const policy = DetectionPolicyBodySchema.parse(buildDefaultPolicy('closed'))

function metadata(partial: Partial<BinaryMetadata>): BinaryMetadata {
  return { filePath: 'C:\\x\\y.exe', ...partial }
}

describe('matchProcessRules — Renamed Binary Detection', () => {
  const cheatRule = policy.rules.find((r) => r.ruleId === 'memory-debuggers')!

  it('จับไฟล์ที่เปลี่ยนชื่อหนี (OriginalFilename = "Cheat Engine.exe" แต่ไฟล์ชื่อ wordpad.exe) → disguised', () => {
    const matches = matchProcessRules(
      { exeName: 'wordpad.exe', commandLine: '"C:\\Tools\\wordpad.exe"' },
      metadata({ originalFilename: 'Cheat Engine.exe', productName: 'Cheat Engine' }),
      [cheatRule]
    )
    expect(matches).toHaveLength(1)
    expect(matches[0]!.disguised).toBe(true)
  })

  it('จับจากชื่อไฟล์ตรง ๆ → ไม่ถือเป็น disguised', () => {
    const matches = matchProcessRules(
      { exeName: 'cheatengine-x86_64.exe', commandLine: '' },
      null,
      [cheatRule]
    )
    expect(matches).toHaveLength(1)
    expect(matches[0]!.disguised).toBe(false)
  })

  it('จับจาก ProductName (เช่น ollama เปลี่ยนชื่อเป็น wordpad.exe)', () => {
    const aiRule = policy.rules.find((r) => r.ruleId === 'local-ai-runtime')!
    const matches = matchProcessRules(
      { exeName: 'wordpad.exe', commandLine: 'ollama serve' },
      metadata({ productName: 'Ollama' }),
      [aiRule]
    )
    expect(matches).toHaveLength(1)
    expect(matches[0]!.disguised).toBe(true)
  })

  it('โปรเซสปกติ (notepad) ไม่ตรงกฎใด', () => {
    const matches = matchProcessRules(
      { exeName: 'notepad.exe', commandLine: 'notepad.exe' },
      metadata({ originalFilename: 'Notepad.exe', productName: 'Microsoft® Windows®' }),
      policy.rules
    )
    expect(matches).toHaveLength(0)
  })

  it('จับจาก command line substring (llama-server)', () => {
    const matches = matchProcessRules(
      { exeName: 'python.exe', commandLine: 'python -m llama-server --port 8080' },
      null,
      policy.rules
    )
    expect(matches.some((m) => m.rule.ruleId === 'local-ai-runtime')).toBe(true)
  })
})

describe('makeDetectionEvent — คะแนนตามแคตตาล็อก', () => {
  it('DISGUISED_PROCESS_DETECTED ต้องแรงกว่า BLACKLISTED (คูณสองของ rule)', () => {
    const base = makeDetectionEvent('BLACKLISTED_PROCESS_DETECTED', 't', {}, 45)
    expect(base.score).toBe(45)
    const disguised = makeDetectionEvent('DISGUISED_PROCESS_DETECTED', 't', {}, 90)
    expect(disguised.score).toBe(90)
    expect(disguised.severity).toBe('critical')
  })
})

describe('ProcessInspector.scanOnce — ephemeral & sweep', () => {
  function makeInspector(
    processes: ProcessSnapshot[],
    getPolicy: () => DetectionPolicyBody | null
  ): { inspector: ProcessInspector; events: DetectionEvent[] } {
    const events: DetectionEvent[] = []
    const inspector = new ProcessInspector({
      getPolicy,
      emit: (e) => events.push(e),
      listProcesses: async () => processes,
      listListeningPorts: async () => [],
      startProcessTrace: () => () => {},
      now: () => 1_000_000 // เวลาคงที่ = cooldown ผ่านหมดทุกครั้ง
    })
    return { inspector, events }
  }

  it('โปรเซสต้องห้ามที่ยังรันอยู่ → BLACKLISTED_PROCESS_DETECTED', async () => {
    const { inspector, events } = makeInspector(
      [{ pid: 4242, exeName: 'ollama.exe', exePath: '', commandLine: 'ollama serve', memBytes: 0, cpuPercent: 0 }],
      () => policy
    )
    const produced = await inspector.scanOnce()
    expect(produced.some((e) => e.code === 'BLACKLISTED_PROCESS_DETECTED')).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  })

  it('โปรเซสที่ตรงกฎผ่าน ephemeral trace (เปิด-ปิดเร็ว) ต้องถูกแจ้ง', async () => {
    const events: DetectionEvent[] = []
    let traceCallback: ((p: { pid: number; name: string; ppid: number }) => void) | null = null
    const inspector = new ProcessInspector({
      getPolicy: () => policy,
      emit: (e) => events.push(e),
      listProcesses: async () => [],
      listListeningPorts: async () => [],
      startProcessTrace: (cb) => {
        traceCallback = cb
        return () => {}
      },
      now: () => 1_000_000
    })
    inspector.start()
    traceCallback!({ pid: 555, name: 'cheatengine-x86_64.exe', ppid: 100 })
    expect(events).toHaveLength(1)
    expect(events[0]!.code).toBe('BLACKLISTED_PROCESS_DETECTED')
    expect(events[0]!.detail.ephemeral).toBe('true')
    inspector.stop()
  })

  it('compute spike (RAM > 1.5GB + CPU สูง) ใน Mode closed → SUSPICIOUS_COMPUTE_SPIKE', async () => {
    const { inspector, events } = makeInspector(
      [
        {
          pid: 999,
          exeName: 'ollama.exe',
          exePath: '',
          commandLine: 'ollama serve',
          memBytes: 2 * 1024 * 1024 * 1024,
          cpuPercent: 90
        }
      ],
      () => policy
    )
    const produced = await inspector.scanOnce()
    expect(produced.some((e) => e.code === 'SUSPICIOUS_COMPUTE_SPIKE')).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  })

  it('ไม่มีนโยบาย (ยังไม่ได้รับ POLICY_UPDATE) ต้องไม่สแกน', async () => {
    const { inspector, events } = makeInspector(
      [{ pid: 1, exeName: 'ollama.exe', exePath: '', commandLine: '', memBytes: 0, cpuPercent: 0 }],
      () => null
    )
    const produced = await inspector.scanOnce()
    expect(produced).toEqual([])
    expect(events).toEqual([])
  })

  it('Phase 9.5: pid ลูกของ code-ide sandbox ถูกข้ามทั้งหมด (กัน false positive ใส่โค้ดนักเรียน)', async () => {
    const events: DetectionEvent[] = []
    const inspector = new ProcessInspector({
      getPolicy: () => policy,
      isAuthorizedPid: (pid) => pid === 4242,
      emit: (e) => events.push(e),
      listProcesses: async () => [
        // ตัวเดียวกับเคสแรก แต่เป็นลูก sandbox → ต้องเงียบ
        { pid: 4242, exeName: 'ollama.exe', exePath: '', commandLine: 'ollama serve', memBytes: 2 * 1024 * 1024 * 1024, cpuPercent: 90 }
      ],
      listListeningPorts: async () => [],
      startProcessTrace: () => () => {},
      now: () => 1_000_000
    })
    const produced = await inspector.scanOnce()
    expect(produced).toEqual([])
    expect(events).toEqual([])
  })
})

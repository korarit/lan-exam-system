import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NetworkInspector, diffDnsCache } from '@main/guard/network-inspector'
import { ProcessInspector } from '@main/guard/process-inspector'
import type { DetectionEvent, DetectionPolicyBody } from '@shared/policy-schema'
import { buildDefaultPolicy, DetectionPolicyBodySchema } from '@shared/policy-schema'
import { authorizedChildProcesses } from './authorized-process-registry'
import {
  allocateEphemeralPort,
  killProcessTree,
  spawnServer,
  waitForPort
} from './runners/backend-api-runner'
import { buildSandboxEnv } from './anti-delete-guard'
import { stripCodePackageForStudent, assertStudentViewClean } from '../shared/student-view'
import { StudentCodePackageViewSchema, type CodeExamPackage, type VirtualEntry } from '../shared/code-schema'

/* ============================================================
 * Phase 11.3 — Security & Anti-Cheat Integration
 * - รันโปรเจกต์หลายไฟล์ / backend loopback ของนักเรียน = เงียบ
 *   (zero false-positive ผ่าน AuthorizedChildProcessRegistry)
 * - โค้ดนักเรียนแอบยิงออกเน็ต/AI API = STUDENT_CODE_UNAUTHORIZED_
 *   NETWORK_CALL (CRITICAL) + DNS diff จับโดเมน AI
 * - ข้อมูลลับ (hidden tests/setupSqlOverride/hidden files/
 *   reference solution/db password) รั่วไปเครื่องนักเรียน = 0 ไบต์
 * ============================================================ */

const policy: DetectionPolicyBody = DetectionPolicyBodySchema.parse(buildDefaultPolicy('closed'))

function f(filePath: string, content: string): VirtualEntry {
  return { path: filePath, kind: 'file', content, encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
}

function makeSandboxNetInspector(
  sockets: Array<{ pid: number; processName: string; peerAddress: string; peerPort: number; state: string }>,
  authorizedPids: number[]
): { inspector: NetworkInspector; events: DetectionEvent[] } {
  const events: DetectionEvent[] = []
  const inspector = new NetworkInspector({
    getPolicy: () => ({ ...policy, examMode: 'closed' as const }),
    getHostIp: () => null,
    getLocalProxyPort: () => 0,
    isAuthorizedPid: (pid) => authorizedPids.includes(pid),
    emit: (e) => events.push(e),
    listDnsCache: async () => [],
    listSockets: async () =>
      sockets.map((s) => ({
        ...s,
        protocol: 'TCP',
        localAddress: '192.168.1.10',
        localPort: 51_000
      })),
    now: () => 1_000_000
  })
  inspector.start()
  return { inspector, events }
}

describe('Phase 11.3.1 — Legitimate execution: zero false-positive', () => {
  it('เซิร์ฟเวอร์ backend ของนักเรียนบน loopback (+พอร์ตจริง) = เงียบ', async () => {
    const port = await allocateEphemeralPort('127.0.0.1')
    const { inspector } = makeSandboxNetInspector(
      [
        { pid: 901, processName: 'node.exe', peerAddress: '127.0.0.1', peerPort: port, state: 'ESTABLISHED' },
        { pid: 902, processName: 'python.exe', peerAddress: '127.0.0.1', peerPort: port, state: 'ESTABLISHED' }
      ],
      [901, 902]
    )
    expect(await inspector.scanOnce()).toHaveLength(0)
  })

  it('วงจร pid จริง: spawn backend จริง -> authorized -> kill -> หลุด registry', async () => {
    const port = await allocateEphemeralPort('127.0.0.1')
    const serverFile = path.join(os.tmpdir(), `ztcode-sec-${Date.now()}.js`)
    fs.writeFileSync(
      serverFile,
      "require('http').createServer((q, s) => { s.writeHead(200, {'content-type':'application/json'}); s.end('{\"ok\":true}'); }).listen(Number(process.env.PORT), '127.0.0.1');\n",
      'utf8'
    )
    const child = spawnServer('node', [serverFile], { cwd: os.tmpdir(), env: buildSandboxEnv(os.tmpdir()), port })
    try {
      expect(await waitForPort('127.0.0.1', port, 8000)).toBe(true)
      const pid = child.pid as number
      // ระหว่างรัน guard ต้องข้าม (ไม่ฟ้องโปรเซสลูกของ sandbox เอง)
      expect(authorizedChildProcesses.isAuthorized(pid)).toBe(true)
      const res = await fetch(`http://127.0.0.1:${port}/`)
      expect(res.status).toBe(200)
    } finally {
      killProcessTree(child)
      fs.rmSync(serverFile, { force: true })
    }
    await new Promise((r) => setTimeout(r, 800))
    expect(authorizedChildProcesses.isAuthorized(child.pid as number)).toBe(false)
  }, 30_000)

  it('ProcessInspector ข้ามโปรเซสลูก sandbox ที่ใช้ CPU หนัก (กันฟ้องโค้ดนักเรียน)', async () => {
    const events: DetectionEvent[] = []
    const inspector = new ProcessInspector({
      getPolicy: () => policy,
      isAuthorizedPid: (pid) => pid === 4242,
      emit: (e) => events.push(e),
      listProcesses: async () => [
        { pid: 4242, exeName: 'python.exe', exePath: '', commandLine: 'python src/main.py', memBytes: 200 * 1024 * 1024, cpuPercent: 95 }
      ],
      listListeningPorts: async () => [],
      startProcessTrace: () => () => {},
      now: () => 1_000_000
    })
    expect(await inspector.scanOnce()).toEqual([])
    expect(events).toEqual([])
  })
})

describe('Phase 11.3.2 — True-positive: โค้ดนักเรียนแอบออกเน็ต/AI', () => {
  it('ลูก sandbox ยิง IP ภายนอก = STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL (CRITICAL)', async () => {
    // จำลอง src/utils/helper.py ของนักเรียนยิง https://api.openai.com/... —
    // ระดับ network เห็นเป็น socket นอก loopback ของ pid ที่อนุญาต
    const { inspector, events } = makeSandboxNetInspector(
      [{ pid: 777, processName: 'python.exe', peerAddress: '104.18.7.9', peerPort: 443, state: 'ESTABLISHED' }],
      [777]
    )
    const produced = await inspector.scanOnce()
    expect(produced).toHaveLength(1)
    expect(produced[0]!.code).toBe('STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL')
    expect(produced[0]!.severity).toBe('critical')
    expect(produced[0]!.detail.pid).toBe('777')
    expect(produced[0]!.detail.processName).toBe('python.exe')
    expect(produced[0]!.detail.peer).toBe('104.18.7.9:443')
    expect(events).toHaveLength(1)
  })

  it('DNS cache diff จับโดเมน AI (api.openai.com) ที่โผล่ระหว่างสอบ', () => {
    const baseline = new Set(['ntp.local', 'exam-proxy.local'])
    const events = diffDnsCache(baseline, ['ntp.local', 'api.openai.com'], policy)
    expect(events.map((e) => e.code)).toContain('FORBIDDEN_DNS_QUERY_DETECTED')
    expect(events.map((e) => e.detail.domain)).toContain('api.openai.com')
  })

  it('โปรเซสอื่นที่ไม่ใช่ลูก sandbox ยังใช้รหัส generic เดิม (ไม่ปน)', async () => {
    const { inspector } = makeSandboxNetInspector(
      [{ pid: 10, processName: 'curl.exe', peerAddress: '104.18.7.9', peerPort: 443, state: 'ESTABLISHED' }],
      [777]
    )
    const produced = await inspector.scanOnce()
    expect(produced.some((e) => e.code === 'DIRECT_SOCKET_PROXY_BYPASS')).toBe(true)
    expect(produced.some((e) => e.code === 'STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL')).toBe(false)
  })
})

describe('Phase 11.3.3 — Hidden test cases & seed zero-leakage audit', () => {
  const SECRET_SOLUTION = 'SOLUTION-SECRET-MARKER-9f8e7d6c'
  const SECRET_SETUP = 'SETUP-OVERRIDE-SECRET-1a2b3c4d'
  const SECRET_HIDDEN_FILE = 'HIDDEN-FILE-SECRET-5e6f7a8b'
  const SECRET_DB_PASS = 'TEACHER-DB-SECRET-p@ss'

  function fullPackage(): CodeExamPackage {
    return {
      moduleId: 'code-ide',
      packageId: '33333333-3333-4333-8333-333333333333',
      title: 'Q1_Secret_Audit',
      instructions: 'do it',
      category: 'database',
      language: 'sql-sqlite',
      entries: [
        { path: 'db', kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false },
        f('db/seed.sql', 'CREATE TABLE users(id INTEGER);'),
        f('answer.sql', 'SELECT 1;'),
        { ...f('tests/secret-check.sql', SECRET_HIDDEN_FILE), hiddenFromStudent: true }
      ],
      referenceSolution: [f('answer.sql', SECRET_SOLUTION)],
      policy: { entryPointPath: 'answer.sql', allowCreateFiles: true, allowCreateFolders: true, allowDeleteRename: true, allowStudentFileUpload: false, maxProjectSizeBytes: 1024 * 1024 },
      dependencies: [],
      database: {
        enabled: true, engine: 'sqlite', sqlMode: 'query', seedSqlPath: 'db/seed.sql',
        allowDestructiveQueries: true, respawnFreshDbOnEveryRun: true, exposeDbViewerToStudent: true,
        host: 'localhost', port: 3303, dbUser: 'root', dbPassword: SECRET_DB_PASS, databaseName: ''
      },
      testCases: [
        { testId: 'sample-1', kind: 'sql-query', title: 's', expectedColumns: ['c'], expectedRows: [[1]], checkColumnOrder: true, checkRowOrder: true, visibility: 'sample', points: 5, timeoutMs: 2000 },
        { testId: 'hidden-1', kind: 'sql-query', title: 'h', setupSqlOverride: SECRET_SETUP, expectedColumns: ['c'], expectedRows: [[2]], checkColumnOrder: true, checkRowOrder: true, visibility: 'hidden', points: 10, timeoutMs: 2000 }
      ],
      installPolicy: { enabled: false, ecosystems: [] },
      blobs: {}
    }
  }

  it('stripped view ไม่มีร่องรอยความลับแม้แต่ไบต์เดียว', () => {
    const view = stripCodePackageForStudent(fullPackage())
    // schema ฝั่งนักเรียนต้อง parse ผ่าน
    expect(() => StudentCodePackageViewSchema.parse(view)).not.toThrow()
    // ไม่มี hidden entries / hidden tests
    expect(assertStudentViewClean(view)).toEqual([])
    expect(view.entries.some((e) => e.path === 'tests/secret-check.sql')).toBe(false)
    expect(view.sampleTests.some((t) => t.testId === 'hidden-1')).toBe(false)
    expect(view.sampleTests.every((t) => t.visibility === 'sample')).toBe(true)
    // สแกนทั้งก้อนแบบ byte-level
    const dumped = JSON.stringify(view)
    for (const secret of [SECRET_SOLUTION, SECRET_SETUP, SECRET_HIDDEN_FILE, SECRET_DB_PASS]) {
      expect(dumped).not.toContain(secret)
    }
    // รหัสผ่าน DB ครูต้องถูกตัด
    expect(view.database.dbPassword).toBe('')
  })
})

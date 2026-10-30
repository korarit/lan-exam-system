import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCliTest } from './runners/cli-runner'
import { runSqliteTestWithTimeout } from './runners/sql-runner'
import {
  allocateEphemeralPort,
  killProcessTree,
  spawnServer,
  waitForPort
} from './runners/backend-api-runner'
import { runDomTest } from './runners/dom-runner'
import {
  assertPathInside,
  buildSandboxEnv,
  javaSandboxArgs,
  scanDestructiveCode
} from './anti-delete-guard'
import {
  materializeExecutionSandbox,
  teardownRunDir
} from './workspace-materializer'
import { authorizedChildProcesses } from './authorized-process-registry'
import { gradeProject, type GradeJobInput } from './code-grader-queue'
import { checkRuntime, clearCustomSdkPaths, getRuntimePathEntries, setCustomSdkPath } from './runtime-locator'
import type { CliTestCase, CodeExamPackage, VirtualEntry } from '../shared/code-schema'

/* ============================================================
 * Phase 11.2 — Hostile Code, Resource Limit & Sandbox Stress
 * เกณฑ์ผ่านตามสเปค:
 * - infinite loop / hanging server ถูกตัดจบใน timeoutMs (+slack
 *   ของ CI) คืนสถานะ TIME_LIMIT / timedOut + คืนพอร์ต + ไม่ค้าง pid
 * - query หนัก (Recursive CTE / Cross Join) ถูกตัดจบโดยไม่ค้าง main
 * - คำสั่งลบไฟล์ทุกภาษาถูกบล็อกก่อนรัน ไฟล์ครูอยู่ครบ 100%
 * - ไม่พบ runtime = แจ้งให้ติดตั้งเอง (ไม่มี auto-download)
 * - stdout flood ถูกตัด/ตัดทอน + ล้าง runDir ทุกครั้ง
 * ============================================================ */

function f(filePath: string, content: string): VirtualEntry {
  return { path: filePath, kind: 'file', content, encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
}

function cliTest(testId: string, stdin: string, expectedStdout: string, timeoutMs: number): CliTestCase {
  return { testId, kind: 'stdio', title: testId, stdin, expectedStdout, inputs: [], visibility: 'sample', points: 10, timeoutMs }
}

function sqlTest(testId: string, timeoutMs: number) {
  return {
    testId, kind: 'sql-query' as const, title: testId,
    expectedColumns: ['c'], expectedRows: [[1]],
    checkColumnOrder: true, checkRowOrder: true,
    visibility: 'sample' as const, points: 10, timeoutMs
  }
}

describe('Phase 11.2.1 — Infinite loop & hanging server kill', () => {
  it('Python while True ถูกตัดจบ + คืน timedOut (ไม่ค้าง)', async () => {
    const t0 = Date.now()
    const r = await runCliTest(
      [f('loop.py', 'while True:\n    pass\n')],
      'python', 'loop.py', cliTest('loop-py', '', '', 1500)
    )
    const elapsed = Date.now() - t0
    expect(r.timedOut).toBe(true)
    // สเปค: timeoutMs + 300ms — เผื่อ CI slack เป็น +8s (วัดว่า "ตัดจบ" ไม่ใช่ "รันจน test timeout")
    expect(elapsed).toBeLessThan(1500 + 8000)
  }, 30_000)

  it('Node while(true) ถูกตัดจบ + unregister pid จาก registry', async () => {
    const before = authorizedChildProcesses.size()
    const r = await runCliTest(
      [f('loop.js', 'while (true) {}\n')],
      'javascript', 'loop.js', cliTest('loop-js', '', '', 1500)
    )
    expect(r.timedOut).toBe(true)
    expect(authorizedChildProcesses.size()).toBeLessThanOrEqual(before)
  }, 30_000)

  it('Backend server ที่ hang (ไม่ตอบ) ถูก kill + คืนพอร์ต', async () => {
    const port = await allocateEphemeralPort('127.0.0.1')
    const serverFile = path.join(os.tmpdir(), `ztcode-hang-${Date.now()}.js`)
    fs.writeFileSync(serverFile, "require('http').createServer((q, s) => {}).listen(Number(process.env.PORT), '127.0.0.1');\n", 'utf8')
    const child = spawnServer('node', [serverFile], {
      cwd: os.tmpdir(),
      env: buildSandboxEnv(os.tmpdir()),
      port
    })
    try {
      expect(await waitForPort('127.0.0.1', port, 8000)).toBe(true)
      const pid = child.pid
      expect(pid).toBeDefined()
      // ขณะรัน pid อยู่ใน registry (guard ข้ามการฟ้องชั่วคราว)
      expect(authorizedChildProcesses.isAuthorized(pid as number)).toBe(true)
      killProcessTree(child)
      await new Promise((r) => setTimeout(r, 1200))
      // พอร์ตต้องว่างอีกครั้ง + pid หลุดจาก registry
      expect(await waitForPort('127.0.0.1', port, 1500)).toBe(false)
      expect(authorizedChildProcesses.isAuthorized(pid as number)).toBe(false)
    } finally {
      try { killProcessTree(child) } catch { /* noop */ }
      fs.rmSync(serverFile, { force: true })
    }
  }, 30_000)

  it('Frontend render loop (bundle ไม่จบ) ถูกตัดจบใน dom runner', async () => {
    const t0 = Date.now()
    const r = await runDomTest({
      testId: 'loop-dom',
      bundleJs: 'while (true) {}',
      documentHtml: '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
      assertionScript: 'assert(true);',
      timeoutMs: 3000
    })
    expect(r.passed).toBe(false)
    expect(Date.now() - t0).toBeLessThan(3000 + 15_000 + 8000)
  }, 40_000)
})

describe('Phase 11.2.2 — SQL heavy query interruption', () => {
  it('SELECT ไม่รู้จบ (Recursive CTE) ถูกตัดตอน — main ไม่ค้าง + แถวถูก cap', async () => {
    const t0 = Date.now()
    const r = await runSqliteTestWithTimeout(
      'CREATE TABLE t(a INTEGER);',
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x AS c FROM c;',
      sqlTest('sql-inf', 2000)
    )
    const elapsed = Date.now() - t0
    expect(r.passed).toBe(false)
    // ไม่ค้างโปรเซสหลัก + ผลถูกตัดตอน (cap 5000 แถว กัน flood/OOM)
    expect(elapsed).toBeLessThan(2000 + 8000)
    expect(r.actualRows.length).toBeLessThanOrEqual(5000)
    // main thread ยังตอบสนอง — query ธรรมดาต่อได้ทันที
    const ok = await runSqliteTestWithTimeout('CREATE TABLE t(a INTEGER); INSERT INTO t VALUES (1);', 'SELECT a AS c FROM t;', sqlTest('sql-after', 2000))
    expect(ok.passed).toBe(true)
  }, 30_000)

  it('DML พ่วง CTE ไม่รู้จบ ถูกตัดจบด้วย backstop timer (note หมดเวลา)', async () => {
    const t0 = Date.now()
    const r = await runSqliteTestWithTimeout(
      'CREATE TABLE t(a INTEGER);',
      'INSERT INTO t SELECT x FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c);',
      sqlTest('sql-dml-bomb', 1500)
    )
    const elapsed = Date.now() - t0
    expect(r.passed).toBe(false)
    expect(r.note).toMatch(/หมดเวลา/)
    expect(elapsed).toBeLessThan(1500 + 2000 + 3000 + 8000)
  }, 40_000)
})

describe('Phase 11.2.3 — Anti file-deletion ทุกภาษา + vault isolation', () => {
  const CASES: Array<[string, string, string]> = [
    ['c', 'evil.c', '#include <stdio.h>\nint main(){ remove("D:\\\\work\\\\x.txt"); return 0; }\n'],
    ['c-system', 'evil2.c', '#include <stdlib.h>\nint main(){ system("del /f /s /q D:\\\\work"); return 0; }\n'],
    ['cpp', 'evil.cpp', '#include <filesystem>\nint main(){ std::filesystem::remove_all(".."); }\n'],
    ['rust', 'evil.rs', 'fn main(){ std::fs::remove_dir_all("..").unwrap(); }\n'],
    ['rust-cmd', 'evil2.rs', 'fn main(){ std::process::Command::new("sh").spawn().unwrap(); }\n'],
    ['go', 'evil.go', 'package main\nimport "os"\nfunc main(){ os.RemoveAll("..") }\n'],
    ['go-exec', 'evil2.go', 'package main\nimport "os/exec"\nfunc main(){ exec.Command("cmd").Run() }\n'],
    ['php', 'evil.php', '<?php unlink("/var/work/x");\n'],
    ['php-shell', 'evil2.php', '<?php shell_exec("rm -rf /tmp/work");\n'],
    ['python', 'evil.py', 'import os\nos.remove("/tmp/work/x")\n'],
    ['python-tree', 'evil2.py', 'import shutil\nshutil.rmtree("..")\n'],
    ['python-sys', 'evil3.py', 'import os\nos.system("rmdir /s /q work")\n'],
    ['node', 'evil.js', 'const fs = require("fs");\nfs.rmSync("..", { recursive: true });\n'],
    ['node-child', 'evil2.js', 'const cp = require("child_process");\ncp.execSync("del /f /s /q work");\n'],
    ['java', 'Evil.java', 'import java.nio.file.*;\nclass Evil { void x() throws Exception { Files.delete(Path.of("work")); } }\n'],
    ['java-exec', 'Evil2.java', 'class Evil2 { void x() throws Exception { Runtime.getRuntime().exec("del work"); } }\n'],
    ['java-pb', 'Evil3.java', 'class Evil3 { void x() throws Exception { new ProcessBuilder("cmd").start(); } }\n']
  ]

  it.each(CASES)('%s: %s ถูก scanner บล็อก', (_lang, name, content) => {
    const hits = scanDestructiveCode([f(name, content)])
    expect(hits.length).toBeGreaterThanOrEqual(1)
  })

  it('โค้ดสะอาด (รวม db.exec / PDO-style) ไม่โดน flag', () => {
    const hits = scanDestructiveCode([
      f('server.js', 'db.prepare("SELECT 1").get();\ndb.exec("CREATE TABLE t(a)");\n'),
      f('main.py', 'print(sum([1, 2, 3]))\n'),
      f('Main.java', 'public class Main { public static void main(String[] a) { System.out.println(42); } }\n')
    ])
    expect(hits).toHaveLength(0)
  })

  it('VirtualProjectTree พาธ ../../evil.sh ถูกกันตั้งแต่ materialize', () => {
    expect(() => assertPathInside('/tmp/base', '../../evil.sh')).toThrow()
    expect(() =>
      materializeExecutionSandbox([f('../../evil.sh', 'x')])
    ).toThrow()
  })

  it('ไฟล์ readOnly ที่นักเรียนแอบแก้ถูกเขียนทับด้วยต้นฉบับครูเสมอ', () => {
    const teacher: VirtualEntry = { ...f('config/app.json', '{"mode":"exam"}'), readOnly: true }
    const student: VirtualEntry = { ...f('config/app.json', '{"mode":"hacked"}'), readOnly: false }
    const mat = materializeExecutionSandbox([student], { teacherOriginals: [teacher] })
    try {
      expect(fs.readFileSync(path.join(mat.runDir, 'config/app.json'), 'utf8')).toBe('{"mode":"exam"}')
    } finally {
      teardownRunDir(mat.runDir)
    }
  })

  it('end-to-end: โค้ดลบไฟล์ถูกบล็อกก่อนรัน + ไฟล์ vault ครูอยู่ครบ 100%', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'ztcode-vault-'))
    const sentinel = path.join(vault, '65010001', 'Q1', 'Main.java')
    fs.mkdirSync(path.dirname(sentinel), { recursive: true })
    fs.writeFileSync(sentinel, 'class Main {}', 'utf8')
    const before = fs.readFileSync(sentinel, 'utf8')

    const pkg: CodeExamPackage = {
      moduleId: 'code-ide',
      packageId: '22222222-2222-4222-8222-222222222222',
      title: 'Q99_Guard',
      instructions: '',
      category: 'cli-algorithm',
      language: 'python',
      entries: [f('main.py', 'print(1)')],
      referenceSolution: [],
      policy: { entryPointPath: 'main.py', allowCreateFiles: true, allowCreateFolders: true, allowDeleteRename: true, allowStudentFileUpload: false, maxProjectSizeBytes: 1024 * 1024 },
      dependencies: [],
      database: { enabled: false, engine: 'sqlite', sqlMode: 'query', allowDestructiveQueries: true, respawnFreshDbOnEveryRun: true, exposeDbViewerToStudent: true, host: 'localhost', port: 3303, dbUser: 'root', dbPassword: '', databaseName: '' },
      testCases: [{ testId: 't1', kind: 'stdio', title: 't', stdin: '', expectedStdout: '1', inputs: [], visibility: 'sample', points: 10, timeoutMs: 5000 }],
      installPolicy: { enabled: false, ecosystems: [] },
      blobs: {}
    }
    const report = await gradeProject({
      examPackage: { ...pkg, entries: [...pkg.entries] },
      studentId: '65010001',
      entries: [f('main.py', 'import shutil\nshutil.rmtree("..")\nprint(1)\n')],
      teacherWorkspaceRoot: vault
    } satisfies GradeJobInput)
    expect(report.blockedReason).toMatch(/บล็อก|Guard/)
    expect(report.results).toHaveLength(0)
    // vault ไม่ถูกแตะแม้แต่ไบต์เดียว
    expect(fs.existsSync(sentinel)).toBe(true)
    expect(fs.readFileSync(sentinel, 'utf8')).toBe(before)
    fs.rmSync(vault, { recursive: true, force: true })
  })
})

describe('Phase 11.2.4 — Missing runtime (no auto-download)', () => {
  it('runtime ที่ไม่มีจริง = found:false + hint ติดตั้งเอง', async () => {
    const r = await checkRuntime('__no_such_runtime__')
    expect(r.found).toBe(false)
    expect(r.hint.length).toBeGreaterThan(0)
  })

  it('node/python ที่ติดตั้งอยู่ = found:true + version', async () => {
    const node = await checkRuntime('node')
    expect(node.found).toBe(true)
    const python = await checkRuntime('python')
    expect(python.found).toBe(true)
  })

  it('Browse โฟลเดอร์เอง (custom SDK path) มีผล + ล้างได้', () => {
    const nodeBinDir = path.dirname(process.execPath)
    setCustomSdkPath('node', nodeBinDir)
    try {
      expect(getRuntimePathEntries(['node'])).toContain(nodeBinDir)
    } finally {
      clearCustomSdkPaths()
    }
    expect(getRuntimePathEntries(['node'])).toHaveLength(0)
  })
})

describe('Phase 11.2.5 — Stdout flood & memory', () => {
  it('พิมพ์ ~1MB ถูกตัดทอนอย่างปลอดภัย + ล้าง runDir', async () => {
    const r = await runCliTest(
      [f('flood.js', "for (let i = 0; i < 20000; i++) console.log('x'.repeat(50));\n")],
      'javascript', 'flood.js', cliTest('flood', '', '', 15_000)
    )
    // ไม่ค้าง (จบในเวลา) + output ถูก slice เหลือ 20k ตัวอักษร
    expect(r.actualStdout.length).toBeLessThanOrEqual(20_000)
  }, 40_000)

  it('จองหน่วยความจำ ~100MB แล้วคืน (ไม่ค้าง/ไม่ crash)', async () => {
    const r = await runCliTest(
      [f('mem.py', 'x = bytearray(100 * 1024 * 1024)\nprint(len(x))\n')],
      'python', 'mem.py', cliTest('mem', '', '104857600', 20_000)
    )
    expect(r.passed).toBe(true)
  }, 40_000)

  it('Java ถูกจำกัด heap 256MB ผ่าน -Xmx (flag อยู่ใน sandbox args)', () => {
    expect(javaSandboxArgs().join(' ')).toMatch(/-Xmx256m/)
  })
})

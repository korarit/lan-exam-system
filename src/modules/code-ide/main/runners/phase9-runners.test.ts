import { describe, expect, it } from 'vitest'
import { typedInputsToStdin } from '../../shared/code-schema'
import { scanDestructiveCode } from '../anti-delete-guard'
import { assertPathInside } from '../anti-delete-guard'
import { materializeExecutionSandbox, teardownRunDir } from '../workspace-materializer'
import { runSqliteTest, runMysqlPreflight } from './sql-runner'
import { allocateEphemeralPort, waitForPort } from './backend-api-runner'
import { runtimesForLanguage } from '../runtime-locator'

describe('Phase 9 — LeetCode typed inputs', () => {
  it('รวม inputs หลาย type เป็น stdin', () => {
    expect(typedInputsToStdin([
      { name: 'x', type: 'int', value: '5' },
      { name: 'y', type: 'float', value: '3.14' },
      { name: 's', type: 'string', value: 'hello' },
      { name: 'ok', type: 'bool', value: 'true' }
    ])).toBe('5\n3.14\nhello\ntrue')
  })
  it('inputs ว่าง = stdin ว่าง', () => {
    expect(typedInputsToStdin([])).toBe('')
  })
})

describe('Phase 9.2 — Anti-Delete Guard', () => {
  it('ดัก os.remove / fs.rm / Files.delete', () => {
    const hits = scanDestructiveCode([
      { path: 'a.py', kind: 'file', content: 'import os\nos.remove("/tmp/x")', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false },
      { path: 'b.ts', kind: 'file', content: 'fs.rmSync("/etc/passwd")', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
    ])
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })
  it('โค้ดสะอาดไม่โดน flag', () => {
    const hits = scanDestructiveCode([
      { path: 'main.py', kind: 'file', content: 'print(int(input()) + 1)', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
    ])
    expect(hits).toHaveLength(0)
  })
  it('กัน path traversal', () => {
    expect(() => assertPathInside('/tmp/base', '../../etc/passwd')).toThrow()
    expect(() => assertPathInside('/tmp/base', 'src/a.py')).not.toThrow()
  })
})

describe('Phase 9.3 — Materializer', () => {
  it('เขียนไฟล์ลง runDir แล้วล้างได้', () => {
    const { runDir, writtenFiles } = materializeExecutionSandbox([
      { path: 'src', kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false },
      { path: 'src/main.py', kind: 'file', content: 'print(1)', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
    ])
    expect(writtenFiles).toContain('src/main.py')
    teardownRunDir(runDir)
  })
})

describe('Phase 9.4.4 — SQL runners', () => {
  it('sqlite: SELECT ตรง expected = ผ่าน', async () => {
    const r = await runSqliteTest(
      'CREATE TABLE users(id INTEGER, name TEXT); INSERT INTO users VALUES (1, \'Ann\');',
      'SELECT id, name FROM users;',
      { testId: 's1', kind: 'sql-query', title: 't', expectedColumns: ['id', 'name'], expectedRows: [[1, 'Ann']], checkColumnOrder: true, checkRowOrder: true, visibility: 'sample', points: 10, timeoutMs: 2000 }
    )
    expect(r.passed).toBe(true)
  })
  it('sqlite: DELETE แล้วตรวจด้วย verificationQuery', async () => {
    const r = await runSqliteTest(
      'CREATE TABLE users(id INTEGER); INSERT INTO users VALUES (1); INSERT INTO users VALUES (2);',
      'DELETE FROM users WHERE id = 1;',
      { testId: 's2', kind: 'sql-query', title: 't', verificationQuery: 'SELECT id FROM users;', expectedColumns: ['id'], expectedRows: [[2]], checkColumnOrder: true, checkRowOrder: true, visibility: 'hidden', points: 10, timeoutMs: 2000 }
    )
    expect(r.passed).toBe(true)
  })
  it('sqlite โหมดสร้าง table: เริ่มจาก DB ว่าง + ตรวจด้วย verificationQuery', async () => {
    const r = await runSqliteTest(
      '',
      'CREATE TABLE students(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO students VALUES (1, \'Ann\');',
      { testId: 's3', kind: 'sql-query', title: 't', verificationQuery: 'SELECT name FROM students WHERE id = 1;', expectedColumns: ['name'], expectedRows: [['Ann']], checkColumnOrder: true, checkRowOrder: true, visibility: 'hidden', points: 10, timeoutMs: 2000 }
    )
    expect(r.passed).toBe(true)
  })
  it('mysql: port ปิด = preflight ไม่ผ่าน + แจ้งเตือน', async () => {
    const r = await runMysqlPreflight(
      { enabled: true, engine: 'mysql', sqlMode: 'query', allowDestructiveQueries: true, respawnFreshDbOnEveryRun: true, exposeDbViewerToStudent: true, host: '127.0.0.1', port: 59999, dbUser: 'root', dbPassword: '', databaseName: 'exam_db' },
      { testId: 'm1', kind: 'sql-query', title: 't', expectedColumns: [], expectedRows: [], checkColumnOrder: true, checkRowOrder: true, visibility: 'sample', points: 5, timeoutMs: 2000 }
    )
    expect(r.passed).toBe(false)
    expect(r.note).toContain('59999')
  }, 10000)
})

describe('Phase 9.4.3 — ephemeral port', () => {
  it('ขอ port ว่างแล้ว probe เจอ', async () => {
    const port = await allocateEphemeralPort('127.0.0.1')
    expect(port).toBeGreaterThan(0)
    // ยังไม่มี server → probe ไม่เจอ (false) ภายใน timeout สั้น
    const found = await waitForPort('127.0.0.1', port, 600)
    expect(found).toBe(false)
  }, 10000)
})

describe('Phase 9.1 — runtime map', () => {
  it('map ภาษาไป runtime ถูก', () => {
    expect(runtimesForLanguage('java')).toEqual(['java'])
    expect(runtimesForLanguage('sql-sqlite')).toEqual([])
    expect(runtimesForLanguage('python-backend')).toEqual(['python'])
  })
})

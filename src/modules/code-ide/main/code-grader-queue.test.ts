import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import {
  GradingWorkerQueue,
  defaultMaxConcurrentRuns,
  gradeProject,
  type GradeJobInput
} from './code-grader-queue'
import { allocateEphemeralPort } from './runners/backend-api-runner'
import type { CodeExamPackage, VirtualEntry } from '../shared/code-schema'

function nodeAvailable(): boolean {
  try {
    execSync('node --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const describeNode = nodeAvailable() ? describe : describe.skip

/* ============================================================
 * Phase 10 — Automated Tests (Definition of DoD)
 * - Multi-Folder Submission + Strip node_modules
 * - Concurrent Backend & SQL Grading (port/db isolation, no EADDRINUSE)
 * ============================================================ */

function entry(path: string, content: string): VirtualEntry {
  return { path, kind: 'file', content, encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
}

function sqlPackage(): CodeExamPackage {
  return {
    moduleId: 'code-ide',
    packageId: '123e4567-e89b-12d3-a456-426614174000',
    title: 'Q4_Database_SQL',
    instructions: 'SELECT',
    category: 'database',
    language: 'sql-sqlite',
    entries: [entry('answer.sql', 'SELECT 1;')],
    referenceSolution: [],
    policy: { entryPointPath: 'answer.sql', allowCreateFiles: true, allowCreateFolders: true, allowDeleteRename: true, allowStudentFileUpload: false, maxProjectSizeBytes: 10 * 1024 * 1024 },
    dependencies: [],
    database: {
      enabled: true, engine: 'sqlite', sqlMode: 'query', seedSqlPath: 'db/seed.sql',
      allowDestructiveQueries: true, respawnFreshDbOnEveryRun: true, exposeDbViewerToStudent: true,
      host: 'localhost', port: 3303, dbUser: 'root', dbPassword: '', databaseName: ''
    },
    testCases: [
      {
        testId: 'sample-1', kind: 'sql-query', title: 'ดึง Ann',
        setupSqlOverride: "DELETE FROM users; INSERT INTO users VALUES (9, 'Hidden');",
        expectedColumns: ['id', 'name'], expectedRows: [[9, 'Hidden']],
        checkColumnOrder: true, checkRowOrder: true, visibility: 'hidden', points: 10, timeoutMs: 2000
      },
      {
        testId: 'sample-2', kind: 'sql-query', title: 'นับแถว',
        expectedColumns: ['c'], expectedRows: [[3]],
        checkColumnOrder: true, checkRowOrder: true, visibility: 'sample', points: 5, timeoutMs: 2000
      }
    ],
    installPolicy: { enabled: false, ecosystems: [] },
    blobs: {}
  }
}

const SEED = 'CREATE TABLE users(id INTEGER, name TEXT); INSERT INTO users VALUES (1, \u0027Ann\u0027), (2, \u0027Bob\u0027), (3, \u0027Cat\u0027);'

function studentEntries(): VirtualEntry[] {
  return [
    { path: 'db', kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false },
    entry('db/seed.sql', SEED),
    entry('answer.sql', 'SELECT COUNT(*) AS c FROM users;')
  ]
}

function jobFor(studentId: string): GradeJobInput {
  const pkg = sqlPackage()
  // seed อยู่ใน package entries (Master Seed ฝั่งครู)
  const withSeed: CodeExamPackage = { ...pkg, entries: [entry('db/seed.sql', SEED)] }
  return { examPackage: withSeed, studentId, entries: studentEntries() }
}

describe('Phase 10.2 — GradingWorkerQueue', () => {
  it('concurrency เริ่มต้นตามคอร์ CPU (>= 2)', () => {
    expect(defaultMaxConcurrentRuns()).toBeGreaterThanOrEqual(2)
  })

  it('ตรวจ SQL ผ่านทั้ง sample + hidden (hidden ใช้ setupSqlOverride กัน hardcode)', async () => {
    const report = await gradeProject(jobFor('65010001'))
    expect(report.totalCount).toBe(2)
    // answer.sql ของนักเรียน = SELECT COUNT(*) → sample-2 ผ่าน, hidden (ดึง Hidden) ไม่ผ่าน
    const hidden = report.results.find((r) => r.testId === 'sample-1')
    const sample = report.results.find((r) => r.testId === 'sample-2')
    expect(sample?.passed).toBe(true)
    expect(sample?.earned).toBe(5)
    expect(hidden?.passed).toBe(false)
    expect(report.passedCount).toBe(1)
    expect(report.earnedPoints).toBe(5)
  })

  it('โค้ดลบไฟล์ถูกบล็อกก่อนรัน (status ผ่าน blockedReason)', async () => {
    const pkg = sqlPackage()
    const evil: VirtualEntry[] = [entry('answer.sql', 'SELECT 1;'), entry('evil.py', 'import os\nos.remove("/tmp/x")')]
    const report = await gradeProject({ examPackage: pkg, studentId: '65010099', entries: evil })
    expect(report.blockedReason).toMatch(/บล็อก|Guard/)
    expect(report.results).toHaveLength(0)
  })

  it('รันตรวจพร้อมกัน 20 งานผ่านคิว — คะแนนถูกทุกงาน ไม่มีชนกัน', async () => {
    const queue = new GradingWorkerQueue(4)
    const reports = await Promise.all(
      Array.from({ length: 20 }, (_, i) => queue.enqueue(jobFor(`65010${String(i).padStart(3, '0')}`)))
    )
    expect(reports).toHaveLength(20)
    for (const r of reports) {
      expect(r.earnedPoints).toBe(5)
      expect(r.passedCount).toBe(1)
      expect(r.totalCount).toBe(2)
    }
    expect(queue.activeCount).toBe(0)
    expect(queue.pendingCount).toBe(0)
  })

  it('จัดสรรพอร์ตพร้อมกัน 10 พอร์ต — ไม่ซ้ำกัน (กัน EADDRINUSE)', async () => {
    const ports = await Promise.all(
      Array.from({ length: 10 }, () => allocateEphemeralPort('127.0.0.1'))
    )
    expect(new Set(ports).size).toBe(10)
    for (const p of ports) {
      expect(p).toBeGreaterThan(0)
      expect(p).toBeLessThanOrEqual(65535)
    }
  })

  it('frontend ตรวจ DOM จริง — assertion ถูกผ่าน / ผิดตก', async () => {
    const pkg: CodeExamPackage = {
      ...sqlPackage(),
      packageId: '223e4567-e89b-12d3-a456-426614174001',
      title: 'Q2_Frontend',
      category: 'frontend',
      language: 'html-css-js',
      policy: { entryPointPath: 'app.js', allowCreateFiles: true, allowCreateFolders: true, allowDeleteRename: true, allowStudentFileUpload: false, maxProjectSizeBytes: 10 * 1024 * 1024 },
      testCases: [
        { testId: 'dom-1', kind: 'dom-assertion', title: 'หัวข้อถูก', route: '/index.html', assertionScript: `assert(document.querySelector('h1').textContent === 'Hi');`, visibility: 'sample', points: 10, timeoutMs: 5000 },
        { testId: 'dom-2', kind: 'dom-assertion', title: 'ปุ่มผิด', route: '/index.html', assertionScript: `assert(document.querySelector('button') !== null, 'ต้องมีปุ่ม');`, visibility: 'hidden', points: 5, timeoutMs: 5000 }
      ]
    }
    const entries = [
      entry('index.html', '<!DOCTYPE html><html><body><div id="root"></div></body></html>'),
      entry('app.js', `document.getElementById('root').innerHTML = '<h1>Hi</h1>';`)
    ]
    const report = await gradeProject({ examPackage: pkg, studentId: '65010001', entries })
    expect(report.totalCount).toBe(2)
    expect(report.results.find((r) => r.testId === 'dom-1')?.passed).toBe(true)
    expect(report.results.find((r) => r.testId === 'dom-2')?.passed).toBe(false)
    expect(report.earnedPoints).toBe(10)
    expect(report.passedCount).toBe(1)
  })

  it('โจทย์ fullstack/mixed ตรวจครบทุก kind (CLI + SQL ในแพ็กเกจเดียว)', async () => {
    const base = sqlPackage()
    const pkg: CodeExamPackage = {
      ...base,
      packageId: '423e4567-e89b-12d3-a456-426614174003',
      title: 'Q9_Fullstack',
      category: 'fullstack',
      language: 'python',
      entries: [entry('db/seed.sql', SEED)],
      policy: { entryPointPath: 'answer.sql', allowCreateFiles: true, allowCreateFolders: true, allowDeleteRename: true, allowStudentFileUpload: false, maxProjectSizeBytes: 10 * 1024 * 1024 },
      testCases: [
        { testId: 'sql-1', kind: 'sql-query', title: 'นับแถว', expectedColumns: ['c'], expectedRows: [[3]], checkColumnOrder: true, checkRowOrder: true, visibility: 'sample', points: 5, timeoutMs: 2000 }
      ]
    }
    const report = await gradeProject({ examPackage: pkg, studentId: '65010001', entries: studentEntries() })
    expect(report.totalCount).toBe(1)
    expect(report.results).toHaveLength(1)
    expect(report.results[0]?.passed).toBe(true)
  })
})

const NODE_SERVER_JS = `const http = require('http');
const { DatabaseSync } = require('node:sqlite');
const port = Number(process.env.PORT || '0');
const db = new DatabaseSync('app.db');
db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/users') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        db.prepare('INSERT INTO users (name) VALUES (?)').run(String(data.name ?? ''));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});
server.listen(port, '127.0.0.1');
`;

function backendPackage(): CodeExamPackage {
  return {
    ...sqlPackage(),
    packageId: '523e4567-e89b-12d3-a456-426614174004',
    title: 'Q3_Node_Backend_API',
    category: 'backend',
    language: 'node-backend',
    policy: { entryPointPath: 'server.js', allowCreateFiles: true, allowCreateFolders: true, allowDeleteRename: true, allowStudentFileUpload: false, maxProjectSizeBytes: 10 * 1024 * 1024 },
    testCases: [
      {
        testId: 'api-1', kind: 'http-api', title: 'POST สร้างผู้ใช้ + ตรวจ DB',
        requests: [
          { method: 'POST', path: '/api/users', bodyJson: '{"name":"Ann"}', expectedStatus: 201, expectedBodyMatcher: 'json-subset', expectedBody: '{"ok":true}' },
          { method: 'GET', path: '/nope', expectedStatus: 404, expectedBodyMatcher: 'json-subset', expectedBody: '{}' }
        ],
        verifyDb: {
          query: 'SELECT name FROM users ORDER BY id;',
          expectedColumns: ['name'],
          expectedRows: [['Ann']],
          checkColumnOrder: true,
          checkRowOrder: true
        },
        visibility: 'sample', points: 20, timeoutMs: 8000
      }
    ]
  }
}

function backendEntries(): VirtualEntry[] {
  return [entry('server.js', NODE_SERVER_JS)]
}

describeNode('Phase 10.2 — Backend grading + verifyDb (ต้องมี node ในเครื่อง)', () => {
  it('POST ผ่าน + GET 404 + สถานะ DB ตรง = เต็ม', async () => {
    const report = await gradeProject({ examPackage: backendPackage(), studentId: '65010001', entries: backendEntries() })
    expect(report.totalCount).toBe(1)
    const r = report.results[0]
    expect(r?.passed).toBe(true)
    expect(r?.earned).toBe(20)
    expect(r?.note).toMatch(/สถานะ DB ตรง/)
  }, 60_000)

  it('รันเซิร์ฟเวอร์พร้อมกัน 8 งานผ่านคิว — พอร์ตไม่ชน (no EADDRINUSE)', async () => {
    const queue = new GradingWorkerQueue(4)
    const reports = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        queue.enqueue({ examPackage: backendPackage(), studentId: `65020${String(i).padStart(2, '0')}`, entries: backendEntries() }))
    )
    expect(reports).toHaveLength(8)
    for (const r of reports) {
      expect(r.passedCount).toBe(1)
      expect(r.earnedPoints).toBe(20)
      expect(r.results[0]?.note).not.toMatch(/EADDRINUSE/)
    }
    expect(queue.activeCount).toBe(0)
    expect(queue.pendingCount).toBe(0)
  }, 120_000)
})

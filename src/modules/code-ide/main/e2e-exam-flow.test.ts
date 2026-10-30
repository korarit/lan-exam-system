import { describe, expect, it, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { HostDatabase } from '@main/storage/db'
import { CodeIdeHostService } from './code-host-service'
import { buildCodeScoresCsv, exportFullStudentProjectsBundle } from './code-exporter'
import { sanitizeFolderName } from './code-workspace-dirs'
import { assertStudentViewClean } from '../shared/student-view'
import type { CodeExamPackage, VirtualEntry } from '../shared/code-schema'

/* ============================================================
 * Phase 11.4 — Same-Machine End-to-End Simulation
 * (1 Host + 2 Student Instances ผ่าน embedded backend จริง)
 *
 * ขั้น 1: ครูเลือกโฟลเดอร์หลัก + สร้างชุดข้อสอบ 4 ข้อครบ 4 หมวด
 *   Q1 CLI/Python (หลายไฟล์) / Q2 Frontend/HTML (หลายโฟลเดอร์) /
 *   Q3 Backend/Node (REST + routes/) / Q4 Database/SQL
 * ขั้น 2: นักเรียน 2 คน join (ensureStudentDir) + รับ stripped view
 *   (ตรวจ zero-leakage ทุกห้อง)
 * ขั้น 3: นักเรียนเขียนไฟล์/สร้างโฟลเดอร์เพิ่ม + autosave + ส่งงาน
 * ขั้น 4: ตรวจ <root>/<studentId>/ บนดิสก์ครู + คะแนน + export
 *   CSV/bundle + re-grade ทั้งห้อง + สคริปต์ dev:pair
 * ============================================================ */

const ROOMS = ['e2e-q1', 'e2e-q2', 'e2e-q3', 'e2e-q4'] as const
const S1 = '65010001'
const S2 = '65010002'
const STABLE_KEY = randomBytes(32)

const tempRoots: string[] = []
afterAll(() => {
  for (const d of tempRoots.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

function mkTempRoot(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(d)
  return d
}

function makeDb(): HostDatabase {
  const db = new HostDatabase({ filePath: ':memory:' })
  for (const room of ROOMS) {
    db.db
      .prepare(
        `INSERT INTO exam_sessions (id, room_name, mode, enforcement, status, crypto_salt, created_at_ms)
         VALUES (?, ?, 'closed', 'report-only', 'running', ?, ?)`
      )
      .run(room, `ห้อง ${room}`, `salt-${room}`, Date.now())
  }
  return db
}

function f(filePath: string, content: string): VirtualEntry {
  return { path: filePath, kind: 'file', content, encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
}
function dir(dirPath: string): VirtualEntry {
  return { path: dirPath, kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
}
function ro(filePath: string, content: string): VirtualEntry {
  return { ...f(filePath, content), readOnly: true }
}

function basePkg(
  packageId: string,
  title: string,
  category: CodeExamPackage['category'],
  language: CodeExamPackage['language'],
  entryPointPath: string,
  entries: VirtualEntry[],
  testCases: CodeExamPackage['testCases']
): CodeExamPackage {
  return {
    moduleId: 'code-ide',
    packageId,
    title,
    instructions: 'e2e',
    category,
    language,
    entries,
    referenceSolution: [f('sol.txt', 'teacher-only')],
    policy: { entryPointPath, allowCreateFiles: true, allowCreateFolders: true, allowDeleteRename: true, allowStudentFileUpload: false, maxProjectSizeBytes: 5 * 1024 * 1024 },
    dependencies: [],
    database: {
      enabled: category === 'database', engine: 'sqlite', sqlMode: 'query', seedSqlPath: 'db/seed.sql',
      allowDestructiveQueries: true, respawnFreshDbOnEveryRun: true, exposeDbViewerToStudent: true,
      host: 'localhost', port: 3303, dbUser: 'root', dbPassword: '', databaseName: ''
    },
    testCases,
    installPolicy: { enabled: false, ecosystems: [] },
    blobs: {}
  }
}

const Q1_PKG = 'e2e11111-1111-4111-8111-111111111111'
const Q2_PKG = 'e2e22222-2222-4222-8222-222222222222'
const Q3_PKG = 'e2e33333-3333-4333-8333-333333333333'
const Q4_PKG = 'e2e44444-4444-4444-8444-444444444444'

function q1Package(): CodeExamPackage {
  return basePkg(Q1_PKG, 'Q1_CLI_Python', 'cli-algorithm', 'python', 'src/main.py', [
    dir('src'), dir('src/utils'),
    f('src/main.py', 'from utils.calc import add\nimport sys\nprint(add(*map(int, sys.stdin.read().split())))\n'),
    ro('src/utils/calc.py', 'def add(a, b):\n    return a + b\n'),
    ro('src/utils/__init__.py', '')
  ], [
    { testId: 'q1-s', kind: 'stdio', title: 's', stdin: '20 22', expectedStdout: '42', inputs: [], visibility: 'sample', points: 5, timeoutMs: 8000 },
    { testId: 'q1-h', kind: 'stdio', title: 'h', stdin: '1 2', expectedStdout: '3', inputs: [], visibility: 'hidden', points: 5, timeoutMs: 8000 }
  ])
}

function q2Package(): CodeExamPackage {
  return basePkg(Q2_PKG, 'Q2_Frontend', 'frontend', 'html-css-js', 'scripts/app.js', [
    dir('styles'), dir('scripts'),
    f('index.html', '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles/layout.css"></head><body><div id="root"></div></body></html>'),
    ro('styles/layout.css', 'h1 { color: blue; }\n'),
    f('scripts/app.js', "document.getElementById('root').innerHTML = '<h1>TODO</h1>';\n")
  ], [
    { testId: 'q2-s', kind: 'dom-assertion', title: 's', route: '/index.html', assertionScript: "assert(document.querySelector('h1').textContent === 'Hi');", visibility: 'sample', points: 10, timeoutMs: 5000 }
  ])
}

const Q3_ROUTES = `function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && url.pathname === '/api/users') return send(200, { ok: true, users: ['Ann'] });
  if (req.method === 'POST' && url.pathname === '/api/echo') {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { send(201, { you: JSON.parse(b || '{}').name }); }
      catch { send(400, {}); }
    });
    return;
  }
  return send(404, {});
}
module.exports = { route };
`

function q3Package(): CodeExamPackage {
  return basePkg(Q3_PKG, 'Q3_Backend', 'backend', 'node-backend', 'server.js', [
    dir('routes'),
    f('server.js', "const http = require('http');\nconst { route } = require('./routes/users');\nconst port = Number(process.env.PORT || '0');\nhttp.createServer(route).listen(port, '127.0.0.1');\n"),
    ro('routes/users.js', Q3_ROUTES)
  ], [
    {
      testId: 'q3-s', kind: 'http-api', title: 's',
      requests: [
        { method: 'GET', path: '/api/users', expectedStatus: 200, expectedBodyMatcher: 'json-subset', expectedBody: '{"ok":true}' },
        { method: 'POST', path: '/api/echo', bodyJson: '{"name":"Zed"}', expectedStatus: 201, expectedBodyMatcher: 'json-subset', expectedBody: '{"you":"Zed"}' }
      ],
      visibility: 'sample', points: 20, timeoutMs: 8000
    }
  ])
}

const Q4_SEED = `CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO users VALUES (1, 'Ann'), (2, 'Bob');`

function q4Package(): CodeExamPackage {
  return basePkg(Q4_PKG, 'Q4_SQL', 'database', 'sql-sqlite', 'answer.sql', [
    dir('db'),
    ro('db/seed.sql', Q4_SEED),
    f('answer.sql', 'SELECT 1;')
  ], [
    { testId: 'q4-s', kind: 'sql-query', title: 's', expectedColumns: ['id', 'name'], expectedRows: [[1, 'Ann'], [2, 'Bob']], checkColumnOrder: true, checkRowOrder: true, visibility: 'sample', points: 5, timeoutMs: 3000 },
    { testId: 'q4-h', kind: 'sql-query', title: 'h', setupSqlOverride: "DELETE FROM users; INSERT INTO users VALUES (9, 'Hidden');", expectedColumns: ['id', 'name'], expectedRows: [[9, 'Hidden']], checkColumnOrder: true, checkRowOrder: true, visibility: 'hidden', points: 5, timeoutMs: 3000 }
  ])
}

/** งานนักเรียน: รวมไฟล์ readOnly ต้นฉบับ (ห้ามแก้) + ไฟล์งานของตัวเอง */
function studentWork(pkg: CodeExamPackage, ownFiles: VirtualEntry[]): VirtualEntry[] {
  const locked = pkg.entries.filter((e) => e.readOnly === true).map((e) => ({ ...e }))
  // เติม folder entries ที่ไฟล์งานต้องใช้ (กัน FILE_WITHOUT_PARENT)
  const folders = new Map<string, VirtualEntry>()
  for (const e of [...locked, ...ownFiles]) {
    const segs = e.path.split('/')
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/')
      if (!folders.has(d)) folders.set(d, dir(d))
    }
  }
  const have = new Set([...locked, ...ownFiles].filter((e) => e.kind === 'folder').map((e) => e.path))
  return [...folders.values()].filter((e) => !have.has(e.path)).concat([...locked, ...ownFiles])
}

/** รอคิวตรวจ fire-and-forget ของ service จนได้สถานะสุดท้าย (poll แบบ dashboard ครู) */
async function waitSubmissionSettled(
  service: CodeIdeHostService,
  roomId: string,
  studentId: string,
  packageId: string,
  timeoutMs: number
): Promise<{ status: string; earnedPoints: number }> {
  const t0 = Date.now()
  for (;;) {
    const s = service.workspaceStore.getSubmission(roomId, studentId, packageId)
    if (s !== null && (s.status === 'graded' || s.status === 'blocked' || s.status === 'error')) {
      return { status: s.status, earnedPoints: s.earnedPoints }
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`E2E_TIMEOUT: ${roomId}/${studentId} ยังไม่ graded ใน ${timeoutMs}ms (status=${s?.status ?? 'none'})`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

describe('Phase 11.4 — Same-machine E2E (1 host + 2 students)', () => {
  it('ครบวงจร 4 หมวด: สร้างห้อง -> join -> เขียนโค้ด -> ส่งงาน -> ตรวจ -> export', async () => {
    const db = makeDb()
    const service = new CodeIdeHostService(db, () => STABLE_KEY, 2)
    const teacherRoot = mkTempRoot('ztcode-teacher-')

    // ---- ขั้น 1: ครูเลือกโฟลเดอร์หลัก + ลงชุดข้อสอบ 4 ข้อ ----
    service.dirsManager.setRootPath(teacherRoot)
    const pkgs: Record<string, CodeExamPackage> = {
      'e2e-q1': q1Package(),
      'e2e-q2': q2Package(),
      'e2e-q3': q3Package(),
      'e2e-q4': q4Package()
    }
    for (const [roomId, pkg] of Object.entries(pkgs)) {
      service.setRoomPackage(roomId, `ห้องสอบ ${roomId}`, pkg)
    }

    // ---- ขั้น 2: นักเรียน join + รับ stripped view (ต้องไม่มีความลับ) ----
    for (const roomId of ROOMS) {
      service.dirsManager.ensureStudentDir(S1)
      service.dirsManager.ensureStudentDir(S2)
      const view = service.studentViewFor(roomId)
      expect(view).not.toBeNull()
      expect(assertStudentViewClean(view!)).toEqual([])
      expect(fs.existsSync(path.join(teacherRoot, sanitizeFolderName(S1)))).toBe(true)
      expect(fs.existsSync(path.join(teacherRoot, sanitizeFolderName(S2)))).toBe(true)
    }

    // ---- ขั้น 3: นักเรียนเขียนงาน (S1 ถูก / S2 ผิดบางส่วน) + ส่ง ----
    const submissions: Record<string, Record<string, VirtualEntry[]>> = {
      'e2e-q1': {
        [S1]: studentWork(pkgs['e2e-q1']!, [dir('src'), f('src/main.py', 'from utils.calc import add\nimport sys\nprint(add(*map(int, sys.stdin.read().split())))\n'), dir('src/mine'), f('src/mine/notes.txt', 'my extra file\n')]),
        [S2]: studentWork(pkgs['e2e-q1']!, [dir('src'), f('src/main.py', 'print(0)\n')])
      },
      'e2e-q2': {
        [S1]: studentWork(pkgs['e2e-q2']!, [dir('scripts'), f('scripts/app.js', "document.getElementById('root').innerHTML = '<h1>Hi</h1>';\n"), dir('scripts/extra'), f('scripts/extra/todo.js', '// student folder\n')]),
        [S2]: studentWork(pkgs['e2e-q2']!, [dir('scripts'), f('scripts/app.js', "document.getElementById('root').innerHTML = '<h1>Bye</h1>';\n")])
      },
      'e2e-q3': {
        [S1]: studentWork(pkgs['e2e-q3']!, [f('server.js', "const http = require('http');\nconst { route } = require('./routes/users');\nconst port = Number(process.env.PORT || '0');\nhttp.createServer(route).listen(port, '127.0.0.1');\n")]),
        [S2]: studentWork(pkgs['e2e-q3']!, [f('server.js', "const http = require('http');\nconst port = Number(process.env.PORT || '0');\nhttp.createServer((q, s) => { s.writeHead(404, {'content-type':'application/json'}); s.end('{}'); }).listen(port, '127.0.0.1');\n")])
      },
      'e2e-q4': {
        [S1]: studentWork(pkgs['e2e-q4']!, [f('answer.sql', 'SELECT id, name FROM users ORDER BY id;')]),
        [S2]: studentWork(pkgs['e2e-q4']!, [f('answer.sql', 'SELECT id FROM users;')])
      }
    }

    const expectedEarned: Record<string, Record<string, number>> = {
      'e2e-q1': { [S1]: 10, [S2]: 0 },
      'e2e-q2': { [S1]: 10, [S2]: 0 },
      'e2e-q3': { [S1]: 20, [S2]: 0 },
      'e2e-q4': { [S1]: 10, [S2]: 0 }
    }

    for (const roomId of ROOMS) {
      const pkg = pkgs[roomId]!
      for (const sid of [S1, S2]) {
        const entries = submissions[roomId]![sid]!
        // autosave ระหว่างทำ (draft) แล้วกดส่งงาน
        const draft = service.ingestAutosave({ roomId, studentId: sid, entries, serverTimestampMs: Date.now() })
        expect(draft.accepted).toBe(true)
        const res = service.ingestProjectSubmission({ roomId, studentId: sid, entries, serverTimestampMs: Date.now() })
        expect(res.accepted).toBe(true)
        // ingest ยิง grading แบบ fire-and-forget เข้าคิว — รอจนสถานะสุดท้าย
        // (เหมือน dashboard ครูที่ poll สถานะ ไม่ใช่ await ตรง)
        const done = await waitSubmissionSettled(service, roomId, sid, pkg.packageId, 180_000)
        expect(done.status).toBe('graded')
        expect(done.earnedPoints).toBe(expectedEarned[roomId]![sid])
      }
    }

    // ---- ขั้น 4a: ดิสก์ครูมี <studentId>/ โครงตรงกับที่นักเรียนส่ง (mirror) ----
    for (const roomId of ROOMS) {
      const pkg = pkgs[roomId]!
      const slug = service.getRoomPackage(roomId)!.questionSlug
      for (const sid of [S1, S2]) {
        const qDir = path.join(teacherRoot, sanitizeFolderName(sid), slug)
        expect(fs.existsSync(qDir)).toBe(true)
        // ไฟล์ทุกไฟล์ที่ส่งต้องอยู่บนดิสก์ครูครบ
        for (const e of submissions[roomId]![sid]!.filter((x) => x.kind === 'file')) {
          expect(fs.existsSync(path.join(qDir, e.path))).toBe(true)
        }
        // grading-report ข้างงาน
        expect(fs.existsSync(path.join(qDir, 'grading-report.json'))).toBe(true)
        // mirror: สิ่งที่ครูเห็นใน store = สิ่งที่นักเรียนส่ง (เทียบทั้ง tree)
        const stored = service.workspaceStore.getSubmission(roomId, sid, pkg.packageId)
        expect(stored).not.toBeNull()
        expect(stored!.status).toBe('graded')
        expect(stored!.entries).toEqual(submissions[roomId]![sid])
      }
    }

    // ---- ขั้น 4b: CSV + export bundle คง nested folders ----
    for (const roomId of ROOMS) {
      const pkg = pkgs[roomId]!
      const { csvWithBom, rows } = buildCodeScoresCsv(service, roomId, `ห้องสอบ ${roomId}`, pkg)
      expect(rows).toHaveLength(2)
      expect(csvWithBom.charCodeAt(0)).toBe(0xfeff) // BOM เปิด Excel ไทย
      const exportDir = path.join(mkTempRoot('ztcode-export-'), roomId)
      const out = exportFullStudentProjectsBundle(service, roomId, `ห้องสอบ ${roomId}`, pkg, exportDir)
      expect(out.studentCount).toBe(2)
      expect(fs.existsSync(path.join(exportDir, 'summary-scores.csv'))).toBe(true)
      // nested folders ของ S1 ต้องอยู่ครบ (Q1: src/mine/notes.txt, Q2: scripts/extra/todo.js)
      const slug = service.getRoomPackage(roomId)!.questionSlug
      const s1dir = path.join(exportDir, sanitizeFolderName(S1), slug)
      expect(fs.existsSync(path.join(s1dir, 'grading-report.json'))).toBe(true)
      if (roomId === 'e2e-q1') expect(fs.existsSync(path.join(s1dir, 'src/mine/notes.txt'))).toBe(true)
      if (roomId === 'e2e-q2') expect(fs.existsSync(path.join(s1dir, 'scripts/extra/todo.js'))).toBe(true)
    }

    // ---- ขั้น 4c: ครูแก้ test แล้ว re-grade ทั้งห้องได้ ----
    const re = await service.regradeAllSubmissions('e2e-q1')
    expect(re.students).toBe(2)
    expect(re.graded).toBe(2)

    db.close()
  }, 300_000)

  it('มีสคริปต์ dev:pair สำหรับรันโหมดคู่ในเครื่องเดียว', async () => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(pkgJson.scripts?.['dev:pair']).toMatch(/dev:host/)
    expect(pkgJson.scripts?.['dev:pair']).toMatch(/dev:student/)
  })
})

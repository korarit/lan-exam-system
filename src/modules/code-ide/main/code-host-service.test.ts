import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { HostDatabase } from '@main/storage/db'
import { CodeIdeHostService, filterLibraryNoise } from './code-host-service'
import type { CodeExamPackage, VirtualEntry } from '../shared/code-schema'

/* ============================================================
 * Phase 10 — Host Service tests (ingest / encrypt / regrade)
 * ============================================================ */

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeDb(): HostDatabase {
  const db = new HostDatabase({ filePath: ':memory:' })
  db.db
    .prepare(
      `INSERT INTO exam_sessions (id, room_name, mode, enforcement, status, crypto_salt, created_at_ms)
       VALUES (?, ?, 'closed', 'report-only', 'ended', ?, ?)`
    )
    .run(ROOM, 'ห้อง 401', 'salt-room-1', Date.now())
  return db
}

function entry(path: string, content: string, readOnly = false): VirtualEntry {
  return { path, kind: 'file', content, encoding: 'utf8', readOnly, allowStudentCreateInside: true, hiddenFromStudent: readOnly }
}

function folder(path: string): VirtualEntry {
  return { path, kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
}

function cliPackage(): CodeExamPackage {
  return {
    moduleId: 'code-ide',
    packageId: '323e4567-e89b-12d3-a456-426614174002',
    title: 'Q1_Java_OOP',
    instructions: 'sum',
    category: 'cli-algorithm',
    language: 'python',
    entries: [entry('src/main.py', 'print("hi")', true)],
    referenceSolution: [entry('src/main.py', 'print("hi")')],
    policy: { entryPointPath: 'src/main.py', allowCreateFiles: true, allowCreateFolders: true, allowDeleteRename: true, allowStudentFileUpload: false, maxProjectSizeBytes: 1024 * 1024 },
    dependencies: [],
    database: {
      enabled: false, engine: 'sqlite', sqlMode: 'query',
      allowDestructiveQueries: true, respawnFreshDbOnEveryRun: true, exposeDbViewerToStudent: true,
      host: 'localhost', port: 3303, dbUser: 'root', dbPassword: '', databaseName: ''
    },
    testCases: [],
    blobs: {}
  }
}

const ROOM = 'room-1'
// คีย์ต้องคงที่ต่อห้อง (production ใช้ PBKDF2 deterministic — สุ่มใหม่ทุกครั้งจะถอดรหัสไม่ได้)
const STABLE_KEY = randomBytes(32)
const keyOf = (_roomId: string): Buffer => STABLE_KEY

describe('Phase 10.1 — CodeIdeHostService ingest', () => {
  let db: HostDatabase
  let service: CodeIdeHostService

  beforeEach(() => {
    db = makeDb()
    service = new CodeIdeHostService(db, keyOf)
    service.setRoomPackage(ROOM, 'ห้อง 401', cliPackage())
  })

  it('กรอง node_modules / .venv / .git ออกก่อนเก็บ (ไม่ส่งซ้ำ)', () => {
    const entries: VirtualEntry[] = [
      { path: 'src', kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false },
      entry('src/main.py', 'print(1)'),
      entry('node_modules/express/index.js', 'x'),
      entry('.venv/lib/a.py', 'x'),
      entry('answer.sql', 'SELECT 1;')
    ]
    const filtered = filterLibraryNoise(entries)
    expect(filtered.map((e) => e.path)).toEqual(['src', 'src/main.py', 'answer.sql'])
  })

  it('ปฏิเสธงานที่แก้ไฟล์ readOnly ของครู', () => {
    const res = service.ingestProjectSubmission({
      roomId: ROOM,
      studentId: '65010001',
      entries: [folder('src'), entry('src/main.py', 'print("hacked")')],
      serverTimestampMs: Date.now()
    })
    expect(res.accepted).toBe(false)
    expect(res.reason).toMatch(/READONLY_MODIFIED/)
  })

  it('รับงานที่ถูกต้อง → เก็บเข้ารหัส + อ่านกลับได้ครบ', async () => {
    const entries = [folder('src'), entry('src/main.py', 'print("hi")'), entry('src/extra.py', 'x = 1')]
    const res = service.ingestProjectSubmission({ roomId: ROOM, studentId: '65010001', entries, serverTimestampMs: Date.now() })
    expect(res.accepted).toBe(true)
    expect(res.fileCount).toBe(2)
    // ingest ยิง grading แบบ fire-and-forget — รอคิวตรวจจบ (package นี้ 0 tests จบใน ms)
    await vi.waitFor(() => {
      const s = service.workspaceStore.getSubmission(ROOM, '65010001', cliPackage().packageId)
      expect(s?.status).toBe('graded')
    })
    const stored = service.workspaceStore.getSubmission(ROOM, '65010001', cliPackage().packageId)
    expect(stored?.entries.map((e) => e.path).sort()).toEqual(['src', 'src/extra.py', 'src/main.py'])
    expect(stored?.status).toBe('graded')
  })

  it('แก้ไฟล์ .sqlite ตรง ๆ จับได้ (HMAC verify)', () => {
    service.ingestProjectSubmission({
      roomId: ROOM, studentId: '65010001',
      entries: [folder('src'), entry('src/main.py', 'print("hi")')],
      serverTimestampMs: Date.now()
    })
    db.db.prepare(`UPDATE code_submissions SET ciphertext = ? WHERE session_id = ?`).run('AAAA', ROOM)
    expect(() => service.workspaceStore.getSubmission(ROOM, '65010001', cliPackage().packageId)).toThrow()
  })

  it('manual grade นอกช่วงคะแนนถูกปฏิเสธ', () => {
    service.ingestProjectSubmission({
      roomId: ROOM, studentId: '65010001',
      entries: [folder('src'), entry('src/main.py', 'print("hi")')],
      serverTimestampMs: Date.now()
    })
    // package นี้มี 0 tests → maxPoints = 0 → ให้ 10 ต้องถูกปฏิเสธ
    const bad = service.manualGrade({ roomId: ROOM, studentId: '65010001', packageId: cliPackage().packageId, points: 10 })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toBe('POINTS_OUT_OF_RANGE')
  })

  it('setRoomPackage แตก offline libs จาก blobs → getDepsStatus รายงาน', () => {
    const withJar: CodeExamPackage = {
      ...cliPackage(),
      dependencies: [
        { bundleId: 'b-jar', ecosystem: 'maven-jar', packages: [{ name: 'gson.jar', version: '2.10' }], archiveRelativePath: 'vendor/maven-jar/gson.jar' },
        { bundleId: 'b-big', ecosystem: 'npm', packages: [{ name: 'huge', version: '1.0.0' }], archiveRelativePath: 'vendor/npm/huge.tar.zst' }
      ],
      blobs: {
        'vendor/maven-jar/gson.jar': { encoding: 'base64', dataBase64: Buffer.from('fake-jar-bytes').toString('base64') }
      }
    }
    service.setRoomPackage(ROOM, 'ห้อง 401', withJar)
    const status = service.getDepsStatus(ROOM)
    expect(status?.cached).toBe(true)
    expect(status?.unsupported.some((u) => u.includes('.tar.zst'))).toBe(true)
    const layout = service.getDepsCache(ROOM)
    expect(layout?.jarFiles).toHaveLength(1)
    expect(layout?.jarFiles[0]?.endsWith('gson.jar')).toBe(true)
  })

  it('ingestViaTransport รับ project JSON ผ่านท่อ LAN (ห้อง running)', async () => {
    db.db.prepare(`UPDATE exam_sessions SET status = 'running' WHERE id = ?`).run(ROOM)
    const payloadJson = JSON.stringify({
      type: 'code-ide.submit',
      entries: [folder('src'), entry('src/main.py', 'print("hi")')]
    })
    const res = await service.ingestViaTransport({
      roomId: ROOM,
      studentId: '65010001',
      kind: 'action',
      payloadJson,
      serverTimestampMs: Date.now()
    })
    expect(res.ok).toBe(true)
    expect(res.progressText).toBe('code-project-ingested')
    await vi.waitFor(() => {
      expect(service.workspaceStore.getSubmission(ROOM, '65010001', cliPackage().packageId)?.status).toBe('graded')
    })
  })

  it('ห้องไม่ running → ปฏิเสธ EXAM_NOT_RUNNING (fail-closed)', async () => {
    // beforeEach สร้างห้อง status 'ended' — ไม่ต้องแตะ
    const res = await service.ingestViaTransport({
      roomId: ROOM,
      studentId: '65010001',
      kind: 'action',
      payloadJson: JSON.stringify({ entries: [folder('src'), entry('src/main.py', 'print("hi")')] }),
      serverTimestampMs: Date.now()
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('EXAM_NOT_RUNNING')
  })

  it('regrade ทั้งห้องหลังแก้ package — คะแนน/จำนวนงานถูกต้อง', async () => {
    service.ingestProjectSubmission({
      roomId: ROOM, studentId: '65010001',
      entries: [folder('src'), entry('src/main.py', 'print("hi")')],
      serverTimestampMs: Date.now()
    })
    const summary = await service.regradeAllSubmissions(ROOM)
    expect(summary.students).toBe(1)
  })
})

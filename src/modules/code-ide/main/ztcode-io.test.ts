import { describe, expect, it } from 'vitest'
import { CodeExamPackageSchema, type CodeExamPackage } from '../shared/code-schema'
import { stripCodePackageForStudent } from '../shared/student-view'
import {
  buildZtcodeContainer,
  isZtcodeEncrypted,
  parseZtcodeContent,
  serializeEncrypted,
  serializeStandard,
  ZtcodeIntegrityError,
  ZtcodeWrongPasswordError
} from './ztcode-io'

const PKG_ID = '123e4567-e89b-12d3-a456-426614174000'

/** โฟลเดอร์ซ้อน 3 ชั้น: a/b/c + ไฟล์ — ใช้ร่วมทุกหมวด */
function nestedEntries(entryPoint: string, seedFile?: { path: string; content: string }) {
  const entries = [
    { path: 'src', kind: 'folder' as const },
    { path: 'src/level1', kind: 'folder' as const },
    { path: 'src/level1/level2', kind: 'folder' as const },
    { path: entryPoint, kind: 'file' as const, content: '// student code' },
    { path: 'tests/grade.hidden.ts', kind: 'file' as const, content: '// hidden', hiddenFromStudent: true }
  ]
  if (seedFile !== undefined) {
    entries.push({ path: 'db', kind: 'folder' as const })
    entries.push({ path: seedFile.path, kind: 'file' as const, content: seedFile.content })
  }
  return entries
}

function makePackage(overrides: { category: CodeExamPackage['category']; language: CodeExamPackage['language']; title: string; entryPoint: string }): CodeExamPackage {
  return CodeExamPackageSchema.parse({
    moduleId: 'code-ide',
    packageId: PKG_ID,
    title: overrides.title,
    instructions: 'do it',
    category: overrides.category,
    language: overrides.language,
    entries: nestedEntries(overrides.entryPoint, overrides.category === 'database' ? { path: 'db/seed.sql', content: 'CREATE TABLE users(id INTEGER);INSERT INTO users VALUES(1);' } : undefined),
    referenceSolution: [{ path: 'sol/answer.txt', kind: 'file', content: 'secret' }],
    policy: { entryPointPath: overrides.entryPoint },
    dependencies: overrides.category === 'backend'
      ? [{ bundleId: 'b-express', ecosystem: 'npm' as const, packages: [{ name: 'express', version: '4.19.2' }], archiveRelativePath: 'vendor/npm/express.tgz' }]
      : [],
    database: overrides.category === 'database'
      ? { enabled: true, engine: 'sqlite', seedSqlPath: 'db/seed.sql', allowDestructiveQueries: true, respawnFreshDbOnEveryRun: true, exposeDbViewerToStudent: true }
      : { enabled: false, engine: 'sqlite', allowDestructiveQueries: true, respawnFreshDbOnEveryRun: true, exposeDbViewerToStudent: true },
    testCases: [
      { testId: 'sample-1', kind: 'stdio' as const, title: 'sample', visibility: 'sample' as const, points: 5 },
      { testId: 'hidden-1', kind: 'stdio' as const, title: 'hidden', visibility: 'hidden' as const, points: 10 }
    ],
    blobs: overrides.category === 'backend'
      ? { 'vendor/npm/express.tgz': { encoding: 'base64' as const, dataBase64: Buffer.from('fake-tgz').toString('base64') } }
      : overrides.category === 'database'
        ? { 'db/school.sqlite': { encoding: 'base64' as const, dataBase64: Buffer.from('fake-sqlite').toString('base64') } }
        : {}
  })
}

const CASES: Array<{ category: CodeExamPackage['category']; language: CodeExamPackage['language']; title: string; entryPoint: string }> = [
  { category: 'cli-algorithm', language: 'java', title: 'CLI Java', entryPoint: 'src/level1/level2/Main.java' },
  { category: 'frontend', language: 'react', title: 'React UI', entryPoint: 'src/level1/level2/App.tsx' },
  { category: 'backend', language: 'node-backend', title: 'Express API', entryPoint: 'src/level1/level2/server.ts' },
  { category: 'database', language: 'sql-sqlite', title: 'SQL Shop', entryPoint: 'db/seed.sql' }
]

describe('Phase 8 — .ztcode Project & Dependency Archive Round-Trip', () => {
  for (const c of CASES) {
    it(`pack/load หมวด ${c.category} (${c.title}) ครบถ้วน`, () => {
      const pkg = makePackage(c)
      const container = buildZtcodeContainer({ codePackage: pkg, nowMs: 1_700_000_000_000 })
      const json = serializeStandard(container)
      const loaded = parseZtcodeContent(json)
      // โฟลเดอร์ซ้อน 3 ชั้นกลับมาครบ
      expect(loaded.codePackage.entries.some((e) => e.path === 'src/level1/level2')).toBe(true)
      expect(loaded.codePackage.entries.some((e) => e.path === c.entryPoint)).toBe(true)
      expect(loaded.manifest.totalTests).toBe(2)
      expect(loaded.manifest.totalPoints).toBe(15)
      if (c.category === 'database') {
        expect(loaded.codePackage.database.seedSqlPath).toBe('db/seed.sql')
        expect(loaded.codePackage.blobs['db/school.sqlite']?.dataBase64).toBe(Buffer.from('fake-sqlite').toString('base64'))
      }
      if (c.category === 'backend') {
        expect(loaded.codePackage.dependencies[0]?.packages[0]?.name).toBe('express')
        expect(loaded.codePackage.blobs['vendor/npm/express.tgz']).toBeDefined()
      }
    })
  }

  it('ตัดข้อมูล hidden ออกก่อนส่งนักเรียน (entries + hidden tests + solution + blobs)', () => {
    const pkg = makePackage(CASES[1]!)
    const container = buildZtcodeContainer({ codePackage: pkg, nowMs: 1_700_000_000_000 })
    const view = stripCodePackageForStudent(container.codePackage)
    expect(view.entries.some((e) => e.path === 'tests/grade.hidden.ts')).toBe(false)
    expect(view.sampleTests).toHaveLength(1)
    expect(JSON.stringify(view)).not.toContain('secret')
    expect(JSON.stringify(view)).not.toContain('fake-tgz')
  })

  it('ไฟล์ถูกแก้ (tamper) → INTEGRITY_BROKEN', () => {
    const pkg = makePackage(CASES[0]!)
    const container = buildZtcodeContainer({ codePackage: pkg, nowMs: 1_700_000_000_000 })
    const tampered = JSON.parse(serializeStandard(container)) as typeof container
    tampered.codePackage.title = 'ปลอม'
    expect(() => parseZtcodeContent(JSON.stringify(tampered))).toThrow(ZtcodeIntegrityError)
  })

  it('โหมดเข้ารหัส: round-trip + ผิดรหัสผ่าน', () => {
    const pkg = makePackage(CASES[2]!)
    const container = buildZtcodeContainer({ codePackage: pkg, nowMs: 1_700_000_000_000 })
    const enc = serializeEncrypted(container, 'teacher-1234')
    expect(isZtcodeEncrypted(enc)).toBe(true)
    expect(isZtcodeEncrypted(serializeStandard(container))).toBe(false)
    const loaded = parseZtcodeContent(enc, 'teacher-1234')
    expect(loaded.codePackage.title).toBe('Express API')
    expect(() => parseZtcodeContent(enc, 'wrong-pass')).toThrow(ZtcodeWrongPasswordError)
  })
})

import { describe, expect, it } from 'vitest'
import {
  CATEGORY_LANGUAGES,
  CodeExamPackageSchema,
  DatabaseConfigSchema,
  DependencyBundleSchema,
  DomTestCaseSchema,
  CliTestCaseSchema,
  HttpApiTestCaseSchema,
  ProjectCategorySchema,
  ProjectWorkspacePolicySchema,
  SqlTestCaseSchema,
  SupportedCodeLanguageSchema,
  VirtualEntrySchema,
  countCodePoints,
  monacoLanguageForPath
} from './code-schema'

describe('Phase 8.1.1 — ProjectCategory & SupportedLanguage', () => {
  it('รองรับหมวดครบ 5 ประเภท', () => {
    expect(ProjectCategorySchema.options).toEqual([
      'cli-algorithm',
      'frontend',
      'backend',
      'database',
      'fullstack'
    ])
  })

  it('รองรับภาษาครบ 17 สแต็ก', () => {
    expect(SupportedCodeLanguageSchema.options).toEqual([
      'c', 'cpp', 'rust', 'go', 'java', 'python', 'javascript', 'typescript', 'php',
      'html-css-js', 'react',
      'node-backend', 'python-backend', 'go-backend', 'php-backend', 'java-backend',
      'sql-sqlite'
    ])
  })

  it('ทุกหมวดมีภาษาแนะนำอย่างน้อย 1 ภาษา', () => {
    for (const cat of ProjectCategorySchema.options) {
      expect(CATEGORY_LANGUAGES[cat].length).toBeGreaterThan(0)
    }
  })

  it('map monaco language จากนามสกุลไฟล์', () => {
    expect(monacoLanguageForPath('src/App.tsx')).toBe('typescript')
    expect(monacoLanguageForPath('src/Main.java')).toBe('java')
    expect(monacoLanguageForPath('query.sql')).toBe('sql')
    expect(monacoLanguageForPath('Makefile')).toBe('plaintext')
  })
})

describe('Phase 8.1.2 — VirtualEntry & Policy', () => {
  it('ค่า default ของ entry (utf8 / แก้ได้ / มองเห็น)', () => {
    const e = VirtualEntrySchema.parse({ path: 'src/a.ts', kind: 'file', content: 'x' })
    expect(e.encoding).toBe('utf8')
    expect(e.readOnly).toBe(false)
    expect(e.allowStudentCreateInside).toBe(true)
    expect(e.hiddenFromStudent).toBe(false)
  })

  it('policy ต้องมี entryPoint และ limit ขนาด', () => {
    const p = ProjectWorkspacePolicySchema.parse({ entryPointPath: 'src/Main.java' })
    expect(p.maxProjectSizeBytes).toBe(10 * 1024 * 1024)
    expect(p.allowCreateFiles).toBe(true)
  })
})

describe('Phase 8.1.3 — Dependency & Database', () => {
  it('parse dependency bundle (npm/express)', () => {
    const b = DependencyBundleSchema.parse({
      bundleId: 'b1',
      ecosystem: 'npm',
      packages: [{ name: 'express', version: '4.19.2' }],
      archiveRelativePath: 'vendor/npm/express.tgz'
    })
    expect(b.packages).toHaveLength(1)
  })

  it('database config อนุญาต destructive + respawn เป็นค่าเริ่มต้น', () => {
    const d = DatabaseConfigSchema.parse({ enabled: true })
    expect(d.allowDestructiveQueries).toBe(true)
    expect(d.respawnFreshDbOnEveryRun).toBe(true)
  })
})

describe('Phase 8.1.4 — Test cases 4 หมวด', () => {
  it('CLI stdio', () => {
    const t = CliTestCaseSchema.parse({
      testId: 't1', kind: 'stdio', title: 'sum', stdin: '2 3',
      expectedStdout: '5', visibility: 'sample', points: 10
    })
    expect(t.timeoutMs).toBe(5000)
  })

  it('DOM assertion (frontend)', () => {
    const t = DomTestCaseSchema.parse({
      testId: 'd1', kind: 'dom-assertion', title: 'header renders',
      route: '/', assertionScript: 'expect(h1).toBeVisible()',
      visibility: 'sample', points: 5
    })
    expect(t.route).toBe('/')
  })

  it('HTTP API (backend)', () => {
    const t = HttpApiTestCaseSchema.parse({
      testId: 'h1', kind: 'http-api', title: 'POST /api/users → 201',
      requests: [{
        method: 'POST', path: '/api/users', expectedStatus: 201,
        expectedBodyMatcher: 'json-subset', expectedBody: '{"ok":true}'
      }],
      visibility: 'hidden', points: 20
    })
    expect(t.requests).toHaveLength(1)
  })

  it('SQL query (database)', () => {
    const t = SqlTestCaseSchema.parse({
      testId: 's1', kind: 'sql-query', title: 'avg salary',
      expectedColumns: ['dept', 'avg_sal'], expectedRows: [['IT', 60000]],
      visibility: 'sample', points: 15
    })
    expect(t.checkRowOrder).toBe(true)
  })

  it('นับคะแนนรวม', () => {
    const tests = [
      CliTestCaseSchema.parse({ testId: 'a', kind: 'stdio', title: 'a', visibility: 'sample', points: 10 }),
      SqlTestCaseSchema.parse({ testId: 'b', kind: 'sql-query', title: 'b', expectedColumns: ['c'], expectedRows: [], visibility: 'hidden', points: 5 })
    ]
    expect(countCodePoints(tests)).toBe(15)
  })
})

describe('CodeExamPackage — fullstack package', () => {
  it('parse แพ็กเกจ fullstack (frontend+backend+db) ได้', () => {
    const pkg = CodeExamPackageSchema.parse({
      moduleId: 'code-ide',
      packageId: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Fullstack Shop',
      category: 'fullstack',
      language: 'node-backend',
      entries: [
        { path: 'src', kind: 'folder' },
        { path: 'src/server.ts', kind: 'file', content: 'serve()' },
        { path: 'db', kind: 'folder' },
        { path: 'db/seed.sql', kind: 'file', content: 'CREATE TABLE users(id);' }
      ],
      policy: { entryPointPath: 'src/server.ts' },
      database: { enabled: true, seedSqlPath: 'db/seed.sql' },
      testCases: []
    })
    expect(pkg.entries).toHaveLength(4)
    expect(pkg.database.enabled).toBe(true)
  })
})

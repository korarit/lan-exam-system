import { describe, expect, it } from 'vitest'
import { CodeExamPackageSchema, ProjectWorkspacePolicySchema, type VirtualEntry } from './code-schema'
import {
  buildExplorerTree,
  computeProjectSizeBytes,
  createFileInTree,
  createFolderInTree,
  deleteEntryInTree,
  isLockedByReadOnly,
  moveEntryInTree,
  renameEntryInTree,
  updateFileContentInTree,
  validateProjectTree,
  ProjectTreePermissionError
} from './project-tree'
import { stripCodePackageForStudent } from './student-view'

const POLICY = ProjectWorkspacePolicySchema.parse({ entryPointPath: 'src/Main.java' })

function baseEntries(): VirtualEntry[] {
  return [
    { path: 'src', kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false },
    { path: 'src/Main.java', kind: 'file', content: 'class Main{}', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false },
    { path: 'core', kind: 'folder', encoding: 'utf8', readOnly: true, allowStudentCreateInside: false, hiddenFromStudent: false },
    { path: 'core/Engine.java', kind: 'file', content: 'engine', encoding: 'utf8', readOnly: true, allowStudentCreateInside: true, hiddenFromStudent: false },
    { path: 'tests/secret.java', kind: 'file', content: 'hidden', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: true }
  ]
}

describe('Phase 8 — Multi-Folder Tree Operations & Permission', () => {
  it('สร้างไฟล์พร้อมพาธย่อย (auto-create folders)', () => {
    const next = createFileInTree(baseEntries(), POLICY, 'components/cards/UserCard.tsx', 'export {}')
    expect(next.some((e) => e.path === 'components')).toBe(true)
    expect(next.some((e) => e.path === 'components/cards')).toBe(true)
    expect(next.some((e) => e.path === 'components/cards/UserCard.tsx')).toBe(true)
  })

  it('สร้างโฟลเดอร์ซ้อน 3 ชั้น', () => {
    const next = createFolderInTree(baseEntries(), POLICY, 'a/b/c')
    expect(next.some((e) => e.path === 'a/b/c')).toBe(true)
  })

  it('แก้ไข/ลบไฟล์ readOnly ถูกปฏิเสธ 100%', () => {
    expect(() => updateFileContentInTree(baseEntries(), 'core/Engine.java', 'hack')).toThrow(ProjectTreePermissionError)
    expect(() => deleteEntryInTree(baseEntries(), POLICY, 'core/Engine.java')).toThrow(ProjectTreePermissionError)
    expect(() => renameEntryInTree(baseEntries(), POLICY, 'core/Engine.java', 'core/Hack.java')).toThrow(ProjectTreePermissionError)
    // ลูกในโฟลเดอร์ readOnly ก็ถูกล็อกผ่าน ancestor
    expect(isLockedByReadOnly(baseEntries(), 'core/Engine.java')).toBe(true)
    expect(isLockedByReadOnly(baseEntries(), 'src/Main.java')).toBe(false)
  })

  it('สร้างไฟล์ในโฟลเดอร์ที่ห้าม (allowStudentCreateInside=false) ถูกปฏิเสธ', () => {
    expect(() => createFileInTree(baseEntries(), POLICY, 'core/NewFile.java', '')).toThrow(ProjectTreePermissionError)
  })

  it('rename ย้ายทั้ง subtree', () => {
    const withSub = createFileInTree(baseEntries(), POLICY, 'utils/a.ts', 'a')
    const renamed = renameEntryInTree(withSub, POLICY, 'utils', 'helpers')
    expect(renamed.some((e) => e.path === 'helpers/a.ts')).toBe(true)
    expect(renamed.some((e) => e.path === 'utils/a.ts')).toBe(false)
  })
})

describe('Phase 8 — move เข้า readOnly ถูกปฏิเสธ', () => {
  it('ย้ายไฟล์ปกติเข้าโฟลเดอร์ readOnly ไม่ได้', () => {
    expect(() => moveEntryInTree(baseEntries(), POLICY, 'src/Main.java', 'core')).toThrow(ProjectTreePermissionError)
  })

  it('ลบไฟล์ปกติได้ + ลบโฟลเดอร์ลบลูกทั้งหมด', () => {
    const withSub = createFileInTree(baseEntries(), POLICY, 'tmp/a.ts', 'a')
    const after = deleteEntryInTree(withSub, POLICY, 'tmp')
    expect(after.some((e) => e.path.startsWith('tmp'))).toBe(false)
  })
})

describe('Phase 8 — validate + explorer + strip', () => {
  it('validate จับ path ซ้ำ / ไฟล์ไร้โฟลเดอร์แม่', () => {
    const dup: VirtualEntry[] = [
      ...baseEntries(),
      { path: 'src/Main.java', kind: 'file', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
    ]
    const errors = validateProjectTree(dup)
    expect(errors.some((e) => e.reason === 'DUPLICATE')).toBe(true)

    const orphan: VirtualEntry[] = [
      { path: 'lonely/file.ts', kind: 'file', content: 'x', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
    ]
    expect(validateProjectTree(orphan).some((e) => e.reason === 'FILE_WITHOUT_PARENT')).toBe(true)
  })

  it('explorer tree เรียงโฟลเดอร์ก่อนไฟล์', () => {
    const tree = buildExplorerTree(baseEntries())
    expect(tree.length).toBeGreaterThan(0)
    expect(computeProjectSizeBytes(baseEntries())).toBeGreaterThan(0)
  })

  it('strip ตัด hidden entries ออกก่อนส่งนักเรียน', () => {
    const pkg = CodeExamPackageSchema.parse({
      moduleId: 'code-ide' as const,
      packageId: '123e4567-e89b-12d3-a456-426614174000',
      title: 'T',
      instructions: '',
      category: 'cli-algorithm' as const,
      language: 'java' as const,
      entries: baseEntries(),
      referenceSolution: [{ path: 'sol/Main.java', kind: 'file' as const, content: 'answer', encoding: 'utf8' as const, readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }],
      policy: POLICY,
      dependencies: [],
      database: { enabled: false, engine: 'sqlite' as const, allowDestructiveQueries: true, respawnFreshDbOnEveryRun: true, exposeDbViewerToStudent: true },
      testCases: [
        { testId: 's1', kind: 'stdio' as const, title: 'sample', visibility: 'sample' as const, points: 5 },
        { testId: 'h1', kind: 'stdio' as const, title: 'hidden', visibility: 'hidden' as const, points: 10 }
      ],
      blobs: {}
    })
    const view = stripCodePackageForStudent(pkg)
    expect(view.entries.some((e) => e.path === 'tests/secret.java')).toBe(false)
    expect(view.sampleTests).toHaveLength(1)
    expect(view.totalSamplePoints).toBe(5)
  })
})

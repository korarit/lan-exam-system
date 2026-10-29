import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  TeacherWorkspaceDirectoryManager,
  sanitizeFolderName,
  sanitizeQuestionSlug
} from './code-workspace-dirs'
import type { VirtualEntry } from '../shared/code-schema'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function file(pathInTree: string, content: string): VirtualEntry {
  return { path: pathInTree, kind: 'file', content, encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
}

describe('Phase 10.1 — TeacherWorkspaceDirectoryManager', () => {
  it('sanitize รหัสนักเรียนกัน path traversal', () => {
    expect(sanitizeFolderName('65010001')).toBe('65010001')
    expect(sanitizeFolderName('../../etc')).not.toContain('..')
    expect(sanitizeFolderName('../../etc')).not.toContain('/')
    expect(sanitizeFolderName('')).toBe('unknown_student')
  })

  it('สร้าง Subfolder <studentId> + sync ไฟล์/โฟลเดอร์ซ้อน 4 ชั้นครบ', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztcode-ws-'))
    tempDirs.push(root)
    const mgr = new TeacherWorkspaceDirectoryManager()
    mgr.setRootPath(root)
    const entries: VirtualEntry[] = [
      { path: 'src', kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false },
      { path: 'src/a', kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false },
      { path: 'src/a/b', kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false },
      { path: 'src/a/b/c', kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false },
      file('src/a/b/c/App.tsx', 'export default 1;'),
      file('src/utils/math.ts', 'export const add = 1;')
    ]
    const slug = sanitizeQuestionSlug('Q2_React_Dashboard', 'q2')
    const res = mgr.syncEntriesToDisk('65010001', slug, entries)
    expect(res.writtenFiles).toBe(2)
    expect(fs.existsSync(path.join(res.questionDir, 'src/a/b/c/App.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(res.questionDir, 'src/utils/math.ts'))).toBe(true)
    expect(res.questionDir.startsWith(path.join(root, '65010001'))).toBe(true)
  })

  it('ลบไฟล์ที่นักเรียนลบออกจากโปรเจกต์แล้ว แต่ห้ามแตะ grading-report.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztcode-ws-'))
    tempDirs.push(root)
    const mgr = new TeacherWorkspaceDirectoryManager()
    mgr.setRootPath(root)
    const slug = sanitizeQuestionSlug('Q1', 'q1')
    mgr.syncEntriesToDisk('65010002', slug, [file('keep.py', 'x = 1'), file('gone.py', 'y = 2')])
    mgr.writeGradingReport('65010002', slug, { passed: 1 })
    const res = mgr.syncEntriesToDisk('65010002', slug, [file('keep.py', 'x = 1')])
    expect(res.removedFiles).toBe(1)
    expect(fs.existsSync(path.join(res.questionDir, 'gone.py'))).toBe(false)
    expect(fs.existsSync(path.join(res.questionDir, 'grading-report.json'))).toBe(true)
  })

  it('healthCheck จับโฟลเดอร์หาย (ครูถอด drive)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztcode-ws-'))
    const mgr = new TeacherWorkspaceDirectoryManager()
    mgr.setRootPath(root)
    expect(mgr.healthCheck().ok).toBe(true)
    fs.rmSync(root, { recursive: true, force: true })
    expect(mgr.healthCheck().ok).toBe(false)
  })
})

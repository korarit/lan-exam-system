import {
  type ProjectWorkspacePolicy,
  type VirtualEntry
} from './code-schema'

/* ============================================================
 * Phase 8 (8.1.2 / 8.2.1) — VirtualProjectTree Operations (pure)
 * ใช้ร่วมกันทั้งฝั่งครู (Builder) และนักเรียน (IDE Workspace)
 * กฎสิทธิ์: readOnly ล็อกตัวเอง + ลูกทั้งหมด (ตรวจผ่าน ancestor)
 * ============================================================ */

export const MAX_PATH_DEPTH = 16

const JUNK_SEGMENTS = new Set(['.git', '.DS_Store', 'dist', 'build', '__pycache__'])

export interface TreeValidationError {
  path: string
  reason:
    | 'EMPTY_PATH'
    | 'ABSOLUTE_PATH'
    | 'BACKTRACK'
    | 'DOUBLE_SLASH'
    | 'DEPTH'
    | 'DUPLICATE'
    | 'FILE_WITHOUT_PARENT'
    | 'KIND_CONFLICT'
}

/** POSIX normalize เบื้องต้น (ไม่แตะเนื้อหาไฟล์) */
export function normalizeProjectPath(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/')
  p = p.replace(/\/+/g, '/')
  if (p.startsWith('./')) p = p.slice(2)
  if (p.endsWith('/') && p.length > 1) p = p.slice(0, -1)
  return p
}

export function isJunkPath(path: string): boolean {
  return normalizeProjectPath(path)
    .split('/')
    .some((seg) => JUNK_SEGMENTS.has(seg))
}

function parentOf(path: string): string | null {
  const i = path.lastIndexOf('/')
  return i < 0 ? null : path.slice(0, i)
}

/** ตรวจโครง tree ทั้งชุด (path ซ้ำ / ชนิดชนกัน / ไฟล์ไร้โฟลเดอร์แม่) */
export function validateProjectTree(entries: readonly VirtualEntry[]): TreeValidationError[] {
  const errors: TreeValidationError[] = []
  const byPath = new Map<string, VirtualEntry>()
  for (const e of entries) {
    const p = normalizeProjectPath(e.path)
    if (p.length === 0) {
      errors.push({ path: e.path, reason: 'EMPTY_PATH' })
      continue
    }
    if (p.startsWith('/')) {
      errors.push({ path: e.path, reason: 'ABSOLUTE_PATH' })
      continue
    }
    if (p.split('/').includes('..')) {
      errors.push({ path: e.path, reason: 'BACKTRACK' })
      continue
    }
    if (e.path.includes('//')) {
      errors.push({ path: e.path, reason: 'DOUBLE_SLASH' })
      continue
    }
    if (p.split('/').length > MAX_PATH_DEPTH) {
      errors.push({ path: e.path, reason: 'DEPTH' })
      continue
    }
    const prev = byPath.get(p)
    if (prev !== undefined) {
      if (prev.kind !== e.kind) errors.push({ path: e.path, reason: 'KIND_CONFLICT' })
      else errors.push({ path: e.path, reason: 'DUPLICATE' })
      continue
    }
    byPath.set(p, e)
  }
  // ไฟล์ทุกไฟล์ต้องมีโฟลเดอร์แม่ครบ (builder อาจลืมสร้าง folder entry)
  for (const e of entries) {
    if (e.kind !== 'file') continue
    let parent = parentOf(normalizeProjectPath(e.path))
    while (parent !== null) {
      const folder = byPath.get(parent)
      if (folder === undefined) {
        errors.push({ path: e.path, reason: 'FILE_WITHOUT_PARENT' })
        break
      }
      if (folder.kind !== 'folder') {
        errors.push({ path: e.path, reason: 'KIND_CONFLICT' })
        break
      }
      parent = parentOf(parent)
    }
  }
  return errors
}

export function findEntry(entries: readonly VirtualEntry[], path: string): VirtualEntry | undefined {
  const p = normalizeProjectPath(path)
  return entries.find((e) => normalizeProjectPath(e.path) === p)
}

export function listVisibleForStudent(entries: readonly VirtualEntry[]): VirtualEntry[] {
  return entries.filter((e) => !e.hiddenFromStudent)
}

/** true ถ้า path นี้ถูกล็อก (ตัวเองหรือ ancestor ใด ๆ readOnly) */
export function isLockedByReadOnly(entries: readonly VirtualEntry[], path: string): boolean {
  const p = normalizeProjectPath(path)
  const parts = p.split('/')
  for (let i = parts.length; i >= 1; i--) {
    const ancestor = parts.slice(0, i).join('/')
    const node = entries.find((e) => normalizeProjectPath(e.path) === ancestor)
    if (node?.readOnly === true) return true
  }
  return false
}

/** ขนาดโปรเจกต์รวม (utf8 = byte length, base64 = decoded length) — ไม่รวม blobs ไลบรารี */
export function computeProjectSizeBytes(entries: readonly VirtualEntry[]): number {
  const encoder = new TextEncoder()
  let total = 0
  for (const e of entries) {
    if (e.kind !== 'file' || e.content === undefined) continue
    if (e.encoding === 'base64') total += Math.floor((e.content.length * 3) / 4)
    else total += encoder.encode(e.content).length
  }
  return total
}

export class ProjectTreePermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectTreePermissionError'
  }
}

export class ProjectTreeLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectTreeLimitError'
  }
}

function assertCanCreateInside(
  entries: readonly VirtualEntry[],
  policy: ProjectWorkspacePolicy,
  dirPath: string | null,
  what: 'file' | 'folder'
): void {
  if (what === 'file' && !policy.allowCreateFiles) throw new ProjectTreePermissionError('CREATE_FILE_DENIED')
  if (what === 'folder' && !policy.allowCreateFolders) throw new ProjectTreePermissionError('CREATE_FOLDER_DENIED')
  if (dirPath !== null) {
    const dir = findEntry(entries, dirPath)
    if (dir !== undefined && dir.kind === 'folder' && dir.allowStudentCreateInside === false) {
      throw new ProjectTreePermissionError('CREATE_INSIDE_DENIED')
    }
    if (isLockedByReadOnly(entries, dirPath)) throw new ProjectTreePermissionError('READONLY_LOCKED')
  }
}

/** สร้างไฟล์ (สร้างโฟลเดอร์แม่ที่ขาดให้อัตโนมัติ — ทั้งใน IDE และโฟลเดอร์จริงบนดิสก์) */
export function createFileInTree(
  entries: readonly VirtualEntry[],
  policy: ProjectWorkspacePolicy,
  path: string,
  content: string = ''
): VirtualEntry[] {
  const p = normalizeProjectPath(path)
  if (p.length === 0 || p.startsWith('/') || p.split('/').includes('..')) {
    throw new ProjectTreePermissionError('INVALID_PATH')
  }
  if (findEntry(entries, p) !== undefined) throw new ProjectTreePermissionError('ALREADY_EXISTS')
  const parent = parentOf(p)
  assertCanCreateInside(entries, policy, parent, 'file')
  const next = [...entries]
  // เติม folder entry ที่ขาดทั้งสาย
  if (parent !== null) {
    const parts = parent.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const folderPath = parts.slice(0, i).join('/')
      if (findEntry(next, folderPath) === undefined) {
        const grandParent = parentOf(folderPath)
        assertCanCreateInside(next, policy, grandParent, 'folder')
        next.push({
          path: folderPath,
          kind: 'folder',
          encoding: 'utf8',
          readOnly: false,
          allowStudentCreateInside: true,
          hiddenFromStudent: false
        })
      }
    }
  }
  next.push({
    path: p,
    kind: 'file',
    content,
    encoding: 'utf8',
    readOnly: false,
    allowStudentCreateInside: true,
    hiddenFromStudent: false
  })
  enforceSizeLimit(next, policy)
  return next
}

export function createFolderInTree(
  entries: readonly VirtualEntry[],
  policy: ProjectWorkspacePolicy,
  path: string
): VirtualEntry[] {
  const p = normalizeProjectPath(path)
  if (p.length === 0 || p.startsWith('/') || p.split('/').includes('..')) {
    throw new ProjectTreePermissionError('INVALID_PATH')
  }
  if (findEntry(entries, p) !== undefined) throw new ProjectTreePermissionError('ALREADY_EXISTS')
  const parent = parentOf(p)
  assertCanCreateInside(entries, policy, parent, 'folder')
  const next = [...entries]
  if (parent !== null) {
    const parts = parent.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const folderPath = parts.slice(0, i).join('/')
      if (findEntry(next, folderPath) === undefined) {
        next.push({
          path: folderPath,
          kind: 'folder',
          encoding: 'utf8',
          readOnly: false,
          allowStudentCreateInside: true,
          hiddenFromStudent: false
        })
      }
    }
  }
  next.push({
    path: p,
    kind: 'folder',
    encoding: 'utf8',
    readOnly: false,
    allowStudentCreateInside: true,
    hiddenFromStudent: false
  })
  return next
}

export function renameEntryInTree(
  entries: readonly VirtualEntry[],
  policy: ProjectWorkspacePolicy,
  oldPath: string,
  newPath: string
): VirtualEntry[] {
  if (!policy.allowDeleteRename) throw new ProjectTreePermissionError('RENAME_DENIED_BY_POLICY')
  const from = normalizeProjectPath(oldPath)
  const to = normalizeProjectPath(newPath)
  const node = findEntry(entries, from)
  if (node === undefined) throw new ProjectTreePermissionError('NOT_FOUND')
  if (findEntry(entries, to) !== undefined) throw new ProjectTreePermissionError('ALREADY_EXISTS')
  if (isLockedByReadOnly(entries, from)) throw new ProjectTreePermissionError('READONLY_LOCKED')
  if (to.startsWith('/') || to.split('/').includes('..')) throw new ProjectTreePermissionError('INVALID_PATH')
  const newParent = parentOf(to)
  if (newParent !== null && isLockedByReadOnly(entries, newParent)) {
    throw new ProjectTreePermissionError('READONLY_LOCKED')
  }
  return entries.map((e) => {
    const ep = normalizeProjectPath(e.path)
    if (ep === from || ep.startsWith(`${from}/`)) {
      const rest = ep.slice(from.length)
      return { ...e, path: `${to}${rest}` }
    }
    return e
  })
}

export function deleteEntryInTree(
  entries: readonly VirtualEntry[],
  policy: ProjectWorkspacePolicy,
  path: string
): VirtualEntry[] {
  if (!policy.allowDeleteRename) throw new ProjectTreePermissionError('DELETE_DENIED_BY_POLICY')
  const p = normalizeProjectPath(path)
  const node = findEntry(entries, p)
  if (node === undefined) throw new ProjectTreePermissionError('NOT_FOUND')
  if (isLockedByReadOnly(entries, p)) throw new ProjectTreePermissionError('READONLY_LOCKED')
  return entries.filter((e) => {
    const ep = normalizeProjectPath(e.path)
    return ep !== p && !ep.startsWith(`${p}/`)
  })
}

export function moveEntryInTree(
  entries: readonly VirtualEntry[],
  policy: ProjectWorkspacePolicy,
  sourcePath: string,
  destDirPath: string
): VirtualEntry[] {
  const base = normalizeProjectPath(sourcePath).split('/').pop() ?? sourcePath
  const destDir = normalizeProjectPath(destDirPath)
  const dest = destDir.length === 0 ? base : `${destDir}/${base}`
  return renameEntryInTree(entries, policy, sourcePath, dest)
}

export function updateFileContentInTree(
  entries: readonly VirtualEntry[],
  path: string,
  content: string
): VirtualEntry[] {
  const p = normalizeProjectPath(path)
  const node = findEntry(entries, p)
  if (node === undefined || node.kind !== 'file') throw new ProjectTreePermissionError('NOT_FOUND')
  if (isLockedByReadOnly(entries, p)) throw new ProjectTreePermissionError('READONLY_LOCKED')
  return entries.map((e) =>
    normalizeProjectPath(e.path) === p ? { ...e, content, encoding: 'utf8' as const } : e
  )
}

function enforceSizeLimit(entries: readonly VirtualEntry[], policy: ProjectWorkspacePolicy): void {
  if (computeProjectSizeBytes(entries) > policy.maxProjectSizeBytes) {
    throw new ProjectTreeLimitError('PROJECT_SIZE_EXCEEDED')
  }
}

/** จัด entries เป็นต้นไม้สำหรับ File Explorer (sort: โฟลเดอร์ก่อนไฟล์) */
export interface ProjectTreeNode {
  name: string
  path: string
  entry: VirtualEntry
  children: ProjectTreeNode[]
}

export function buildExplorerTree(entries: readonly VirtualEntry[]): ProjectTreeNode[] {
  const sorted = [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return normalizeProjectPath(a.path).localeCompare(normalizeProjectPath(b.path))
  })
  const nodeByPath = new Map<string, ProjectTreeNode>()
  const roots: ProjectTreeNode[] = []
  for (const e of sorted) {
    const p = normalizeProjectPath(e.path)
    const node: ProjectTreeNode = {
      name: p.split('/').pop() ?? p,
      path: p,
      entry: e,
      children: []
    }
    nodeByPath.set(p, node)
    const parent = parentOf(p)
    if (parent === null) {
      roots.push(node)
    } else {
      const parentNode = nodeByPath.get(parent)
      if (parentNode !== undefined) parentNode.children.push(node)
      else roots.push(node)
    }
  }
  return roots
}

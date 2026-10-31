import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { VirtualEntry } from '../shared/code-schema'
import { assertPathInside, buildSandboxEnv } from './anti-delete-guard'
import type { DepsCacheLayout } from './code-deps-cache'

/* Phase 9 (9.3) — Workspace Materializer & Offline Library Linker
 * - เขียน VirtualProjectTree ลง Isolated Run Directory (os.tmpdir/ztcode-exec-<runId>)
 * - กัน path traversal ทุก entry
 * - เชื่อม offline libs: node (symlink/junction), python (PYTHONPATH), java (classpath)
 */

export interface MaterializeResult {
  runDir: string
  writtenFiles: string[]
  env: NodeJS.ProcessEnv
  /** env เสริมจาก offline libs (PYTHONPATH / NODE_PATH) — ผู้เรียก merge เข้า spawn env */
  linkEnv: Record<string, string>
  /** .jar จาก DependencyBundle — ผู้เรียกต่อท้าย -cp ตอน javac/java */
  javaCpExtras: string[]
}

export function materializeExecutionSandbox(
  entries: readonly VirtualEntry[],
  opts: {
    runId?: string
    teacherOriginals?: readonly VirtualEntry[]
    extraEnv?: Record<string, string>
    /** offline libs ที่แตกจาก blobs แล้ว (undefined = ไม่มี — รันด้วยโค้ดนักเรียนล้วน) */
    depsCache?: DepsCacheLayout | undefined
  } = {}
): MaterializeResult {
  const runId = opts.runId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // realpath: กัน 8.3 short name บน Windows (เช่น MSI_GA~1) ที่ทำให้ open_basedir ไม่ตรง
  let rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztcode-exec-'))
  try {
    // .native คืน long path บน Windows (กัน MSI_GA~1 ที่ทำให้ PHP open_basedir เพี้ยน)
    rootDir = fs.realpathSync.native(rootDir)
  } catch {
    // FS ไม่รองรับ realpath — ใช้ path เดิม
  }
  const runDir = path.join(rootDir, runId)
  fs.mkdirSync(runDir, { recursive: true })
  // POSIX: ปิดสิทธิ์กลุ่ม/อื่นไม่ให้อ่านไฟล์งานนักเรียน (Windows ใช้ ACL ของ user อยู่แล้ว)
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(runDir, 0o700)
    } catch {
      // FS ไม่รองรับ chmod (เช่น FAT) — ข้าม
    }
  }
  const linkEnv: Record<string, string> = {}
  const javaCpExtras: string[] = []
  if (opts.depsCache !== undefined) {
    // node: junction เร็ว <5ms (+ NODE_PATH fallback กัน symlink ถูกบล็อก)
    if (opts.depsCache.nodeModulesDir !== undefined) {
      linkNodeModules(runDir, opts.depsCache.nodeModulesDir)
      linkEnv.NODE_PATH = [opts.depsCache.nodeModulesDir, linkEnv.NODE_PATH ?? process.env.NODE_PATH ?? '']
        .filter((s) => s !== '')
        .join(path.delimiter)
    }
    if (opts.depsCache.sitePackagesDirs.length > 0) {
      linkEnv.PYTHONPATH = pythonPathFor(runDir, opts.depsCache.sitePackagesDirs.join(path.delimiter))
    }
    javaCpExtras.push(...opts.depsCache.jarFiles)
  }

  // รวม teacher originals (readOnly/hidden) ทับเสมอ — กันนักเรียนแก้ไฟล์ล็อกผ่านดิสก์
  const merged = new Map<string, VirtualEntry>()
  for (const e of entries) merged.set(e.path, e)
  if (opts.teacherOriginals !== undefined) {
    for (const t of opts.teacherOriginals) {
      if (t.readOnly === true || t.hiddenFromStudent === true) merged.set(t.path, t)
    }
  }

  const writtenFiles: string[] = []
  for (const e of merged.values()) {
    assertPathInside(runDir, e.path)
    const abs = path.join(runDir, e.path)
    if (e.kind === 'folder') {
      fs.mkdirSync(abs, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if (e.encoding === 'base64') {
      fs.writeFileSync(abs, Buffer.from(e.content ?? '', 'base64'))
    } else {
      fs.writeFileSync(abs, e.content ?? '', 'utf8')
    }
    writtenFiles.push(e.path)
  }
  return { runDir, writtenFiles, env: buildSandboxEnv(runDir, opts.extraEnv), linkEnv, javaCpExtras }
}

/** ล้าง runDir หลังรันเสร็จ (คืนพอร์ต/ดิสก์) — เรียกใน finally เสมอ */
export function teardownRunDir(runDir: string): void {
  try {
    fs.rmSync(runDir, { recursive: true, force: true })
  } catch {
    // ลบไม่ได่ไม่ถือว่าพัง (OS ล็อกชั่วคราว) — tmp จะถูก GC โดย OS
  }
}

/** เชื่อม node_modules แบบ offline: symlink/junction ไปยัง deps cache (เร็ว < 5ms) */
export function linkNodeModules(runDir: string, depsCacheDir: string): void {
  try {
    const target = path.join(runDir, 'node_modules')
    if (fs.existsSync(target)) return
    const stat = fs.statSync(depsCacheDir)
    if (!stat.isDirectory()) return
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    fs.symlinkSync(depsCacheDir, target, type)
  } catch {
    // ลิงก์ไม่ได้ให้ fallback เป็น NODE_PATH (ผู้เรียกตั้ง env เพิ่ม)
  }
}

/** PYTHONPATH สำหรับ import ข้ามโฟลเดอร์ + offline wheels */
export function pythonPathFor(runDir: string, offlineSitePackages?: string): string {
  return offlineSitePackages !== undefined && offlineSitePackages !== ''
    ? `${runDir}${path.delimiter}${offlineSitePackages}`
    : runDir
}

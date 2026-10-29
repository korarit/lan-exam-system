import fs from 'node:fs'
import path from 'node:path'
import type { VirtualEntry } from '../shared/code-schema'
import { assertPathInside } from './anti-delete-guard'

/* ============================================================
 * Phase 10 (10.1) — TeacherWorkspaceDirectoryManager
 * ครูเลือกโฟลเดอร์หลัก 1 โฟลเดอร์บนเครื่องแม่ แล้วระบบสร้าง
 * Subfolder ตามรหัสนักเรียน (<root>/<studentId>/) ให้อัตโนมัติ
 * พร้อมซิงก์โครงไฟล์/โฟลเดอร์ของนักเรียนลงดิสก์ครูทันทีที่ส่งงาน
 *
 * กติาความปลอดภัย (Vault Anti-Delete Protection):
 * - โฟลเดอร์นี้เป็น "คลังเก็บงาน" เท่านั้น ห้ามรันโค้ดข้างในเด็ดขาด
 * - GradingWorkerQueue จะคัดลอกไปรันใน tmp (AntiDeleteRuntimeGuard) เสมอ
 * ============================================================ */

const TEMPLATE_DIR_NAME = '_teacher_template'

/** ทำความสะอาดรหัสนักเรียนก่อนใช้เป็นชื่อโฟลเดอร์ (กัน ../ และอักขระพิเศษ) */
export function sanitizeFolderName(studentId: string): string {
  const cleaned = studentId
    .trim()
    .replace(/[\\/]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/[^a-zA-Z0-9 _\-.]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 64)
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return 'unknown_student'
  return cleaned
}

/** slug ของข้อสอบสำหรับชื่อโฟลเดอร์ย่อย (เช่น Q1_Java_OOP_Shop) */
export function sanitizeQuestionSlug(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/[^a-zA-Z0-9 _\-.]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
  return cleaned.length > 0 ? cleaned : fallback
}

export interface WorkspaceSyncResult {
  studentDir: string
  questionDir: string
  writtenFiles: number
  removedFiles: number
}

export class TeacherWorkspaceDirectoryManager {
  private rootPath: string | null = null

  /** ครูเลือกโฟลเดอร์หลัก (ผ่าน dialog ฝั่ง IPC — main ตรวจว่าเป็นโฟลเดอร์จริง) */
  setRootPath(dirPath: string): void {
    const stat = fs.statSync(dirPath)
    if (!stat.isDirectory()) throw new Error('WORKSPACE_ROOT_NOT_A_DIRECTORY')
    this.rootPath = path.resolve(dirPath)
    fs.mkdirSync(path.join(this.rootPath, TEMPLATE_DIR_NAME), { recursive: true })
  }

  getRootPath(): string | null {
    return this.rootPath
  }

  /** โฟลเดอร์ย่อยของนักเรียน (<root>/<studentId>/) — สร้างรอไว้ทันทีที่เข้าห้อง */
  ensureStudentDir(studentId: string): string {
    const root = this.requireRoot()
    const dir = path.join(root, sanitizeFolderName(studentId))
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  studentDir(studentId: string): string | null {
    if (this.rootPath === null) return null
    return path.join(this.rootPath, sanitizeFolderName(studentId))
  }

  questionDir(studentId: string, questionSlug: string): string {
    return path.join(this.ensureStudentDir(studentId), questionSlug)
  }

  /**
   * ซิงก์ snapshot ของ VirtualProjectTree ลงโฟลเดอร์ <root>/<studentId>/<slug>/
   * - เขียนไฟล์/สร้างโฟลเดอร์ทั้งหมดใน snapshot
   * - ลบไฟล์บนดิสก์ที่ไม่อยู่ใน snapshot แล้ว (ยกเว้น grading-report.json)
   */
  syncEntriesToDisk(studentId: string, questionSlug: string, entries: readonly VirtualEntry[]): WorkspaceSyncResult {
    const dir = this.questionDir(studentId, questionSlug)
    fs.mkdirSync(dir, { recursive: true })

    const wantedFiles = new Set<string>()
    const wantedDirs = new Set<string>()
    let writtenFiles = 0
    for (const e of entries) {
      assertPathInside(dir, e.path)
      if (e.kind === 'folder') {
        wantedDirs.add(e.path)
        fs.mkdirSync(path.join(dir, e.path), { recursive: true })
        continue
      }
      wantedFiles.add(e.path)
      const abs = path.join(dir, e.path)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      if (e.encoding === 'base64') fs.writeFileSync(abs, Buffer.from(e.content ?? '', 'base64'))
      else fs.writeFileSync(abs, e.content ?? '', 'utf8')
      writtenFiles += 1
    }

    // ลบสิ่งที่นักเรียนลบออกจากโปรเจกต์แล้ว (กันไฟล์เก่าค้าง) — ห้ามแตะ grading-report.json
    let removedFiles = 0
    for (const absPath of listFilesRecursive(dir)) {
      const rel = path.relative(dir, absPath).split(path.sep).join('/')
      if (rel === 'grading-report.json') continue
      if (!wantedFiles.has(rel)) {
        try {
          fs.rmSync(absPath, { force: true })
          removedFiles += 1
        } catch {
          /* ลบไม่ได้ — ข้าม */
        }
      }
    }
    // เก็บโฟลเดอร์เปล่าที่นักเรียนสร้างไว้ (ไม่ลบโฟลเดอร์ — กันลบ grading artifacts)
    void wantedDirs
    return { studentDir: path.dirname(dir), questionDir: dir, writtenFiles, removedFiles }
  }

  /** บันทึก grading-report.json ข้าง ๆ งานนักเรียน (ห้ามถูก sync รอบถัดไปลบ) */
  writeGradingReport(studentId: string, questionSlug: string, report: unknown): string {
    const dir = this.questionDir(studentId, questionSlug)
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, 'grading-report.json')
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8')
    return filePath
  }

  writeSummaryScores(summaryCsvUtf8Bom: string): string {
    const root = this.requireRoot()
    const filePath = path.join(root, 'summary-scores.csv')
    fs.writeFileSync(filePath, summaryCsvUtf8Bom, 'utf8')
    return filePath
  }

  /** ตรวจว่าโฟลเดอร์ที่ครูเลือกยังอยู่ (เช่น ครูถอด flash drive ออกระหว่างสอบ) */
  healthCheck(): { ok: boolean; reason?: string } {
    if (this.rootPath === null) return { ok: false, reason: 'WORKSPACE_NOT_CONFIGURED' }
    try {
      const stat = fs.statSync(this.rootPath)
      if (!stat.isDirectory()) return { ok: false, reason: 'WORKSPACE_ROOT_MISSING' }
      return { ok: true }
    } catch {
      return { ok: false, reason: 'WORKSPACE_ROOT_MISSING' }
    }
  }

  private requireRoot(): string {
    if (this.rootPath === null) throw new Error('WORKSPACE_NOT_CONFIGURED')
    return this.rootPath
  }
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  let children: fs.Dirent[]
  try {
    children = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const child of children) {
    const abs = path.join(dir, child.name)
    if (child.isDirectory()) out.push(...listFilesRecursive(abs))
    else if (child.isFile()) out.push(abs)
  }
  return out
}

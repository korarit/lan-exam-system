import { createHash } from 'node:crypto'
import {
  CodeExamPackageSchema,
  type CodeExamPackage,
  type VirtualEntry
} from '../shared/code-schema'
import { computeProjectSizeBytes, validateProjectTree } from '../shared/project-tree'
import { stripCodePackageForStudent } from '../shared/student-view'
import os from 'node:os'
import path from 'node:path'
import { CodeWorkspaceStore } from './code-workspace-store'
import { TeacherWorkspaceDirectoryManager, sanitizeQuestionSlug } from './code-workspace-dirs'
import { GradingWorkerQueue, defaultMaxConcurrentRuns, type GradeReport } from './code-grader-queue'
import { materializeDependencyCache, pickStudentBlobs, type DepsCacheLayout } from './code-deps-cache'
import type { HostDatabase } from '@main/storage/db'

/* ============================================================
 * Phase 10 (10.1/10.2) — CodeIdeHostService (Embedded Backend ฝั่งเครื่องแม่)
 * ท่อการผลิตเดียว: รับโปรเจกต์ (IPC/LAN ingest) → validate + กรอง libs
 * → SQLite เข้ารหัส + sync ลง <TeacherWorkspaceFolder>/<studentId>/ →
 * GradingWorkerQueue (hidden tests) → Dashboard / Export / Re-grade
 * ============================================================ */

/** โฟลเดอร์/ไฟล์ไลบรารีที่ไม่ต้องส่งซ้ำ (ครูมีใน DependencyBundle แล้ว) */
const STRIPPED_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.git',
  'dist',
  'build',
  'target',
  // workspace config ที่อาจสั่งรันโค้ดเมื่อครูเปิดโฟลเดอร์ (ไม่ใช่ของงานนักเรียน)
  '.vscode',
  '.devcontainer',
  '.idea',
  '.husky'
])
const STRIPPED_FILES = new Set(['.ds_store'])

export interface CodeRoomContext {
  roomId: string
  roomName: string
  examPackage: CodeExamPackage
  questionSlug: string
}

export interface IngestProjectInput {
  roomId: string
  studentId: string
  entries: unknown
  serverTimestampMs: number
}

export interface IngestProjectResult {
  accepted: boolean
  fileCount: number
  projectBytes: number
  reason?: string
}

function isStrippedPath(path: string): boolean {
  const segs = path.split('/')
  if (segs.some((s) => STRIPPED_DIRS.has(s.toLowerCase()))) return true
  const base = (segs[segs.length - 1] ?? '').toLowerCase()
  return STRIPPED_FILES.has(base)
}

export function filterLibraryNoise(entries: VirtualEntry[]): VirtualEntry[] {
  return entries.filter((e) => !isStrippedPath(e.path))
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export class CodeIdeHostService {
  private readonly store: CodeWorkspaceStore
  private readonly dirs = new TeacherWorkspaceDirectoryManager()
  private readonly grader: GradingWorkerQueue
  private readonly rooms = new Map<string, CodeRoomContext>()
  /** offline libs ที่แตกจาก blobs แล้ว (ต่อห้อง) — ส่งเข้า grader ทุกครั้ง */
  private readonly depsByRoom = new Map<string, DepsCacheLayout>()
  /** กันยิง grading ซ้ำซ้อนของงานชิ้นเดิม (studentId+packageId+hash) */
  private readonly gradingInFlight = new Set<string>()
  /** F-3b: manifest ที่นักเรียนรายงานหลัง pip/npm install (key = roomId + studentId) */
  private readonly installManifests = new Map<string, { packages: string[]; atMs: number }>()

  constructor(
    private readonly db: HostDatabase,
    getStorageKey: (roomId: string) => Buffer,
    maxConcurrentRuns: number = defaultMaxConcurrentRuns()
  ) {
    this.store = new CodeWorkspaceStore(db, getStorageKey)
    this.grader = new GradingWorkerQueue(maxConcurrentRuns)
  }

  get dirsManager(): TeacherWorkspaceDirectoryManager {
    return this.dirs
  }

  get workspaceStore(): CodeWorkspaceStore {
    return this.store
  }

  /* ---------- โปรเจกต์โจทย์ของห้อง ---------- */

  setRoomPackage(roomId: string, roomName: string, examPackage: CodeExamPackage): void {
    const parsed = CodeExamPackageSchema.parse(examPackage)
    this.rooms.set(roomId, {
      roomId,
      roomName,
      examPackage: parsed,
      questionSlug: sanitizeQuestionSlug(`${parsed.title}`, parsed.packageId.slice(0, 8))
    })
    // แตก offline libs จาก blobs ลง cache ครั้งเดียว (grading/รันครั้งถัดไปลิงก์เข้า runDir)
    try {
      const layout = materializeDependencyCache(parsed, path.join(os.tmpdir(), 'ztcode-deps-cache'))
      this.depsByRoom.set(roomId, layout)
    } catch {
      this.depsByRoom.delete(roomId)
    }
  }

  /** layout ของ offline libs ต่อห้อง (ส่งเข้า grader / probe) */
  getDepsCache(roomId: string): DepsCacheLayout | undefined {
    return this.depsByRoom.get(roomId)
  }

  /** สถานะ cache ของ offline libs (ให้ UI เตือนครูถ้ามี archive ที่ใช้ไม่ได้) */
  getDepsStatus(roomId: string): { cached: boolean; unsupported: string[] } | null {
    const room = this.rooms.get(roomId)
    if (!room) return null
    if (room.examPackage.dependencies.length === 0) return { cached: false, unsupported: [] }
    const layout = this.depsByRoom.get(roomId)
    if (!layout) return { cached: false, unsupported: ['แตก cache ไม่สำเร็จ — ตรวจ/รันจะใช้โค้ดนักเรียนล้วน'] }
    return { cached: true, unsupported: layout.unsupported }
  }

  getRoomPackage(roomId: string): CodeRoomContext | null {
    return this.rooms.get(roomId) ?? null
  }

  /* ---------- 10.1.3 รับ autosave + ส่งงาน ---------- */

  ingestAutosave(input: IngestProjectInput): IngestProjectResult {
    const room = this.rooms.get(input.roomId)
    if (!room) return { accepted: false, fileCount: 0, projectBytes: 0, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    const checked = checkEntries(input.entries, room.examPackage)
    if (!checked.ok) return { accepted: false, fileCount: 0, projectBytes: 0, reason: checked.reason }
    const entries = filterLibraryNoise(checked.entries)
    const projectBytes = computeProjectSizeBytes(entries)
    this.store.upsertDraft({
      roomId: input.roomId,
      studentId: input.studentId,
      packageId: room.examPackage.packageId,
      entries,
      projectBytes,
      updatedAtMs: input.serverTimestampMs > 0 ? input.serverTimestampMs : Date.now()
    })
    // ซิงก์ลงโฟลเดอร์ครูทันที (best-effort — ครูยังไม่เลือกโฟลเดอร์ = ข้าม)
    try {
      if (this.dirs.getRootPath()) {
        this.dirs.syncEntriesToDisk(input.studentId, room.questionSlug, entries)
      }
    } catch {
      /* ดิสก์ครูมีปัญหา — draft ใน SQLite ยังอยู่ */
    }
    const fileCount = entries.filter((e) => e.kind === 'file').length
    return { accepted: true, fileCount, projectBytes }
  }

  /** นักเรียนกดส่งงาน → validate → เก็บเข้ารหัส + sync ดิสก์ครู → เข้าคิวตรวจ */
  ingestProjectSubmission(input: IngestProjectInput): IngestProjectResult {
    const room = this.rooms.get(input.roomId)
    if (!room) return { accepted: false, fileCount: 0, projectBytes: 0, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    const checked = checkEntries(input.entries, room.examPackage)
    if (!checked.ok) return { accepted: false, fileCount: 0, projectBytes: 0, reason: checked.reason }
    const entries = filterLibraryNoise(checked.entries)
    const projectBytes = computeProjectSizeBytes(entries)
    if (projectBytes > room.examPackage.policy.maxProjectSizeBytes) {
      return { accepted: false, fileCount: 0, projectBytes, reason: 'PROJECT_SIZE_EXCEEDED' }
    }
    const nowMs = input.serverTimestampMs > 0 ? input.serverTimestampMs : Date.now()
    this.store.upsertSubmission({
      roomId: input.roomId,
      studentId: input.studentId,
      packageId: room.examPackage.packageId,
      status: 'queued',
      earnedPoints: 0,
      passedCount: 0,
      totalCount: room.examPackage.testCases.length,
      fileCount: entries.filter((e) => e.kind === 'file').length,
      entries,
      submittedAtMs: nowMs,
      updatedAtMs: nowMs
    })
    try {
      if (this.dirs.getRootPath()) {
        this.dirs.syncEntriesToDisk(input.studentId, room.questionSlug, entries)
      }
    } catch {
      /* ดิสก์ครูมีปัญหา — submission ใน SQLite ยังอยู่ */
    }
    void this.runGrading(input.roomId, input.studentId, room.examPackage.packageId)
    const fileCount = entries.filter((e) => e.kind === 'file').length
    return { accepted: true, fileCount, projectBytes }
  }

  /* ---------- 10.2 คิวตรวจ ---------- */

  get queueStatus(): { active: number; pending: number } {
    return { active: this.grader.activeCount, pending: this.grader.pendingCount }
  }

  async runGrading(roomId: string, studentId: string, packageId: string): Promise<GradeReport | null> {
    const room = this.rooms.get(roomId)
    if (!room || room.examPackage.packageId !== packageId) return null
    const key = [roomId, studentId, packageId].join(' ')
    if (this.gradingInFlight.has(key)) return null
    this.gradingInFlight.add(key)
    try {
      return await this.runGradingInner(roomId, studentId, packageId)
    } catch (err) {
      // fire-and-forget จาก ingest ต้องไม่ throw ออกไป — เก็บสถานะ error ไว้ให้ครูเห็น
      try {
        this.store.setSubmissionStatus({ roomId, studentId, packageId, status: 'error', updatedAtMs: Date.now() })
      } catch {
        /* DB อ่านไม่ได้เลย — แค่ log ไว้ */
      }
      void err
      return null
    } finally {
      this.gradingInFlight.delete(key)
    }
  }

  private async runGradingInner(roomId: string, studentId: string, packageId: string): Promise<GradeReport | null> {
    const room = this.rooms.get(roomId)
    if (!room) return null
    {
      const submission = this.store.getSubmission(roomId, studentId, packageId)
      if (!submission) return null
      this.store.setSubmissionStatus({ roomId, studentId, packageId, status: 'grading', updatedAtMs: Date.now() })
      const depsCache = this.depsByRoom.get(roomId)
      const report = await this.grader.enqueue({
        examPackage: room.examPackage,
        studentId,
        entries: submission.entries,
        ...(this.dirs.getRootPath() ? { teacherWorkspaceRoot: this.dirs.getRootPath() as string } : {}),
        ...(depsCache !== undefined ? { depsCache } : {})
      })
      const gradedAtMs = Date.now()
      if (report.blockedReason && report.results.length === 0) {
        // โค้ดอันตราย / grader พัง — เก็บสถานะ blocked/error ไม่ให้คะแนนมั่ว
        const isBlock = /บล็อก|Guard/.test(report.blockedReason)
        this.store.upsertSubmission({
          roomId,
          studentId,
          packageId,
          status: isBlock ? 'blocked' : 'error',
          earnedPoints: 0,
          passedCount: 0,
          totalCount: report.totalCount,
          fileCount: submission.fileCount,
          blockedReason: report.blockedReason,
          gradedAtMs,
          entries: submission.entries,
          submittedAtMs: submission.submittedAtMs,
          updatedAtMs: gradedAtMs
        })
      } else {
        this.store.upsertSubmission({
          roomId,
          studentId,
          packageId,
          status: 'graded',
          earnedPoints: report.earnedPoints,
          passedCount: report.passedCount,
          totalCount: report.totalCount,
          fileCount: submission.fileCount,
          gradedAtMs,
          entries: submission.entries,
          submittedAtMs: submission.submittedAtMs,
          updatedAtMs: gradedAtMs
        })
      }
      this.store.upsertGradingReport({
        roomId,
        studentId,
        packageId,
        passedCount: report.passedCount,
        totalCount: report.totalCount,
        earnedPoints: report.earnedPoints,
        totalPoints: report.totalPoints,
        reportJson: JSON.stringify(report.results),
        gradedAtMs
      })
      try {
        if (this.dirs.getRootPath()) {
          const installed = this.installManifests.get(`${roomId} ${studentId}`)
          this.dirs.writeGradingReport(studentId, room.questionSlug, {
            packageId,
            studentId,
            earnedPoints: report.earnedPoints,
            totalPoints: report.totalPoints,
            passedCount: report.passedCount,
            totalCount: report.totalCount,
            gradedAtMs,
            ...(report.blockedReason ? { blockedReason: report.blockedReason } : {}),
            // F-3b: นักเรียนติดตั้งอะไรเองบ้าง (ครู opt-in) — ตรวจเทียบกับ bundles ที่อนุมัติ
            ...(installed !== undefined && installed.packages.length > 0
              ? { studentInstalledPackages: installed.packages, studentInstalledAtMs: installed.atMs }
              : {}),
            results: report.results
          })
        }
      } catch {
        /* เขียน report ลงดิสก์ไม่ได้ — ใน SQLite ยังอยู่ */
      }
      return report
    }
  }

  /* ---------- 10.3.2 Re-grade ทั้งห้อง + manual rubric ---------- */

  async regradeAllSubmissions(roomId: string, updatedPackage?: CodeExamPackage): Promise<{ students: number; graded: number }> {
    const room = this.rooms.get(roomId)
    if (!room) return { students: 0, graded: 0 }
    if (updatedPackage) {
      const parsed = CodeExamPackageSchema.parse(updatedPackage)
      this.rooms.set(roomId, { ...room, examPackage: parsed })
    }
    const active = this.rooms.get(roomId)!
    this.store.appendRegradeHistory(roomId, sha256Hex(JSON.stringify(active.examPackage)), JSON.stringify({ at: Date.now() }))
    const submissions = this.store.listSubmissions(roomId)
    let graded = 0
    for (const s of submissions) {
      const report = await this.runGrading(roomId, s.studentId, active.examPackage.packageId)
      if (report) graded += 1
    }
    return { students: submissions.length, graded }
  }

  manualGrade(input: { roomId: string; studentId: string; packageId: string; points: number | null }): { ok: boolean; reason?: string } {
    const room = this.rooms.get(input.roomId)
    if (!room) return { ok: false, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    const submission = this.store.getSubmission(input.roomId, input.studentId, input.packageId)
    if (!submission) return { ok: false, reason: 'SUBMISSION_NOT_FOUND' }
    const maxPoints = room.examPackage.testCases.reduce((s, t) => s + t.points, 0)
    if (input.points !== null && (input.points < 0 || input.points > maxPoints)) {
      return { ok: false, reason: 'POINTS_OUT_OF_RANGE' }
    }
    this.store.setManualPoints({
      roomId: input.roomId,
      studentId: input.studentId,
      packageId: input.packageId,
      manualPoints: input.points,
      updatedAtMs: Date.now()
    })
    return { ok: true }
  }

  /**
   * ทางเข้าจากท่อ LAN (ModuleTransportHost): ตรวจสถานะห้องสอบก่อนรับทุกครั้ง
   * (Host-authoritative — รับเฉพาะตอนห้อง status === 'running')
   */
  async ingestViaTransport(input: {
    roomId: string
    studentId: string
    kind: 'action' | 'autosave'
    payloadJson: string
    serverTimestampMs: number
  }): Promise<{ ok: boolean; progressText?: string; reason?: string }> {
    const room = this.rooms.get(input.roomId)
    if (!room) return { ok: false, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    try {
      const row = this.db.db
        .prepare('SELECT status AS status FROM exam_sessions WHERE id = ?')
        .get(input.roomId) as { status: string } | undefined
      if (!row || row.status !== 'running') {
        return { ok: false, reason: 'EXAM_NOT_RUNNING' }
      }
    } catch {
      return { ok: false, reason: 'EXAM_STATE_UNKNOWN' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(input.payloadJson) as unknown
    } catch {
      return { ok: false, reason: 'PAYLOAD_NOT_JSON' }
    }
    // F-3b: นักเรียนรายงาน manifest หลัง pip/npm install สำเร็จ (ไม่ใช่งานส่ง — บันทึกไว้เฉย ๆ)
    if (typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'code-ide.deps-installed') {
      const pkgs = (parsed as { packages?: unknown }).packages
      this.installManifests.set(`${input.roomId} ${input.studentId}`, {
        packages: Array.isArray(pkgs) ? pkgs.filter((p): p is string => typeof p === 'string').map((p) => p.slice(0, 160)).slice(0, 50) : [],
        atMs: input.serverTimestampMs > 0 ? input.serverTimestampMs : Date.now()
      })
      return { ok: true, progressText: 'deps-install-recorded' }
    }
    // action = { type:'code-ide.submit', entries } / autosave = { entries } หรือ entries ตรง ๆ
    const entriesRaw =
      typeof parsed === 'object' && parsed !== null && 'entries' in parsed
        ? (parsed as { entries: unknown }).entries
        : parsed
    const entries = Array.isArray(entriesRaw) ? entriesRaw : null
    if (!entries) return { ok: false, reason: 'ENTRIES_NOT_ARRAY' }
    if (input.kind === 'autosave') {
      const res = this.ingestAutosave({
        roomId: input.roomId,
        studentId: input.studentId,
        entries,
        serverTimestampMs: input.serverTimestampMs
      })
      return res.accepted ? { ok: true, progressText: 'autosave-ingested' } : { ok: false, reason: res.reason ?? 'REJECTED' }
    }
    const res = this.ingestProjectSubmission({
      roomId: input.roomId,
      studentId: input.studentId,
      entries,
      serverTimestampMs: input.serverTimestampMs
    })
    return res.accepted
      ? { ok: true, progressText: 'code-project-ingested' }
      : { ok: false, reason: res.reason ?? 'REJECTED' }
  }

  /** คะแนนรวมที่ใช้แสดง (manual ชนะ auto) */
  effectiveScore(roomId: string, studentId: string, packageId: string): number | null {
    const submission = this.store.getSubmission(roomId, studentId, packageId)
    if (!submission) return null
    if (submission.manualPoints !== null) return submission.manualPoints
    if (submission.status !== 'graded') return null
    return submission.earnedPoints
  }

  /**
   * F-2: จบสอบ — เลื่อน draft ค้างที่ยังไม่เคยส่งเป็น submission แล้วเข้าคิวตรวจ
   * (นักเรียนที่ส่งงานแล้วไม่ถูกแตะ; คนที่มีแต่ draft จะได้สถานะ queued/graded
   * แทนการหายไปเฉย ๆ)
   */
  async finalizeStudentSessions(
    roomId: string,
    studentIds: string[],
    reason: 'submitted' | 'time-up'
  ): Promise<{ students: number; promoted: number }> {
    const room = this.rooms.get(roomId)
    if (!room) return { students: 0, promoted: 0 }
    void reason
    let promoted = 0
    for (const studentId of studentIds) {
      try {
        if (this.store.getSubmission(roomId, studentId, room.examPackage.packageId)) continue
        const draft = this.store.getDraft(roomId, studentId, room.examPackage.packageId)
        if (!draft) continue
        const res = this.ingestProjectSubmission({
          roomId,
          studentId,
          entries: draft.entries,
          serverTimestampMs: Date.now()
        })
        if (res.accepted) promoted += 1
      } catch {
        /* draft เสีย/ถูกลบระหว่าง finalize — ข้ามรายคน */
      }
    }
    return { students: studentIds.length, promoted }
  }

  /** F-3b: manifest ที่นักเรียนรายงานหลัง pip/npm install (ครูตรวจเทียบกับ bundles ที่อนุมัติ) */
  getInstallManifest(roomId: string, studentId: string): { packages: string[]; atMs: number } | null {
    return this.installManifests.get(`${roomId} ${studentId}`) ?? null
  }

  studentViewFor(roomId: string): ReturnType<typeof stripCodePackageForStudent> | null {
    const room = this.rooms.get(roomId)
    if (!room) return null
    // F-3: แนบ blobs ไฟล์เล็กในงบไปกับ stripped view (ใหญ่เกินงบอยู่ฝั่งแม่เท่านั้น)
    const bundleBlobs = pickStudentBlobs(room.examPackage.blobs)
    return stripCodePackageForStudent(room.examPackage, { bundleBlobs })
  }
}

function checkEntries(
  raw: unknown,
  pkg: CodeExamPackage
): { ok: true; entries: VirtualEntry[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'ENTRIES_NOT_ARRAY' }
  if (raw.length > 2000) return { ok: false, reason: 'TOO_MANY_ENTRIES' }
  return validateEntries(raw, pkg)
}

function validateEntries(
  raw: unknown[],
  pkg: CodeExamPackage
): { ok: true; entries: VirtualEntry[] } | { ok: false; reason: string } {
  const entries: VirtualEntry[] = []
  for (const item of raw) {
    const check = CodeExamPackageSchema.shape.entries.element.safeParse(item)
    if (!check.success) return { ok: false, reason: 'ENTRY_SCHEMA_INVALID' }
    entries.push(check.data)
  }
  const errors = validateProjectTree(entries)
  if (errors.length > 0) return { ok: false, reason: `TREE_INVALID:${errors[0]!.reason}` }
  // กันนักเรียนแก้ไฟล์ readOnly ผ่านการส่งตรง (เทียบกับต้นฉบับครู)
  const locked = new Set(
    pkg.entries.filter((e) => e.readOnly === true).map((e) => e.path)
  )
  const originalByPath = new Map(pkg.entries.map((e) => [e.path, e] as const))
  for (const e of entries) {
    if (e.kind !== 'file' || !locked.has(e.path)) continue
    const original = originalByPath.get(e.path)
    if (original?.kind === 'file' && original.content !== undefined && e.content !== original.content) {
      return { ok: false, reason: `READONLY_MODIFIED:${e.path}` }
    }
  }
  return { ok: true, entries }
}

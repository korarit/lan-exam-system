import { dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { HostDatabase } from '../storage/db'
import type {
  CodeIdeSubmissionDetailResponse,
  CodeIdeSubmissionSummary,
  CodeIdeSubmissionsResponse
} from '@shared/ipc-channels'
import { CodeExamPackageSchema } from '@modules/code-ide/shared/code-schema'
import type { CodeIdeHostService } from '@modules/code-ide/main/code-host-service'
import { buildCodeScoresCsv, exportFullStudentProjectsBundle } from '@modules/code-ide/main/code-exporter'
import {
  bundleForPreview,
  probeBackendServer,
  resolveSeedSql,
  resolveStudentSql
} from '@modules/code-ide/main/code-grader-queue'
import { queryStudentDatabase } from '@modules/code-ide/main/runners/sql-runner'

/* ============================================================
 * Phase 10 — IPC ของ Backend code-ide ฝั่งเครื่องแม่
 * - รับงานผ่านท่อกลาง LAN เท่านั้น (student:module-send → MODULE_ACTION/CHUNK →
 *   ModuleTransportHost → ingestViaTransport — roomId มาจากห้องที่เปิดอยู่,
 *   studentId มาจาก TLS session, เวลาอ้างอิงใช้เครื่องแม่)
 * - code-ide:attach-room-package ครูผูก .ztcode เข้ากับห้อง
 * - code-ide:submissions-get / submission-detail ตารางคะแนน + Mirror Inspector
 * - code-ide:manual-grade / regrade-all / export-csv / export-bundle
 * - code-ide:workspace-state / set-workspace-root / open-student-folder
 * ============================================================ */

export interface CodeIdeHostServices {
  getDatabase(): HostDatabase
  getCodeIdeService(): CodeIdeHostService
  getActiveRoom(): { roomId: string; roomName: string } | null
}

function sanitizeStudentId(raw: string): string {
  return raw.trim().slice(0, 40)
}

export function registerCodeIdeHostHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  services: CodeIdeHostServices
): void {
  const activeRoomPackage = (): { roomId: string; roomName: string; service: CodeIdeHostService } | { reason: string } => {
    const room = services.getActiveRoom()
    if (!room) return { reason: 'ROOM_NOT_OPEN' }
    const service = services.getCodeIdeService()
    if (!service.getRoomPackage(room.roomId)) return { reason: 'ROOM_PACKAGE_NOT_LOADED' }
    return { ...room, service }
  }

  router.register('code-ide:attach-room-package', (req): { ok: boolean; roomId?: string; packageTitle?: string; reason?: string } => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const room = services.getActiveRoom()
    if (!room) return { ok: false, reason: 'ROOM_NOT_OPEN' }
    try {
      const parsed = CodeExamPackageSchema.parse(JSON.parse(req.packageJson) as unknown)
      services.getCodeIdeService().setRoomPackage(room.roomId, room.roomName, parsed)
      return { ok: true, roomId: room.roomId, packageTitle: parsed.title }
    } catch {
      return { ok: false, reason: 'PACKAGE_INVALID' }
    }
  })

  router.register('code-ide:submissions-get', (): CodeIdeSubmissionsResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const room = services.getActiveRoom()
    const service = services.getCodeIdeService()
    if (!room) {
      return {
        ok: false, roomId: null, roomName: null, packageTitle: null, category: null,
        language: null, questionSlug: null, maxPoints: 0,
        queue: service.queueStatus, depsUnsupported: [], submissions: [], reason: 'ROOM_NOT_OPEN'
      }
    }
    const ctx = service.getRoomPackage(room.roomId)
    if (!ctx) {
      return {
        ok: false, roomId: room.roomId, roomName: room.roomName, packageTitle: null,
        category: null, language: null, questionSlug: null, maxPoints: 0,
        queue: service.queueStatus, depsUnsupported: [], submissions: [], reason: 'ROOM_PACKAGE_NOT_LOADED'
      }
    }
    const maxPoints = ctx.examPackage.testCases.reduce((s, t) => s + t.points, 0)
    const submissions: CodeIdeSubmissionSummary[] = service.workspaceStore
      .listSubmissions(room.roomId)
      .map((s) => ({
        studentId: s.studentId,
        fileCount: s.fileCount,
        passedCount: s.passedCount,
        totalCount: s.totalCount,
        autoPoints: s.earnedPoints,
        manualPoints: s.manualPoints,
        totalPoints:
          s.manualPoints !== null ? s.manualPoints : s.status === 'graded' ? s.earnedPoints : 0,
        maxPoints,
        status: s.status,
        submittedAtMs: s.submittedAtMs,
        gradedAtMs: s.gradedAtMs,
        blockedReason: s.blockedReason
      }))
    return {
      ok: true,
      roomId: room.roomId,
      roomName: room.roomName,
      packageTitle: ctx.examPackage.title,
      category: ctx.examPackage.category,
      language: ctx.examPackage.language,
      questionSlug: ctx.questionSlug,
      maxPoints,
      queue: service.queueStatus,
      depsUnsupported: service.getDepsStatus(room.roomId)?.unsupported ?? [],
      submissions
    }
  })

  router.register('code-ide:submission-detail', (req): CodeIdeSubmissionDetailResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const resolved = activeRoomPackage()
    if ('reason' in resolved) return { ok: false, reason: resolved.reason }
    const { roomId, service } = resolved
    const ctx = service.getRoomPackage(roomId)
    if (!ctx) return { ok: false, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    const submission = service.workspaceStore.getSubmission(roomId, sanitizeStudentId(req.studentId), ctx.examPackage.packageId)
    if (!submission) return { ok: false, reason: 'SUBMISSION_NOT_FOUND' }
    const report = service.workspaceStore.getGradingReport(roomId, submission.studentId, ctx.examPackage.packageId)
    let gradeResults: CodeIdeSubmissionDetailResponse['gradeResults']
    try {
      const raw = report ? (JSON.parse(report.reportJson) as unknown) : []
      if (Array.isArray(raw)) {
        gradeResults = raw
          .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
          .map((r) => ({
            testId: String(r.testId ?? ''),
            kind: String(r.kind ?? ''),
            visibility: (r.visibility === 'hidden' ? 'hidden' : 'sample') as 'sample' | 'hidden',
            points: Number(r.points ?? 0),
            earned: Number(r.earned ?? 0),
            passed: typeof r.passed === 'boolean' ? r.passed : null,
            note: String(r.note ?? '').slice(0, 500),
            durationMs: Number(r.durationMs ?? 0)
          }))
      }
    } catch {
      gradeResults = undefined
    }
    const draft = (() => {
      try {
        return service.workspaceStore.getDraft(roomId, submission.studentId, ctx.examPackage.packageId)
      } catch {
        return null
      }
    })()
    const starterEntries = ctx.examPackage.entries.filter((e) => !e.hiddenFromStudent).map((e) => ({ ...e }))
    return {
      ok: true,
      studentId: submission.studentId,
      status: submission.status,
      manualPoints: submission.manualPoints,
      entries: submission.entries.map((e) => ({ ...e })),
      starterEntries,
      ...(draft ? { draftEntries: draft.entries.map((e) => ({ ...e })) } : {}),
      referenceEntries: ctx.examPackage.referenceSolution.map((e) => ({ ...e })),
      ...(gradeResults !== undefined ? { gradeResults } : {}),
      blockedReason: submission.blockedReason
    }
  })

  router.register('code-ide:manual-grade', (req) => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const resolved = activeRoomPackage()
    if ('reason' in resolved) return { ok: false, reason: resolved.reason }
    const ctx = resolved.service.getRoomPackage(resolved.roomId)
    if (!ctx) return { ok: false, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    return resolved.service.manualGrade({
      roomId: resolved.roomId,
      studentId: sanitizeStudentId(req.studentId),
      packageId: ctx.examPackage.packageId,
      points: req.points
    })
  })

  router.register('code-ide:regrade-all', async () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const resolved = activeRoomPackage()
    if ('reason' in resolved) return { ok: false, reason: resolved.reason }
    const summary = await resolved.service.regradeAllSubmissions(resolved.roomId)
    return { ok: true, students: summary.students, graded: summary.graded }
  })

  router.register('code-ide:workspace-state', () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const service = services.getCodeIdeService()
    const health = service.dirsManager.healthCheck()
    return {
      rootPath: service.dirsManager.getRootPath(),
      workspaceOk: health.ok,
      ...(health.ok ? {} : { workspaceReason: health.reason ?? 'UNKNOWN' }),
      queue: service.queueStatus
    }
  })

  router.register('code-ide:set-workspace-root', async () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const picked = await dialog.showOpenDialog({
      title: 'เลือกโฟลเดอร์หลักสำหรับเก็บงานของห้องสอบ',
      properties: ['openDirectory', 'createDirectory']
    })
    const dirPath = picked.filePaths[0]
    if (!dirPath) return { ok: false, reason: 'CANCELLED' }
    try {
      services.getCodeIdeService().dirsManager.setRootPath(dirPath)
      return { ok: true, rootPath: dirPath }
    } catch {
      return { ok: false, reason: 'NOT_A_DIRECTORY' }
    }
  })

  router.register('code-ide:open-student-folder', async (req) => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const dir = services.getCodeIdeService().dirsManager.studentDir(sanitizeStudentId(req.studentId))
    if (!dir) return { ok: false, reason: 'WORKSPACE_NOT_CONFIGURED' }
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const result = await shell.openPath(dir)
      if (result !== '') return { ok: false, reason: 'OPEN_FAILED' }
      return { ok: true, rootPath: dir }
    } catch {
      return { ok: false, reason: 'OPEN_FAILED' }
    }
  })

  router.register('code-ide:export-csv', async () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const resolved = activeRoomPackage()
    if ('reason' in resolved) return { ok: false, reason: resolved.reason }
    const ctx = resolved.service.getRoomPackage(resolved.roomId)
    if (!ctx) return { ok: false, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    const picked = await dialog.showSaveDialog({
      title: 'ส่งออกคะแนน Code IDE เป็น CSV (เปิดใน Excel ภาษาไทยได้)'
    })
    let filePath = picked.filePath
    if (!filePath) return { ok: false, reason: 'CANCELLED' }
    if (!filePath.toLowerCase().endsWith('.csv')) filePath = `${filePath}.csv`
    try {
      const { csvWithBom } = buildCodeScoresCsv(resolved.service, resolved.roomId, resolved.roomName, ctx.examPackage)
      fs.writeFileSync(filePath, csvWithBom, 'utf8')
      return { ok: true, rootPath: filePath }
    } catch {
      return { ok: false, reason: 'EXPORT_FAILED' }
    }
  })

  router.register('code-ide:run-preview', async (req) => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const resolved = activeRoomPackage()
    if ('reason' in resolved) return { ok: false, reason: resolved.reason }
    const ctx = resolved.service.getRoomPackage(resolved.roomId)
    if (!ctx) return { ok: false, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    const submission = resolved.service.workspaceStore.getSubmission(
      resolved.roomId, sanitizeStudentId(req.studentId), ctx.examPackage.packageId
    )
    if (!submission) return { ok: false, reason: 'SUBMISSION_NOT_FOUND' }
    const preview = await bundleForPreview(ctx.examPackage, submission.entries)
    if (!preview.ok) return { ok: false, reason: preview.note.slice(0, 300) }
    return { ok: true, html: preview.html, js: preview.js }
  })

  router.register('code-ide:probe-api', async (req) => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const resolved = activeRoomPackage()
    if ('reason' in resolved) return { ok: false, reason: resolved.reason }
    const ctx = resolved.service.getRoomPackage(resolved.roomId)
    if (!ctx) return { ok: false, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    const submission = resolved.service.workspaceStore.getSubmission(
      resolved.roomId, sanitizeStudentId(req.studentId), ctx.examPackage.packageId
    )
    if (!submission) return { ok: false, reason: 'SUBMISSION_NOT_FOUND' }
    const depsCache = resolved.service.getDepsCache(resolved.roomId)
    const result = await probeBackendServer(ctx.examPackage, submission.entries, {
      method: req.method,
      path: req.path,
      ...(req.bodyJson !== undefined ? { bodyJson: req.bodyJson } : {})
    }, {
      ...(depsCache !== undefined ? { depsCache } : {}),
      ...(resolved.service.dirsManager.getRootPath()
        ? { teacherWorkspaceRoot: resolved.service.dirsManager.getRootPath() as string }
        : {})
    })
    return { ok: result.ok, status: result.status, body: result.body, note: result.note }
  })

  router.register('code-ide:query-sql', async (req) => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const resolved = activeRoomPackage()
    if ('reason' in resolved) return { ok: false, reason: resolved.reason }
    const ctx = resolved.service.getRoomPackage(resolved.roomId)
    if (!ctx) return { ok: false, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    const submission = resolved.service.workspaceStore.getSubmission(
      resolved.roomId, sanitizeStudentId(req.studentId), ctx.examPackage.packageId
    )
    if (!submission) return { ok: false, reason: 'SUBMISSION_NOT_FOUND' }
    const seedSql = resolveSeedSql(ctx.examPackage)
    const studentSql = resolveStudentSql(ctx.examPackage, submission.entries)
    const out = await queryStudentDatabase(seedSql, studentSql, req.sql)
    const rows = out.rows.slice(0, 200).map((row) =>
      row.slice(0, 64).map((v): string | number | null => {
        if (v === null || v === undefined) return null
        if (typeof v === 'number' && Number.isFinite(v)) return v
        if (typeof v === 'string') return v.slice(0, 2000)
        return String(v).slice(0, 2000)
      })
    )
    return { ok: true, columns: out.columns.slice(0, 64), rows, note: out.note.slice(0, 500) }
  })

  router.register('code-ide:comment-save', (req) => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const resolved = activeRoomPackage()
    if ('reason' in resolved) return { ok: false, reason: resolved.reason }
    const ctx = resolved.service.getRoomPackage(resolved.roomId)
    if (!ctx) return { ok: false, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    resolved.service.workspaceStore.upsertComment({
      roomId: resolved.roomId,
      studentId: sanitizeStudentId(req.studentId),
      packageId: ctx.examPackage.packageId,
      path: req.path,
      comment: req.comment,
      updatedAtMs: Date.now()
    })
    return { ok: true }
  })

  router.register('code-ide:comment-list', (req) => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const resolved = activeRoomPackage()
    if ('reason' in resolved) return { ok: false, reason: resolved.reason }
    const ctx = resolved.service.getRoomPackage(resolved.roomId)
    if (!ctx) return { ok: false, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    const comments = resolved.service.workspaceStore.listComments(
      resolved.roomId, sanitizeStudentId(req.studentId), ctx.examPackage.packageId
    )
    return { ok: true, comments }
  })

  router.register('code-ide:export-bundle', async () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const resolved = activeRoomPackage()
    if ('reason' in resolved) return { ok: false, reason: resolved.reason }
    const ctx = resolved.service.getRoomPackage(resolved.roomId)
    if (!ctx) return { ok: false, reason: 'ROOM_PACKAGE_NOT_LOADED' }
    const picked = await dialog.showOpenDialog({
      title: 'เลือกโฟลเดอร์ปลายทางสำหรับส่งออกโปรเจกต์ทั้งห้อง',
      properties: ['openDirectory', 'createDirectory']
    })
    const baseDir = picked.filePaths[0]
    if (!baseDir) return { ok: false, reason: 'CANCELLED' }
    try {
      const exportDir = path.join(baseDir, `exported-submissions-${resolved.roomId}`)
      fs.mkdirSync(exportDir, { recursive: true })
      exportFullStudentProjectsBundle(resolved.service, resolved.roomId, resolved.roomName, ctx.examPackage, exportDir)
      return { ok: true, rootPath: exportDir }
    } catch {
      return { ok: false, reason: 'EXPORT_FAILED' }
    }
  })
}

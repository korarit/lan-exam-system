import { dialog } from 'electron'
import fs from 'node:fs'
import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { CoreSessionManager } from '../host/core-session-manager'
import type { TriageService } from '../host/triage-service'
import type { ExportFileResponse, OkResponse, ResolveTriageResponse } from '@shared/ipc-channels'
import { buildAuditBundle, buildIncidentReportHtml } from '../host/report-exporter'

export interface AuditServices {
  getSessionManager(): CoreSessionManager
  getTriageService(): TriageService
}

/**
 * IPC ของ Audit Hash Chain & Triage (Phase 3b):
 * - Dashboard คัดกรอง (overview / evidence / resolve / warning / freeze)
 * - ส่งออกรายงานหลังจบการสอบ (HTML incident report + .ztaudit bundle)
 */
export function registerAuditHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  services: AuditServices
): void {
  router.register('host:get-triage-overview', () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    return services.getTriageService().getOverview()
  })

  router.register('host:get-student-evidence', (req) => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    return services.getTriageService().getStudentEvidence(req.studentId)
  })

  router.register('host:resolve-triage', (req): ResolveTriageResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const affected = services
      .getTriageService()
      .resolveAlerts(req.studentId, req.resolution, req.note)
    return { ok: true, affectedAlerts: affected }
  })

  router.register('host:send-proctor-warning', (req): OkResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const delivered = services.getTriageService().sendWarning(req.studentId, req.message)
    if (!delivered) return { ok: false }
    return { ok: true }
  })

  router.register('host:set-student-freeze', (req): OkResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const delivered = services.getTriageService().setFrozen(req.studentId, req.frozen)
    if (!delivered) return { ok: false }
    return { ok: true }
  })

  router.register('host:export-incident-report', async (): Promise<ExportFileResponse> => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const sessionManager = services.getSessionManager()
    const triage = services.getTriageService()
    const roomId = triage.roomId
    if (!roomId) return { ok: false, reason: 'ROOM_NOT_OPEN' }
    const picked = await dialog.showSaveDialog({
      title: 'บันทึกรายงานเหตุการณ์การสอบ (HTML)',
      defaultPath: `zt-exam-incident-${roomId.slice(0, 8)}.html`,
      filters: [{ name: 'รายงานเหตุการณ์ (HTML)', extensions: ['html'] }]
    })
    const filePath = picked.filePath
    if (!filePath) return { ok: false, reason: 'CANCELLED' }

    const room = triage.opts.getRoom()
    const entries = triage.getAuditEntries(roomId)
    const timestamps = triage.getRoomMeta(roomId)
    const html = buildIncidentReportHtml({
      room: {
        roomId,
        roomName: room?.room?.roomName ?? roomId,
        mode: room?.room?.mode ?? 'closed',
        enforcement: timestamps.enforcement
      },
      examTitle: sessionManager.examInfo?.title ?? null,
      startedAtMs: timestamps.startedAtMs,
      endedAtMs: timestamps.endedAtMs,
      chain: triage.verifyChain(roomId),
      students: triage.engine.getSortedStudents().map((view) => {
        const name = room?.students.find((s) => s.studentId === view.studentId)?.studentName ?? view.studentId
        const summary = sessionManager.getSummary(view.studentId)
        return {
          name,
          triage: view,
          summary: {
            answeredCount: summary.answeredCount,
            totalQuestions: summary.totalQuestions,
            awardedPoints: summary.awardedPoints,
            finished: summary.finished
          },
          entries: entries.filter((entry) => entry.studentId === view.studentId)
        }
      }),
      generatedAtMs: Date.now()
    })
    fs.writeFileSync(filePath, html, 'utf8')
    return { ok: true, filePath }
  })

  router.register('host:export-audit-bundle', async (): Promise<ExportFileResponse> => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const triage = services.getTriageService()
    const roomId = triage.roomId
    if (!roomId) return { ok: false, reason: 'ROOM_NOT_OPEN' }
    const picked = await dialog.showSaveDialog({
      title: 'บันทึกไฟล์หลักฐาน Audit Bundle (.ztaudit)',
      defaultPath: `zt-exam-audit-${roomId.slice(0, 8)}.ztaudit`,
      filters: [{ name: 'ZT-Exam Audit Bundle', extensions: ['ztaudit'] }]
    })
    const filePath = picked.filePath
    if (!filePath) return { ok: false, reason: 'CANCELLED' }
    const room = triage.opts.getRoom()
    const json = buildAuditBundle({
      roomId,
      roomName: room?.room?.roomName ?? roomId,
      examTitle: services.getSessionManager().examInfo?.title ?? null,
      chain: triage.verifyChain(roomId),
      entries: triage.getAuditEntries(roomId),
      generatedAtMs: Date.now()
    })
    fs.writeFileSync(filePath, json, 'utf8')
    return { ok: true, filePath }
  })
}

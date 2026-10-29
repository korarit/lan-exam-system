import { dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { HostDatabase } from '../storage/db'
import type {
  FormZtformStateResponse,
  FormAttachRoomFormResponse,
  FormManualGradeResponse,
  FormRegradeResponse,
  FormExportFileResponse,
  FormLoadZtresultsResponse,
  FormZtresultsManifestSummary
} from '@shared/ipc-channels'
import type { FormResponsesSnapshot } from '@modules/dynamic-form/shared/form-responses-view'
import {
  ZtformContainerSchema,
  DynamicFormDefinitionSchema,
  type ZtformContainer
} from '@modules/dynamic-form/shared/form-schema'
import { parseZtresultsContent, serializeZtresultsStandard, serializeZtresultsEncrypted, ZtresultsWrongPasswordError, ZtresultsPasswordError, ZtresultsIntegrityError } from '@modules/dynamic-form/main/ztresults-io'
import { snapshotFromZtresults } from '@modules/dynamic-form/main/form-result-exporter'
import type { FormHostService } from '@modules/dynamic-form/main/form-host-service'
import { buildResponsesSnapshot } from '@modules/dynamic-form/main/responses-snapshot'
import { buildResultsCsvForRoom, buildZtresultsForRoom } from '@modules/dynamic-form/main/form-result-exporter'

/* ============================================================
 * Phase 7 — IPC ของ Backend ฟอร์มฝังในเครื่องแม่
 * - form:ztform-state      สถานะฟอร์ม/ผลตอบของห้องปัจจุบัน
 * - form:attach-room-form  ครูผูก .ztform (ที่เปิดใน Builder) กับห้อง
 * - form:responses-get     snapshot 3 แท็บของ Responses Dashboard
 * - form:manual-grade      ครูให้คะแนนข้ออัตนัยต่อคน/ต่อข้อ
 * - form:regrade-all       แก้เฉลยแล้ว "คำนวณคะแนนใหม่ทั้งห้อง"
 * - form:export-csv        Export CSV (UTF-8 BOM, คอลัมน์ Q1..QN)
 * - form:save-ztresults    Save ผลสอบครบชุดเป็นไฟล์ .ztresults
 * - form:load-ztresults    เปิดไฟล์ .ztresults ย้อนหลัง (นอกห้องได้)
 * - form:artifact-open     เปิดดูไฟล์แนบจาก Encrypted Vault
 * ============================================================ */

const ZTRESULTS_FILTERS = [{ name: 'ผลสอบ ZT-Exam (.ztresults)', extensions: ['ztresults'] }]

export interface FormResponseServices {
  getDatabase(): HostDatabase
  getFormService(): FormHostService
  getActiveRoom(): { roomId: string; roomName: string } | null
}

/** snapshot ของไฟล์ .ztresults ที่เปิดล่าสุด (โหมด archive เปิดนอก audit/DB ได้) */
let archiveSnapshot: FormResponsesSnapshot | null = null

export function registerFormResponseHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  services: FormResponseServices
): void {
  router.register('form:ztform-state', (): FormZtformStateResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const room = services.getActiveRoom()
    const roomCtx = room ? services.getFormService().getRoomForm(room.roomId) : null
    return {
      ok: true,
      roomId: room?.roomId ?? null,
      roomName: room?.roomName ?? roomCtx?.roomName ?? null,
      formTitle: roomCtx?.container.manifest.title ?? null,
      hasResponses: room ? hasResponses(room.roomId, services.getDatabase()) : false
    }
  })

  router.register('form:attach-room-form', (req): FormAttachRoomFormResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const room = services.getActiveRoom()
    if (!room) return { ok: false, reason: 'ROOM_NOT_OPEN' }
    let container: ZtformContainer
    try {
      container = ZtformContainerSchema.parse(JSON.parse(req.formPayloadJson) as unknown)
    } catch {
      return { ok: false, reason: 'ZTFORM_PAYLOAD_INVALID' }
    }
    services.getFormService().setRoomForm(room.roomId, room.roomName, container)
    return { ok: true, roomId: room.roomId, formTitle: container.manifest.title }
  })

  router.register('form:responses-get', () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const room = services.getActiveRoom()
    const service = services.getFormService()
    if (room) {
      const ctx = service.getRoomForm(room.roomId)
      if (ctx) {
        const db = services.getDatabase()
        const examRow = db.db
          .prepare('SELECT started_at_ms, ended_at_ms FROM exam_sessions WHERE id = ?')
          .get(room.roomId) as { started_at_ms: number | null; ended_at_ms: number | null } | undefined
        return buildResponsesSnapshot(
          db,
          room.roomId,
          ctx.roomName,
          ctx.container,
          service.getStore(),
          'database',
          examRow?.started_at_ms ?? null,
          examRow?.ended_at_ms ?? null
        )
      }
    }
    if (archiveSnapshot) return archiveSnapshot
    return null
  })

  router.register('form:manual-grade', (req): FormManualGradeResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const room = services.getActiveRoom()
    if (!room) return { ok: false, reason: 'ROOM_NOT_OPEN' }
    if (
      archiveSnapshot !== null &&
      !services.getFormService().getRoomForm(room.roomId)
    ) {
      // โหมด archive (เปิดจากไฟล์ .ztresults): คะแนนใหม่เก็บใน snapshot ชั่วคราว
      return applyManualToArchiveOnly(req.studentId, req.itemId, req.points)
    }
    return services.getFormService().manualGradeItem({
      roomId: room.roomId,
      studentId: req.studentId,
      itemId: req.itemId,
      points: req.points
    })
  })

  router.register('form:regrade-all', (req): FormRegradeResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const room = services.getActiveRoom()
    if (!room) return { ok: false, reason: 'ROOM_NOT_OPEN' }
    const service = services.getFormService()
    const ctx = service.getRoomForm(room.roomId)
    if (!ctx) return { ok: false, reason: 'ROOM_FORM_NOT_LOADED' }
    let updatedForm = ctx.container.form
    if (req.formPayloadJson !== undefined) {
      try {
        const raw = JSON.parse(req.formPayloadJson) as unknown
        const parsed = DynamicFormDefinitionSchema.safeParse(raw)
        if (!parsed.success) return { ok: false, reason: 'FORM_PAYLOAD_INVALID' }
        updatedForm = parsed.data
      } catch {
        return { ok: false, reason: 'FORM_PAYLOAD_NOT_JSON' }
      }
    }
    const summary = service.regradeAllSubmissions(room.roomId, updatedForm, 'teacher-ui')
    if (ctx.container.form !== updatedForm) {
      ctx.container = { ...ctx.container, form: updatedForm }
    }
    return {
      ok: true,
      students: summary.students,
      changedItems: summary.changedItems,
      totalDeltaPoints: summary.totalDeltaPoints
    }
  })

  router.register('form:export-csv', async (): Promise<FormExportFileResponse> => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const room = services.getActiveRoom()
    const service = services.getFormService()
    const ctx = room ? service.getRoomForm(room.roomId) : null
    if (!room || !ctx) return { ok: false, reason: 'ROOM_FORM_NOT_LOADED' }
    const picked = await dialog.showSaveDialog({
      title: 'ส่งออกคำตอบเป็น CSV (เปิดใน Excel ภาษาไทยได้)'
    })
    let filePath = picked.filePath
    if (!filePath) return { ok: false, reason: 'CANCELLED' }
    if (!filePath.toLowerCase().endsWith('.csv')) filePath = `${filePath}.csv`
    try {
      const db = services.getDatabase()
      const csv = buildResultsCsvForRoom(db, room.roomId, room.roomName, ctx.container.form, service.getStore())
      fs.writeFileSync(filePath, Buffer.from(csv))
      return { ok: true, filePath }
    } catch {
      return { ok: false, reason: 'EXPORT_FAILED' }
    }
  })

  router.register('form:save-ztresults', async (req): Promise<FormExportFileResponse> => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    if (req.encrypted && !req.password) return { ok: false, reason: 'PASSWORD_REQUIRED' }
    const room = services.getActiveRoom()
    const service = services.getFormService()
    const ctx = room ? service.getRoomForm(room.roomId) : null
    if (!room || !ctx) return { ok: false, reason: 'ROOM_FORM_NOT_LOADED' }
    const picked = await dialog.showSaveDialog({
      title: 'บันทึกไฟล์ผลสอบครบชุด (.ztresults)',
      defaultPath: `${slugify(room.roomName || 'ztresults')}.ztresults`,
      filters: ZTRESULTS_FILTERS
    })
    let filePath = picked.filePath
    if (!filePath) return { ok: false, reason: 'CANCELLED' }
    if (!filePath.toLowerCase().endsWith('.ztresults')) filePath = `${filePath}.ztresults`
    try {
      const db = services.getDatabase()
      const endedRow = db.db
        .prepare('SELECT ended_at_ms FROM exam_sessions WHERE id = ?')
        .get(room.roomId) as { ended_at_ms: number | null } | undefined
      const container = buildZtresultsForRoom(
        db,
        room.roomId,
        room.roomName,
        ctx.container,
        service.getStore(),
        service.getVault(),
        endedRow?.ended_at_ms ?? null
      )
      const content =
        req.encrypted === true
          ? serializeZtresultsEncrypted(container, req.password ?? '')
          : serializeZtresultsStandard(container)
      fs.writeFileSync(filePath, Buffer.from(content, 'utf8'))
      return { ok: true, filePath }
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message.slice(0, 120) : 'SAVE_FAILED'
      }
    }
  })

  router.register('form:load-ztresults', async (req): Promise<FormLoadZtresultsResponse> => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const picked = await dialog.showOpenDialog({
      title: 'เปิดไฟล์ผลสอบ ZT-Exam (.ztresults)',
      properties: ['openFile'],
      filters: ZTRESULTS_FILTERS
    })
    const filePath = picked.filePaths[0]
    if (!filePath) return { ok: false, message: 'ยกเลิกการเลือกไฟล์' }
    try {
      const rawJson = fs.readFileSync(filePath, 'utf8')
      let parsed
      try {
        parsed = parseZtresultsContent(rawJson, req.password)
      } catch (err) {
        if (err instanceof ZtresultsPasswordError) {
          return { ok: false, needPassword: true, message: 'ไฟล์นี้ถูกเข้ารหัส — ต้องกรอกรหัสผ่านของครู' }
        }
        if (err instanceof ZtresultsWrongPasswordError) {
          return { ok: false, needPassword: true, message: 'รหัสผ่านไม่ถูกต้อง' }
        }
        if (err instanceof ZtresultsIntegrityError || err instanceof Error && /INTEGRITY/.test(err.message)) {
          return { ok: false, message: 'ไฟล์ผลสอบถูกแก้ไขหรือเสียหาย (ตรวจสอบไม่ผ่าน)' }
        }
        return {
          ok: false,
          message: `ไฟล์ไม่ผ่านการตรวจ: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown'}`
        }
      }
      const manifest: FormZtresultsManifestSummary = {
        formId: parsed.manifest.formId,
        formTitle: parsed.manifest.formTitle,
        roomId: parsed.manifest.roomId,
        roomName: parsed.manifest.roomName,
        createdAtMs: parsed.manifest.createdAtMs,
        studentCount: parsed.manifest.studentCount
      }
      archiveSnapshot = { ...snapshotFromZtresults(parsed), form: parsed.form }
      return { ok: true, manifest }
    } catch {
      return { ok: false, message: 'อ่านไฟล์ไม่สำเร็จ' }
    }
  })

  router.register('form:artifact-open', async (req): Promise<FormExportFileResponse> => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const room = services.getActiveRoom()
    const service = services.getFormService()
    const ctx = room ? service.getRoomForm(room.roomId) : null
    if (!room || !ctx) return { ok: false, reason: 'ROOM_FORM_NOT_LOADED' }
    const meta = service
      .getStore()
      .listArtifactMetaForStudent(room.roomId, req.studentId)
      .find((m) => m.item_id === req.itemId && m.artifact_id === req.artifactId)
    if (meta == null) return { ok: false, reason: 'ARTIFACT_NOT_FOUND' }
    try {
      const row = meta as { file_path: string; iv: string; tag: string; row_hmac: string; sha256: string }
      const artifact = service
        .getVault()
        .readArtifact(
          {
            studentId: req.studentId,
            itemId: req.itemId,
            artifactId: req.artifactId,
            fileName: (meta as { file_name: string }).file_name,
            mimeType: (meta as { mime_type: string }).mime_type,
            sizeBytes: (meta as { size_bytes: number }).size_bytes,
            sha256: row.sha256,
            filePath: row.file_path,
            iv: row.iv,
            tag: row.tag,
            rowHmac: row.row_hmac
          },
          room.roomId
        )
      const save = await dialog.showSaveDialog({
        title: 'บันทึกไฟล์แนบที่ถอดรหัสแล้ว',
        defaultPath: safeFileName((meta as { file_name: string }).file_name)
      })
      if (!save.filePath) return { ok: false, reason: 'CANCELLED' }
      fs.writeFileSync(save.filePath, artifact)
      return { ok: true, filePath: save.filePath }
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message.slice(0, 120) : 'ARTIFACT_READ_FAILED'
      }
    }
  })
}

/* ---------- helpers ---------- */

function applyManualToArchiveOnly(
  studentId: string,
  itemId: string,
  points: number | null
): FormManualGradeResponse {
  if (archiveSnapshot === null) return { ok: false, reason: 'NO_SNAPSHOT' }
  const student = archiveSnapshot.students.find((s) => s.studentId === studentId)
  if (student === undefined) return { ok: false, reason: 'STUDENT_NOT_FOUND' }
  const view = student.items.find((i) => i.itemId === itemId)
  if (view === undefined) return { ok: false, reason: 'ITEM_NOT_FOUND' }
  const bounded = points === null ? 0 : Math.max(0, Math.min(view.maxPoints, Math.round(points * 100) / 100))
  view.manualPoints = points === null ? null : bounded
  view.earnedPoints = points === null ? view.earnedPoints : bounded
  view.status = points === null ? 'needs-manual' : 'manual-graded'
  // recount totals
  let auto = 0
  let manual = 0
  for (const it of student.items) {
    if (it.status === 'auto-graded') auto += it.earnedPoints
    else if (it.manualPoints !== null) manual += it.manualPoints
  }
  student.totals.autoPoints = Math.round(auto * 100) / 100
  student.totals.manualPoints = Math.round(manual * 100) / 100
  student.totals.totalPoints = Math.round((auto + manual) * 100) / 100
  student.totals.percent = student.totals.maxPoints > 0
    ? Math.round((student.totals.totalPoints / student.totals.maxPoints) * 1000) / 10
    : 0
  return { ok: true }
}

function hasResponses(roomId: string, db: HostDatabase): boolean {
  try {
    const row = db.db
      .prepare('SELECT COUNT(*) AS c FROM form_responses WHERE session_id = ?')
      .get(roomId) as { c: number } | undefined
    return (row?.c ?? 0) > 0
  } catch {
    return false
  }
}

function safeFileName(name: string): string {
  return path.basename(name).replace(/[^\w.\-()]+/g, '_').slice(0, 180) || 'artifact.bin'
}

function slugify(title: string): string {
  return (title.trim().length > 0 ? title.trim() : 'ztresults').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)
}

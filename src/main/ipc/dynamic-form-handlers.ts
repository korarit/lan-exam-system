import { dialog } from 'electron'
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { HostDatabase } from '../storage/db'
import {
  DynamicFormDefinitionSchema,
  type DynamicFormDefinition,
  type FormAssetMap,
  type FormAsset,
  type ZtformManifest
} from '@modules/dynamic-form/shared/form-schema'
import {
  buildZtformContainer,
  serializeStandard,
  serializeEncrypted,
  parseZtformContent,
  isZtformEncrypted,
  ZtformWrongPasswordError,
  ZtformPasswordError,
  ZtformIntegrityError
} from '@modules/dynamic-form/main/form-file-io'
import type {
  SaveZtformResponse,
  LoadZtformResponse,
  ListSavedFormsResponse,
  SavedFormRecord,
  ZtformManifestSummary
} from '@shared/ipc-channels'

const ZTFORM_FILTERS = [{ name: 'ชุดข้อสอบ Dynamic Form (.ztform)', extensions: ['ztform', 'json'] }]

export interface DynamicFormServices {
  getDatabase(): HostDatabase
}

/* ============================================================
 * Phase 6 — IPC ของโมดูล dynamic-form
 * - form:save-ztform   ครูบันทึกฟอร์ม (เข้ารหัสด้วยรหัสผ่านได้)
 * - form:load-ztform   ครูเปิดไฟล์ .ztform บนเครื่องแม่ (ตรวจ + ถอดรหัส)
 * - host:list-saved-forms รายการฟอร์มที่เคยเปิดล่าสุด (ตาราง saved_forms)
 * ============================================================ */

export function registerDynamicFormHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  services: DynamicFormServices
): void {
  router.register('form:save-ztform', async (req): Promise<SaveZtformResponse> => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    if (req.encrypted && !req.password) {
      return { ok: false, reason: 'PASSWORD_REQUIRED' }
    }
    let parsedPayload: { form: unknown; assets?: unknown }
    try {
      parsedPayload = JSON.parse(req.formPayloadJson) as { form: unknown; assets?: unknown }
    } catch {
      return { ok: false, reason: 'PAYLOAD_NOT_JSON' }
    }
    const formCheck = DynamicFormDefinitionSchema.safeParse(parsedPayload.form)
    if (!formCheck.success) {
      return { ok: false, reason: `FORM_SCHEMA_INVALID: ${formCheck.error.issues[0]?.path.join('.') ?? ''}` }
    }
    const form: DynamicFormDefinition = formCheck.data
    if (countFormQuestionsLocal(form) === 0) {
      return { ok: false, reason: 'FORM_EMPTY' }
    }
    const assets: FormAssetMap = normalizeAssets(parsedPayload.assets)

    const picked = await dialog.showSaveDialog({
      title: 'บันทึกชุดข้อสอบ Dynamic Form',
      defaultPath: `${slugify(form.title)}.ztform`,
      filters: ZTFORM_FILTERS
    })
    const filePath = picked.filePath
    if (!filePath) return { ok: false, reason: 'CANCELLED' }

    const container = buildZtformContainer({
      form,
      assets,
      nowMs: Date.now(),
      initialFormId: form.formId
    })
    const content =
      req.encrypted === true
        ? serializeEncrypted(container, req.password ?? '')
        : serializeStandard(container)
    try {
      fs.writeFileSync(filePath, Buffer.from(content, 'utf8'))
    } catch {
      return { ok: false, reason: 'WRITE_FAILED' }
    }
    recordSavedForm(services.getDatabase(), container.manifest, filePath, Boolean(req.encrypted))
    return { ok: true, filePath }
  })

  router.register('form:load-ztform', async (req): Promise<LoadZtformResponse> => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const picked = await dialog.showOpenDialog({
      title: 'เปิดไฟล์ชุดข้อสอบ Dynamic Form',
      properties: ['openFile'],
      filters: ZTFORM_FILTERS
    })
    const filePath = picked.filePaths[0]
    if (!filePath) return { ok: false, message: 'ยกเลิกการเลือกไฟล์' }
    try {
      const rawJson = fs.readFileSync(filePath, 'utf8')
      let container
      try {
        container = parseZtformContent(rawJson, req.password)
      } catch (err) {
        if (err instanceof ZtformPasswordError) {
          return { ok: false, filePath, needPassword: true, message: 'ไฟล์นี้ถูกเข้ารหัส — ต้องกรอกรหัสผ่านของครู' }
        }
        if (err instanceof ZtformWrongPasswordError) {
          return { ok: false, filePath, needPassword: true, message: 'รหัสผ่านไม่ถูกต้อง' }
        }
        if (err instanceof ZtformIntegrityError || err instanceof Error && /INTEGRITY/.test(err.message)) {
          return { ok: false, filePath, message: 'ไฟล์เสียหายหรือถูกแก้ไข (ตรวจสอบไม่ผ่าน)' }
        }
        return {
          ok: false,
          filePath,
          message: `ไฟล์ไม่ผ่านการตรวจ: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown'}`
        }
      }
      const payloadJson = JSON.stringify({ form: container.form, assets: container.assets })
      const summary = manifestSummary(container.manifest)
      recordSavedForm(services.getDatabase(), container.manifest, filePath, isZtformEncrypted(rawJson))
      return { ok: true, filePath, manifest: summary, formPayloadJson: payloadJson }
    } catch {
      return { ok: false, filePath, message: 'อ่านไฟล์ไม่สำเร็จ' }
    }
  })

  router.register('host:list-saved-forms', (): ListSavedFormsResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    return { forms: listSavedForms(services.getDatabase()) }
  })
}

/* ---------- helpers ---------- */

function countFormQuestionsLocal(form: DynamicFormDefinition): number {
  return form.items.filter((i) => i.inputType !== 'section_header' && i.inputType !== 'media_stimulus').length
}

function normalizeAssets(raw: unknown): FormAssetMap {
  const out: FormAssetMap = {}
  if (typeof raw !== 'object' || raw === null) return out
  const entries = Object.entries(raw as Record<string, unknown>)
  for (const [key, value] of entries.slice(0, 512)) {
    if (!/^[0-9a-f]{64}$/.test(key)) continue
    const check = (value as { mimeType?: string; dataBase64?: string }) ?? null
    if (typeof check === 'object' && check !== null && typeof check.mimeType === 'string' && typeof check.dataBase64 === 'string') {
      const asset: FormAsset = { mimeType: check.mimeType.slice(0, 100), dataBase64: check.dataBase64 }
      out[key] = asset
    }
  }
  return out
}

function manifestSummary(manifest: ZtformManifest): ZtformManifestSummary {
  return {
    formId: manifest.formId,
    title: manifest.title,
    totalQuestions: manifest.totalQuestions,
    totalPoints: Math.round(manifest.totalPoints * 100) / 100
  }
}

function slugify(title: string): string {
  const base = title.trim().length > 0 ? title.trim() : 'ztform'
  return base.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)
}

/* ---------- ตาราง saved_forms (รายการล่าสุด) ---------- */

export function recordSavedForm(db: HostDatabase, manifest: ZtformManifest, filePath: string, encrypted: boolean): void {
  const sha256 = sha256OfFilePath(filePath)
  try {
    const existing = db.db.prepare('SELECT created_at_ms FROM saved_forms WHERE form_id = ?').get(manifest.formId) as
      | { created_at_ms: number }
      | undefined
    if (existing !== undefined) {
      db.db
        .prepare(
          `UPDATE saved_forms SET title = ?, file_path = ?, sha256 = ?, total_questions = ?, total_points = ?, encrypted = ?, updated_at_ms = ?
           WHERE form_id = ?`
        )
        .run(manifest.title, filePath, sha256, manifest.totalQuestions, manifest.totalPoints, encrypted ? 1 : 0, manifest.updatedAtMs, manifest.formId)
      return
    }
    db.db
      .prepare(
        `INSERT INTO saved_forms (form_id, title, file_path, sha256, total_questions, total_points, encrypted, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        manifest.formId,
        manifest.title,
        filePath,
        sha256,
        manifest.totalQuestions,
        manifest.totalPoints,
        encrypted ? 1 : 0,
        manifest.createdAtMs,
        manifest.updatedAtMs
      )
  } catch {
    // ตารางไม่พร้อม (DB เก่า) — ไม่ขวางการบันทึก
  }
}

function listSavedForms(db: HostDatabase): SavedFormRecord[] {
  try {
    const rows = db.db
      .prepare('SELECT * FROM saved_forms ORDER BY updated_at_ms DESC LIMIT 20')
      .all() as Array<{
      form_id: string
      title: string
      file_path: string
      total_questions: number
      total_points: number
      encrypted: number
      updated_at_ms: number
    }>
    const records = rows
      .filter((row) => fs.existsSync(row.file_path))
      .map((row) => ({
        formId: row.form_id,
        title: row.title,
        filePath: row.file_path,
        totalQuestions: row.total_questions,
        totalPoints: row.total_points,
        encrypted: row.encrypted === 1,
        savedAtMs: row.updated_at_ms
      }))
    return records
  } catch {
    return []
  }
}

function sha256OfFilePath(filePath: string): string {
  try {
    const buffer = fs.readFileSync(filePath)
    return crypto.createHash('sha256').update(buffer).digest('hex')
  } catch {
    return 'unavailable'
  }
}

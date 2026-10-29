import { createHmac, randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto'
import {
  ZtformContainerSchema,
  ZtformEncryptedEnvelopeSchema,
  type DynamicFormDefinition,
  type FormAssetMap,
  type ZtformContainer,
  type ZtformEncryptedEnvelope,
  type ZtformManifest
} from '../shared/form-schema'
import { countFormQuestions, sumFormPoints } from '../shared/student-view'

/* ============================================================
 * Phase 6 (6.3.1) — Portable Form File (`.ztform`)
 * โหมด 1: เข้ารหัสด้วยรหัสผ่านครู — PBKDF2-HMAC-SHA256 (100,000 รอบ,
 *          salt 16 ไบต์) → คีย์ 256-bit → AES-256-GCM เนื้อหาทั้งหมด
 * โหมด 2: JSON มาตรฐาน + HMAC ตรวจ integrity (สำรอง/แลกเปลี่ยน)
 * ============================================================ */

export const PBKDF2_ITERATIONS = 100_000
export const PBKDF2_KEY_LENGTH = 32

export class ZtformPasswordError extends Error {
  constructor() {
    super('PASSWORD_REQUIRED')
    this.name = 'ZtformPasswordError'
  }
}

export class ZtformWrongPasswordError extends Error {
  constructor() {
    super('WRONG_PASSWORD')
    this.name = 'ZtformWrongPasswordError'
  }
}

export class ZtformIntegrityError extends Error {
  constructor() {
    super('INTEGRITY_BROKEN')
    this.name = 'ZtformIntegrityError'
  }
}

export interface PreparedContainerInput {
  form: DynamicFormDefinition
  assets: FormAssetMap
  /** เวลาอ้างอิงตามเครื่องที่บันทึก (ใช้ Date.now() — ไฟล์ไม่ใช่ห้องสอบ, ไม่ขึ้นกฮฮอสต์) */
  nowMs: number
  initialFormId: string
}

/** ประกอบ container เต็ม (manifest + integrity) จากฟอร์ม + assets */
export function buildZtformContainer(input: PreparedContainerInput): ZtformContainer {
  const nowMs = input.nowMs
  const allQuestions = input.form.items.filter(
    (i) => i.inputType !== 'section_header' && i.inputType !== 'media_stimulus'
  )
  const manifest: ZtformManifest = {
    formatVersion: 1,
    formId: input.form.formId || input.initialFormId,
    title: input.form.title,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    totalQuestions: countFormQuestions(allQuestions),
    totalPoints: sumFormPoints(allQuestions)
  }
  const integrityKey = randomBytes(32).toString('hex')
  const integrityHmac = computeIntegrityHmac(integrityKey, manifest, input.form, input.assets)
  return {
    container: 'ztform',
    formatVersion: 1,
    integrityKey,
    integrityHmac,
    manifest,
    form: input.form,
    assets: input.assets
  }
}

function computeIntegrityHmac(
  integrityKey: string,
  manifest: ZtformManifest,
  form: DynamicFormDefinition,
  assets: FormAssetMap
): string {
  const payload = canonicalStringify({ manifest, form, assets })
  return createHmac('sha256', Buffer.from(integrityKey, 'hex')).update(payload, 'utf8').digest('hex')
}

/** JSON.stringify แบบ canonical: เรียง key ตามตัวอักษร + ข้าม key ที่ค่า undefined
 * (ตรงกับข้อความ JSON จริง เพราะ JSON.stringify ข้าม undefined อยู่แล้ว) */
function canonicalStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(obj[key])}`)
  return `{${parts.join(',')}}`
}

/** ยืนยัน HMAC ของ container (เรียกหลัง decrypt/parse) */
function verifyIntegrityHmac(container: ZtformContainer): void {
  const expected = computeIntegrityHmac(container.integrityKey, container.manifest, container.form, container.assets)
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(container.integrityHmac, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ZtformIntegrityError()
  }
}

/** serialize container → JSON ของ `.ztform` โหมดมาตรฐาน */
export function serializeStandard(container: ZtformContainer): string {
  return stableStringify(container)
}

/** เข้ารหัส JSON ของ container ด้วยรหัสผ่าน → ข้อความ JSON ของ `.ztform` เข้ารหัส */
export function serializeEncrypted(container: ZtformContainer, password: string): string {
  if (password.length === 0) throw new ZtformPasswordError()
  const salt = randomBytes(16)
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha256')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(Buffer.from(stableStringify(container), 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return stableStringify({
    container: 'ztform-encrypted' as const,
    formatVersion: 1,
    kdf: { saltBase64: salt.toString('base64'), iterations: PBKDF2_ITERATIONS, keyLengthBytes: PBKDF2_KEY_LENGTH },
    cipher: {
      ivBase64: iv.toString('base64'),
      tagBase64: tag.toString('base64'),
      dataBase64: encrypted.toString('base64')
    }
  })
}

/** เปิดไฟล์ .ztform (ทั้งสองโหมด) → container ที่ยืนยัน integrity แล้ว */
export function parseZtformContent(rawJson: string, password?: string): ZtformContainer {
  const raw: unknown = JSON.parse(rawJson)
  if (isEncryptedEnvelopeShape(raw)) {
    const envelope = ZtformEncryptedEnvelopeSchema.parse(raw)
    if (password === undefined || password.length === 0) throw new ZtformPasswordError()
    const containerJson = decryptEnvelope(envelope, password)
    const parsed: unknown = JSON.parse(containerJson)
    const container = ZtformContainerSchema.parse(parsed)
    verifyIntegrityHmac(container)
    return container
  }
  const container = ZtformContainerSchema.parse(raw)
  verifyIntegrityHmac(container)
  return container
}

/** เข้ารหัสไฟล์หรือไม่ — ใช้ในการตัดสินใจหน้า UI (ขอรหัสผ่าน) ก่อนโหลด */
export function isZtformEncrypted(rawJson: string): boolean {
  try {
    const raw: unknown = JSON.parse(rawJson)
    return isEncryptedEnvelopeShape(raw)
  } catch {
    return false
  }
}

function decryptEnvelope(envelope: ZtformEncryptedEnvelope, password: string): string {
  const salt = Buffer.from(envelope.kdf.saltBase64, 'base64')
  const key = pbkdf2Sync(password, salt, envelope.kdf.iterations, envelope.kdf.keyLengthBytes, 'sha256')
  const iv = Buffer.from(envelope.cipher.ivBase64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(Buffer.from(envelope.cipher.tagBase64, 'base64'))
  let plain: Buffer
  try {
    plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.cipher.dataBase64, 'base64')),
      decipher.final()
    ])
  } catch {
    throw new ZtformWrongPasswordError()
  }
  return plain.toString('utf8')
}

/** ตรวจรูปร่างก่อน parse เพื่อแยกซองเข้ารหัส (ไม่ต้องมีสคีมาตอนแรก) */
function isEncryptedEnvelopeShape(raw: unknown): raw is { container: 'ztform-encrypted' } {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'container' in raw &&
    (raw as { container?: unknown }).container === 'ztform-encrypted'
  )
}

/** JSON.stringify แบบ deterministic (สร้าง object ในลำดับคงที่เสมอ — ใช้ทำ HMAC) */
function stableStringify(value: unknown): string {
  return JSON.stringify(value)
}

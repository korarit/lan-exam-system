import { createHmac, randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto'
import {
  DynamicFormDefinitionSchema,
  type DynamicFormDefinition,
  type FormAssetMap,
  type ZtformContainer
} from '../shared/form-schema'
import type { FormItemGradeStatus, FormJourneyRecord, StoredAnswerValue, StoredArtifactDescriptor } from '../shared/form-answer-schema'
import type { FormStudentTotals } from '../shared/form-responses-view'

/* ============================================================
 * Phase 7 (7.4.2) — ไฟล์เก็บผลสอบครบชุด `.ztresults`
 * ครูก๊อปไฟล์นี้จากเครื่องแม่ในห้องแล็บ ไปเปิดตรวจข้ออัตนัยที่
 * เครื่องอื่น (โน้ตบุ๊ก) หรือ Export เป็น CSV ภายหลังได้เสมอ
 * โครง bachelor: manifest + .ztform (แบบเต็มเฉลย) + คำตอบรายคน
 * + ไฟล์แนบ (base64 ฝังไฟล์) + ผลตรวจ + Audit hash-chain tail
 * โหมดมาตรฐานมี HMAC ตรวจ integrity — แนะนำเข้ารหัสด้วยรหัสผ่านครู
 * (PBKDF2-HMAC-SHA256 100k → AES-256-GCM) เช่นเดียวกับ .ztform
 * ============================================================ */

export const PBKDF2_RESULT_ITERATIONS = 100_000
export const PBKDF2_RESULT_KEY_LENGTH = 32

export class ZtresultsPasswordError extends Error {
  constructor() {
    super('PASSWORD_REQUIRED')
  }
}
export class ZtresultsWrongPasswordError extends Error {
  constructor() {
    super('WRONG_PASSWORD')
  }
}
export class ZtresultsIntegrityError extends Error {
  constructor() {
    super('INTEGRITY_BROKEN')
  }
}

/* ---------- schemas ---------- */

interface AuditTailEntry {
  seqNo: number
  timestampMs: number
  eventType: string
  severity: 'normal' | 'warning' | 'critical'
  studentId: string | null
  summaryText: string
  entryHash: string
  prevHash: string
}

export interface ZtresultsStudentRecord {
  studentId: string
  studentName: string
  studentSeed: string
  startedAtMs: number | null
  submittedAtMs: number | null
  finishReason: string | null
  items: Array<{
    itemId: string
    value: StoredAnswerValue
    artifacts: StoredArtifactDescriptor[]
    status: FormItemGradeStatus
    earnedPoints: number
    manualPoints: number | null
    violations: Array<{ code: string; message: string }>
    timeSpentMs: number
    submittedAtMs: number | null
    revision: number
  }>
  totals: FormStudentTotals
  /** (สงวน: journey ของข้อถูกรวมใน items แต่ละตัวแล้ว) */
  journeys?: FormJourneyRecord[]
}

export interface ZtresultsArtifactsRecord {
  studentId: string
  itemId: string
  artifactId: string
  fileName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  dataBase64: string
}

export interface ZtresultsContainer {
  container: 'ztresults'
  formatVersion: 1
  integrityKey: string
  integrityHmac: string
  manifest: {
    formatVersion: 1
    formId: string
    formTitle: string
    roomId: string
    roomName: string
    createdAtMs: number
    endedAtMs: number | null
    studentCount: number
  }
  /** คอนเทนเนอร์ .ztform เต็มรูป (รวมเฉลย + รูปภาพ) — เปิดดู/ตรวจต่อได้ */
  ztform: ZtformContainer
  responses: ZtresultsStudentRecord[]
  artifacts: ZtresultsArtifactsRecord[]
  /** หาง-audit hash chain ของห้อง — หลักฐาน integrity ไปพร้อมไฟล์ */
  auditTail: AuditTailEntry[]
}

/* ---------- build ---------- */

export function buildZtresultsContainer(input: {
  roomId: string
  roomName: string
  createdAtMs: number
  endedAtMs: number | null
  ztform: ZtformContainer
  responses: ZtresultsStudentRecord[]
  artifacts: ZtresultsArtifactsRecord[]
  auditTail: AuditTailEntry[]
}): ZtresultsContainer {
  const manifest = {
    formatVersion: 1 as const,
    formId: input.ztform.manifest.formId,
    formTitle: input.ztform.manifest.title,
    roomId: input.roomId,
    roomName: input.roomName,
    createdAtMs: input.createdAtMs,
    endedAtMs: input.endedAtMs,
    studentCount: input.responses.length
  }
  const core = {
    container: 'ztresults' as const,
    formatVersion: 1 as const,
    manifest,
    ztform: input.ztform,
    responses: input.responses,
    artifacts: input.artifacts,
    auditTail: input.auditTail
  }
  const integrityKey = randomBytes(32).toString('hex')
  const integrityHmac = computeResultIntegrityHmac(integrityKey, core)
  return { ...core, integrityKey, integrityHmac }
}

/* ---------- parse helpers (มีตรวจ integrity และ type สำหรับตาราง) ---------- */

export interface ParsedZtresults {
  manifest: ZtresultsContainer['manifest']
  form: DynamicFormDefinition
  assets: FormAssetMap
  responses: ZtresultsStudentRecord[]
  artifacts: ZtresultsArtifactsRecord[]
  auditTail: AuditTailEntry[]
}

export function parseZtresultsContent(rawJson: string, password?: string): ParsedZtresults {
  const raw: unknown = JSON.parse(rawJson)
  const core = isEncryptedEnvelopeShape(raw)
    ? decryptZtresultsEnvelope(raw, password)
    : (raw as Omit<ZtresultsContainer, 'integrityKey' | 'integrityHmac'>)
  const shaped = core as ZtresultsContainer
  const integrityHmac = shaped.integrityHmac
  const integrityKey = shaped.integrityKey
  verifyResultIntegrity(integrityKey, integrityHmac, {
    container: 'ztresults' as const,
    formatVersion: 1 as const,
    manifest: shaped.manifest,
    ztform: shaped.ztform,
    responses: shaped.responses,
    artifacts: shaped.artifacts,
    auditTail: shaped.auditTail
  })
  const parsedForm = DynamicFormDefinitionSchema.parse(shaped.ztform.form)
  const form = parsedForm as DynamicFormDefinition
  return {
    manifest: shaped.manifest,
    form,
    assets: shaped.ztform.assets,
    responses: shaped.responses,
    artifacts: shaped.artifacts,
    auditTail: shaped.auditTail
  }
}

export function isZtresultsEncrypted(rawJson: string): boolean {
  try {
    return isEncryptedEnvelopeShape(JSON.parse(rawJson) as unknown)
  } catch {
    return false
  }
}

export function serializeZtresultsStandard(container: ZtresultsContainer): string {
  return JSON.stringify(container)
}

export function serializeZtresultsEncrypted(container: ZtresultsContainer, password: string): string {
  if (password.length === 0) throw new ZtresultsPasswordError()
  const salt = randomBytes(16)
  const key = pbkdf2Sync(password, salt, PBKDF2_RESULT_ITERATIONS, PBKDF2_RESULT_KEY_LENGTH, 'sha256')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(container), 'utf8')),
    cipher.final()
  ])
  return JSON.stringify({
    container: 'ztresults-encrypted',
    formatVersion: 1,
    kdf: { saltBase64: salt.toString('base64'), iterations: PBKDF2_RESULT_ITERATIONS, keyLengthBytes: PBKDF2_RESULT_KEY_LENGTH },
    cipher: {
      ivBase64: iv.toString('base64'),
      tagBase64: cipher.getAuthTag().toString('base64'),
      dataBase64: encrypted.toString('base64')
    }
  })
}

/* ---------- internals ---------- */

interface ZtresultsEnvelope {
  container: 'ztresults-encrypted'
  formatVersion: number
  kdf: { saltBase64: string; iterations: number; keyLengthBytes: number }
  cipher: { ivBase64: string; tagBase64: string; dataBase64: string }
}

function isEncryptedEnvelopeShape(raw: unknown): raw is ZtresultsEnvelope {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'container' in raw &&
    (raw as { container?: unknown }).container === 'ztresults-encrypted'
  )
}

function decryptZtresultsEnvelope(envelope: unknown, password: string | undefined): ZtresultsContainer {
  const env = envelope as ZtresultsEnvelope
  if (password === undefined || password.length === 0) throw new ZtresultsPasswordError()
  const salt = Buffer.from(env.kdf.saltBase64, 'base64')
  const key = pbkdf2Sync(password, salt, env.kdf.iterations, env.kdf.keyLengthBytes, 'sha256')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.cipher.ivBase64, 'base64'))
  decipher.setAuthTag(Buffer.from(env.cipher.tagBase64, 'base64'))
  let plain: Buffer
  try {
    plain = Buffer.concat([
      decipher.update(Buffer.from(env.cipher.dataBase64, 'base64')),
      decipher.final()
    ])
  } catch {
    throw new ZtresultsWrongPasswordError()
  }
  return JSON.parse(plain.toString('utf8')) as unknown as ZtresultsContainer
}

/** JSON.stringify แบบ canonical (เรียง key) — ให้ HMAC คงที่ตามเนื้อหาจริง */
export function canonicalStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(obj[key])}`).join(',')}}`
}

function computeResultIntegrityHmac(integrityKey: string, core: Omit<ZtresultsContainer, 'integrityKey' | 'integrityHmac'>): string {
  const payload = canonicalStringify(core)
  return createHmac('sha256', Buffer.from(integrityKey, 'hex')).update(payload, 'utf8').digest('hex')
}

function verifyResultIntegrity(
  integrityKey: string,
  integrityHmac: string,
  core: Omit<ZtresultsContainer, 'integrityKey' | 'integrityHmac'>
): void {
  const expected = computeResultIntegrityHmac(integrityKey, core)
  if (expected !== integrityHmac) throw new ZtresultsIntegrityError()
}

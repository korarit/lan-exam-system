import { createHmac, randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto'
import {
  CodeExamPackageSchema,
  ZtcodeContainerSchema,
  ZtcodeEncryptedEnvelopeSchema,
  canonicalStringify,
  countCodePoints,
  type CodeExamPackage,
  type ZtcodeContainer,
  type ZtcodeEncryptedEnvelope,
  type ZtcodeManifest
} from '../shared/code-schema'

/* ============================================================
 * Phase 8 (8.1.2) — Portable Code Package File (`.ztcode`)
 * โหมด 1: เข้ารหัสด้วยรหัสผ่านครู — PBKDF2-HMAC-SHA256 (100,000 รอบ,
 *          salt 16 ไบต์) → คีย์ 256-bit → AES-256-GCM เนื้อหาทั้งหมด
 * โหมด 2: JSON มาตรฐาน + HMAC ตรวจ integrity
 * ภายในบรรจุ: โครงโฟลเดอร์โปรเจกต์, seed .sql/.sqlite (blobs),
 * Offline Dependency Bundles (blobs) + test cases ทั้ง sample/hidden
 * ============================================================ */

export const PBKDF2_ITERATIONS = 100_000
export const PBKDF2_KEY_LENGTH = 32

export class ZtcodePasswordError extends Error {
  constructor() {
    super('PASSWORD_REQUIRED')
    this.name = 'ZtcodePasswordError'
  }
}

export class ZtcodeWrongPasswordError extends Error {
  constructor() {
    super('WRONG_PASSWORD')
    this.name = 'ZtcodeWrongPasswordError'
  }
}

export class ZtcodeIntegrityError extends Error {
  constructor() {
    super('INTEGRITY_BROKEN')
    this.name = 'ZtcodeIntegrityError'
  }
}

export interface PreparedZtcodeInput {
  codePackage: CodeExamPackage
  nowMs: number
}

/** ประกอบ container เต็ม (manifest + integrity) จากแพ็กเกจ */
export function buildZtcodeContainer(input: PreparedZtcodeInput): ZtcodeContainer {
  const pkg = CodeExamPackageSchema.parse(input.codePackage)
  const fileCount = pkg.entries.filter((e) => e.kind === 'file').length
  const manifest: ZtcodeManifest = {
    formatVersion: 1,
    packageId: pkg.packageId,
    title: pkg.title,
    category: pkg.category,
    language: pkg.language,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    totalFiles: fileCount,
    totalTests: pkg.testCases.length,
    totalPoints: countCodePoints(pkg.testCases)
  }
  const integrityKey = randomBytes(32).toString('hex')
  const integrityHmac = computeIntegrityHmac(integrityKey, manifest, pkg)
  return {
    container: 'ztcode',
    formatVersion: 1,
    integrityKey,
    integrityHmac,
    manifest,
    codePackage: pkg
  }
}

function computeIntegrityHmac(
  integrityKey: string,
  manifest: ZtcodeManifest,
  pkg: CodeExamPackage
): string {
  const payload = canonicalStringify({ manifest, codePackage: pkg })
  return createHmac('sha256', Buffer.from(integrityKey, 'hex')).update(payload, 'utf8').digest('hex')
}

function verifyIntegrityHmac(container: ZtcodeContainer): void {
  const expected = computeIntegrityHmac(container.integrityKey, container.manifest, container.codePackage)
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(container.integrityHmac, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ZtcodeIntegrityError()
  }
}

/** serialize container → JSON ของ `.ztcode` โหมดมาตรฐาน */
export function serializeStandard(container: ZtcodeContainer): string {
  return JSON.stringify(container)
}

/** เข้ารหัส JSON ของ container ด้วยรหัสผ่าน → ข้อความ JSON ของ `.ztcode` เข้ารหัส */
export function serializeEncrypted(container: ZtcodeContainer, password: string): string {
  if (password.length === 0) throw new ZtcodePasswordError()
  const salt = randomBytes(16)
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha256')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(container), 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return JSON.stringify({
    container: 'ztcode-encrypted' as const,
    formatVersion: 1,
    kdf: { saltBase64: salt.toString('base64'), iterations: PBKDF2_ITERATIONS, keyLengthBytes: PBKDF2_KEY_LENGTH },
    cipher: {
      ivBase64: iv.toString('base64'),
      tagBase64: tag.toString('base64'),
      dataBase64: encrypted.toString('base64')
    }
  })
}

/** เปิดไฟล์ .ztcode (ทั้งสองโหมด) → container ที่ยืนยัน integrity แล้ว */
export function parseZtcodeContent(rawJson: string, password?: string): ZtcodeContainer {
  const raw: unknown = JSON.parse(rawJson)
  if (isEncryptedEnvelopeShape(raw)) {
    const envelope = ZtcodeEncryptedEnvelopeSchema.parse(raw)
    if (password === undefined || password.length === 0) throw new ZtcodePasswordError()
    const containerJson = decryptEnvelope(envelope, password)
    const parsed: unknown = JSON.parse(containerJson)
    const container = ZtcodeContainerSchema.parse(parsed)
    verifyIntegrityHmac(container)
    return container
  }
  const container = ZtcodeContainerSchema.parse(raw)
  verifyIntegrityHmac(container)
  return container
}

/** เข้ารหัสไฟล์หรือไม่ — ใช้ตัดสินใจหน้า UI (ขอรหัสผ่าน) ก่อนโหลด */
export function isZtcodeEncrypted(rawJson: string): boolean {
  try {
    const raw: unknown = JSON.parse(rawJson)
    return isEncryptedEnvelopeShape(raw)
  } catch {
    return false
  }
}

function decryptEnvelope(envelope: ZtcodeEncryptedEnvelope, password: string): string {
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
    throw new ZtcodeWrongPasswordError()
  }
  return plain.toString('utf8')
}

function isEncryptedEnvelopeShape(raw: unknown): raw is { container: 'ztcode-encrypted' } {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'container' in raw &&
    (raw as { container?: unknown }).container === 'ztcode-encrypted'
  )
}

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  encryptAes256Gcm,
  decryptAes256Gcm,
  computeHmac,
  verifyHmacTimingSafe,
  type EncryptedPayload
} from '@main/crypto/primitives'

/* ============================================================
 * Phase 7 (7.1.2) — Local Encrypted File Vault
 * ไฟล์ที่นักเรียนแนบมากับข้อ file_upload ถูกเข้ารหัส AES-256-GCM
 * แล้วเก็บที่ userData/exam-vault/<roomId>/<studentId>/<itemId>/
 * รูปแบบชื่อไฟล์: <artifactId>_<safeFilename>.enc
 * บรรจุ: base64(iv)["."]base64(tag)["."]base64(ciphertext)
 * ทุก artifact ผูก SHA-256 + HMAC กันเปิด SQLite/ไฟล์มาแก้ทีหลัง
 * ============================================================ */

export class ArtifactTamperedError extends Error {
  constructor() {
    super('ARTIFACT_TAMPERED')
  }
}

export interface SaveArtifactInput {
  roomId: string
  studentId: string
  itemId: string
  artifactId: string
  fileName: string
  mimeType: string
  content: Buffer
  /** sha256 ที่ฝั่งอัปโหลดอ้างไว้ — ที่นี่คอมมิต/ตรวจซ้ำเสมอ (ต่างกัน = reject) */
  expectedSha256?: string
  /** ขนาดสูงสุดที่ครูตั้งใน validation.maxFileSizeBytes */
  maxFileSizeBytes?: number
}

export interface SavedArtifactRecord {
  artifactId: string
  fileName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  filePath: string
  payload: EncryptedPayload
  rowHmac: string
  serverReceivedAtMs: number
}

export interface StoredArtifactMeta {
  studentId: string
  itemId: string
  artifactId: string
  fileName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  filePath: string
  iv: string
  tag: string
  rowHmac: string
}

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024 // 64MB ต่อไฟล์ (เพดานของ FormValidationRule)

export function makeSafeVaultFileName(fileName: string): string {
  const base = path.basename(fileName)
  const safe = base.replace(/[^\w.\-()]+/g, '_').slice(0, 180)
  return safe.length > 0 ? safe : 'artifact.bin'
}

function sanitizeSegment(segment: string): string {
  return segment.replace(/[^\w.-]+/g, '_').slice(0, 80)
}

/** HMAC องค์ประกอบของ artifact (ใช้ทั้งตอนเขียนและตอนอ่าน — ต้องตรงกันเป๊ะ) */
function artifactPartsList(input: {
  roomId: string
  studentId: string
  itemId: string
  artifactId: string
  payload: EncryptedPayload
  sha256: string
}): string[] {
  return [
    input.roomId,
    input.studentId,
    input.itemId,
    input.artifactId,
    input.payload.ciphertext,
    input.payload.iv,
    input.payload.tag,
    input.sha256
  ]
}

export class FileVault {
  constructor(
    private readonly rootPath: string,
    /** คีย์ 32 ไบต์ต่อห้อง (ผูกกับ exam_sessions.crypto_salt แบบเดียวกับ ResultStore) */
    private readonly getStorageKey: (roomId: string) => Buffer
  ) {
    fs.mkdirSync(this.rootPath, { recursive: true })
  }

  /** รับไฟล์ (chunk สุดท้ายถูกประกอบแล้ว) → เข้ารหัส → เขียนไฟล์ .enc ลงดิสก์ */
  saveArtifact(input: SaveArtifactInput): SavedArtifactRecord {
    if (input.content.length === 0) throw new Error('ARTIFACT_EMPTY')
    if (input.content.length > MAX_ARTIFACT_BYTES) throw new Error('ARTIFACT_TOO_LARGE')
    if (input.maxFileSizeBytes !== undefined && input.content.length > input.maxFileSizeBytes) {
      throw new Error('ARTIFACT_EXCEEDS_LIMIT')
    }
    const key = this.getStorageKey(input.roomId)
    const sha256 = createHash('sha256').update(input.content).digest('hex')
    if (input.expectedSha256 !== undefined && input.expectedSha256.toLowerCase() !== sha256) {
      throw new Error('SHA256_MISMATCH')
    }
    const payload = encryptAes256Gcm(input.content, key)
    const dir = path.join(
      this.rootPath,
      sanitizeSegment(input.roomId),
      sanitizeSegment(input.studentId),
      sanitizeSegment(input.itemId)
    )
    fs.mkdirSync(dir, { recursive: true })
    const safeName = makeSafeVaultFileName(input.fileName)
    const filePath = path.join(dir, `${input.artifactId}_${safeName}.enc`)
    fs.writeFileSync(
      filePath,
      Buffer.from([payload.iv, payload.tag, payload.ciphertext].join('.'), 'utf8')
    )
    const parts = artifactPartsList({ roomId: input.roomId, studentId: input.studentId, itemId: input.itemId, artifactId: input.artifactId, payload, sha256 })
    const rowHmac = computeHmac(key, parts.join('\u0000')).toString('base64')
    return {
      artifactId: input.artifactId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.content.length,
      sha256,
      filePath,
      payload,
      rowHmac,
      serverReceivedAtMs: Date.now()
    }
  }

  /** ครูเรียกดูไฟล์แนบ: ตรวจ HMAC + SHA-256 แล้วถอดรหัสกลับ */
  readArtifact(meta: StoredArtifactMeta, roomId: string): Buffer {
    const key = this.getStorageKey(roomId)
    const blob = fs.readFileSync(meta.filePath, 'utf8').split('.')
    const iv = blob[0]
    const tag = blob[1]
    const ciphertext = blob[2]
    if (iv === undefined || tag === undefined || ciphertext === undefined) throw new ArtifactTamperedError()
    const payload: EncryptedPayload = { iv, tag, ciphertext }
    const parts = artifactPartsList({
      roomId,
      studentId: meta.studentId,
      itemId: meta.itemId,
      artifactId: meta.artifactId,
      payload,
      sha256: meta.sha256
    })
    if (!verifyHmacTimingSafe(key, parts.join('\u0000'), Buffer.from(meta.rowHmac, 'base64'))) {
      throw new ArtifactTamperedError()
    }
    const plain = decryptAes256Gcm(payload, key)
    if (createHash('sha256').update(plain).digest('hex') !== meta.sha256) {
      throw new ArtifactTamperedError()
    }
    return plain
  }

  /** end-of-life: ลบไฟล์ทั้งห้องเมื่อหมดอายุการเก็บรักษา */
  purgeRoom(roomId: string): void {
    const dir = path.join(this.rootPath, sanitizeSegment(roomId))
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  }
}

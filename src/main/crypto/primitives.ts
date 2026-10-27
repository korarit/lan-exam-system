import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  timingSafeEqual,
  type BinaryLike,
  type KeyObject
} from 'node:crypto'

/* ============================================================
 * AES-256-GCM (at-rest encryption: ผลสอบ, audit payloads, เซกเมนต์วิดีโอ)
 * ============================================================ */

const AES_KEY_BYTES = 32 // 256-bit
const AES_IV_BYTES = 12 // GCM recommended nonce
const AES_TAG_BYTES = 16

/** โครงสร้างข้อมูลที่เข้ารหัสแล้ว (base64 ทุกฟิลด์) */
export interface EncryptedPayload {
  iv: string // base64, 12 bytes
  tag: string // base64, 16 bytes
  ciphertext: string // base64
}

export function generateAesKey(): Buffer {
  return randomBytes(AES_KEY_BYTES)
}

export function encryptAes256Gcm(
  plaintext: Buffer | string,
  key: Buffer
): EncryptedPayload {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`AES-256-GCM key must be ${AES_KEY_BYTES} bytes`)
  }
  const iv = randomBytes(AES_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

export function decryptAes256Gcm(payload: EncryptedPayload, key: Buffer): Buffer {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`AES-256-GCM key must be ${AES_KEY_BYTES} bytes`)
  }
  const iv = Buffer.from(payload.iv, 'base64')
  const tag = Buffer.from(payload.tag, 'base64')
  const ciphertext = Buffer.from(payload.ciphertext, 'base64')
  if (iv.length !== AES_IV_BYTES || tag.length !== AES_TAG_BYTES) {
    throw new Error('Invalid AES-256-GCM payload structure')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/* ============================================================
 * HMAC-SHA256 (message integrity, คำตอบ, replay protection)
 * ============================================================ */

export function computeHmac(key: Buffer | string, payload: Buffer | string): Buffer {
  return createHmac('sha256', key).update(payload).digest()
}

/** ตรวจ HMAC ด้วย constant-time comparison เสมอ */
export function verifyHmacTimingSafe(
  key: Buffer | string,
  payload: Buffer | string,
  mac: Buffer
): boolean {
  const expected = computeHmac(key, payload)
  if (mac.length !== expected.length) return false
  return timingSafeEqual(mac, expected)
}

/* ============================================================
 * SHA-256 (manifest hash, hash chain ของ audit log)
 * ============================================================ */

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/* ============================================================
 * Ed25519 (ลายเซ็น manifest / policy — Phase 4 ใช้เต็มรูปแบบ)
 * ============================================================ */

export interface Ed25519KeyPair {
  publicKey: KeyObject
  privateKey: KeyObject
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  return generateKeyPairSync('ed25519')
}

export function ed25519Sign(
  data: Buffer | string,
  privateKey: KeyObject | BinaryLike
): Buffer {
  return cryptoSign(null, data, privateKey)
}

export function ed25519Verify(
  data: Buffer | string,
  signature: Buffer,
  publicKey: KeyObject | BinaryLike
): boolean {
  try {
    return cryptoVerify(null, data, publicKey, signature)
  } catch {
    return false
  }
}

/** สร้างคีย์สุ่มด้วย CSPRNG (รากของ session key, PIN salt ฯลฯ) */
export function generateRandomBytes(size: number): Buffer {
  return randomBytes(size)
}

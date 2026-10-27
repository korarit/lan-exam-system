import { pbkdf2Sync, randomBytes, randomInt } from 'node:crypto'
import selfsigned from 'selfsigned'
import { computeHmac, sha256Hex, verifyHmacTimingSafe } from '../crypto/primitives'

/* ============================================================
 * Ephemeral TLS Certificate ต่อห้องสอบ
 * ============================================================ */

export interface EphemeralCert {
  keyPem: string
  certPem: string
  /** SHA-256 ของ DER bytes (hex 64 ตัวอักษร, พิมพ์เล็ก ไม่มี colon) */
  certFingerprint: string
  /** 16 ตัวแรกของ fingerprint (ไปกับ UDP beacon) */
  certFpShort: string
}

/** สร้างคีย์ ECDSA P-256 + self-signed cert อายุ 12 ชั่วโมง ในหน่วยความจำ */
export async function generateEphemeralCert(): Promise<EphemeralCert> {
  const now = new Date()
  const in12h = new Date(now.getTime() + 12 * 60 * 60 * 1000)
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'zt-exam-host' }],
    {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notBeforeDate: now,
      notAfterDate: in12h,
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyAgreement: true },
        {
          name: 'subjectAltName',
          altNames: [{ type: 2, value: 'zt-exam-host.local' }],
          critical: false
        }
      ]
    }
  )
  const der = pemToDer(pems.cert)
  const certFingerprint = sha256Hex(der)
  return {
    keyPem: pems.private,
    certPem: pems.cert,
    certFingerprint,
    certFpShort: certFingerprint.slice(0, 16)
  }
}

function pemToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '')
  return Buffer.from(body, 'base64')
}

/** แปลง fingerprint แบบ colon ('AA:BB:...') ของ node เป็นรูปแบบมาตรฐานที่เราใช้ */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/:/g, '').toLowerCase()
}

/* ============================================================
 * Room PIN + PBKDF2/HMAC proof (ยืนยันตัวตนเครื่องแม่)
 * ============================================================ */

export const PIN_ITERATIONS = 10_000

/** สุ่ม PIN 6 หลักแบบ uniform ด้วย CSPRNG */
export function generateRoomPin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/** คีย์จาก PIN + roomId (PBKDF2-SHA256, 10,000 รอบ) — สูตรเดียวกันทั้งสองฝั่ง */
export function derivePinKey(roomPin: string, roomId: string): Buffer {
  return pbkdf2Sync(roomPin, `zt-exam:${roomId}`, PIN_ITERATIONS, 32, 'sha256')
}

/** SERVER_PROOF = HMAC(pinKey, certFingerprint + clientNonce + serverNonce) */
export function computeServerProof(
  pinKey: Buffer,
  certFingerprint: string,
  clientNonce: Buffer,
  serverNonce: Buffer
): Buffer {
  return computeHmac(
    pinKey,
    Buffer.concat([
      Buffer.from(certFingerprint, 'utf8'),
      clientNonce,
      serverNonce
    ])
  )
}

/** CLIENT_AUTH = HMAC(pinKey, certFingerprint + serverNonce + clientNonce + studentId) */
export function computeClientAuth(
  pinKey: Buffer,
  certFingerprint: string,
  serverNonce: Buffer,
  clientNonce: Buffer,
  studentId: string
): Buffer {
  return computeHmac(
    pinKey,
    Buffer.concat([
      Buffer.from(certFingerprint, 'utf8'),
      serverNonce,
      clientNonce,
      Buffer.from(studentId, 'utf8')
    ])
  )
}

export function verifyServerProof(
  pinKey: Buffer,
  certFingerprint: string,
  clientNonce: Buffer,
  serverNonce: Buffer,
  proof: Buffer
): boolean {
  return verifyHmacTimingSafe(
    pinKey,
    Buffer.concat([
      Buffer.from(certFingerprint, 'utf8'),
      clientNonce,
      serverNonce
    ]),
    proof
  )
}

export function verifyClientAuth(
  pinKey: Buffer,
  certFingerprint: string,
  serverNonce: Buffer,
  clientNonce: Buffer,
  studentId: string,
  auth: Buffer
): boolean {
  return verifyHmacTimingSafe(
    pinKey,
    Buffer.concat([
      Buffer.from(certFingerprint, 'utf8'),
      serverNonce,
      clientNonce,
      Buffer.from(studentId, 'utf8')
    ]),
    auth
  )
}

export function generateNonce(): Buffer {
  return randomBytes(32)
}

export function generateSessionToken(): string {
  return randomBytes(24).toString('base64url')
}

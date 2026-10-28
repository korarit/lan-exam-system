/**
 * Phase 4 — Trusted Signers ของ ZT-Exam (เครื่องแม่ถือ public key เท่านั้น)
 * - กุญแจจริงถูกสร้างโดย `scripts/keygen.ts` (Private Key ห้าม commit ลง Git เด็ดขาด)
 * - `scripts/keygen.ts` จะเขียน public key ทับบล็อก marker ข้างล่างนี้โดยอัตโนมัติ
 * - ตรวจสอบได้เสมอว่า manifest.keyId ตรงกับ key ที่นี่ และไม่ได้อยู่ใน revokedManifestIds
 */
export interface TrustedManifestKey {
  publicKeyPem: string
  /** ที่มาของกุญแจ (เช่น "offline release key 2026-Q1") */
  comment?: string | undefined
}

export const TRUSTED_MANIFEST_KEYS: Record<string, TrustedManifestKey> = {
  // <ZT-EXAM-TRUSTED-MANIFEST-KEYS/>
  '68755bdce943': { publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEANnMjAbRLEjUq7oxZ7Ss3eTRNzBlaDLPkKxPXvZzZfW4=\n-----END PUBLIC KEY-----", comment: 'generated 2026-10-28T19:55:10.086Z' },
}

/** manifestId ที่ถูกยกเลิกความเชื่อถือ (Key Rotation / กุญแจหลุด → ใส่ id เก่าไว้ที่นี่) */
export const REVOKED_MANIFEST_IDS: readonly string[] = []

export function trustedKeyPemSet(): Record<string, string> {
  const set: Record<string, string> = {}
  for (const [keyId, entry] of Object.entries(TRUSTED_MANIFEST_KEYS)) {
    set[keyId] = entry.publicKeyPem
  }
  return set
}

export function revokedManifestIdSet(): ReadonlySet<string> {
  return new Set(REVOKED_MANIFEST_IDS)
}

/**
 * Native attestation signer — public key ที่เครื่องแม่เชื่อถือ
 * - กุญแจถูกสร้างโดย `scripts/gen-native-attestation-key.ts`
 * - Private seed อยู่ใน native/src/generated/native_attestation_key.h (gitignored)
 * - Script จะเขียน public key ทับระหว่าง marker ด้านล่างโดยอัตโนมัติ
 */
// <ZT-EXAM-NATIVE-ATTESTATION-KEY-BEGIN/>
export const NATIVE_ATTESTATION_PUBLIC_KEY_HEX = '869cd95314a9a17c3c46ef547b3ec4c4c4db7f5f21f3096a43a9ed608c8afa0b'
// <ZT-EXAM-NATIVE-ATTESTATION-KEY-END/>

/** คืน raw 32-byte public key (hex) หรือ null เมื่อยังไม่ได้ generate กุญแจ */
export function nativeTrustedPublicKeyHex(): string | null {
  const hex = NATIVE_ATTESTATION_PUBLIC_KEY_HEX.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null
}

import { computeHmac, verifyHmacTimingSafe } from '../crypto/primitives'
import type { DetectionPolicyBody, SignedDetectionPolicy } from '@shared/policy-schema'

/* ============================================================
 * Policy signing — ลายเซ็น HMAC-SHA256 ครอบ canonical body
 * เครื่องแม่เซ็นด้วย session key ต่อนักเรียน (คนละกันจึงปลอมข้ามคนไม่ได้)
 * ============================================================ */

/** รูปแบบข้อมูลที่ HMAC ครอบ — ต้องเหมือนกันทั้งสองฝั่ง */
export function canonicalPolicyBytes(body: DetectionPolicyBody): Buffer {
  return Buffer.from(JSON.stringify(body), 'utf8')
}

export function signPolicy(body: DetectionPolicyBody, sessionKey: Buffer): SignedDetectionPolicy {
  return {
    body,
    signature: computeHmac(sessionKey, canonicalPolicyBytes(body)).toString('base64')
  }
}

/** ตรวจลายเซ็นก่อนใช้นโยบายเสมอ — false = ทิ้งนโยบาย (ไม่รับของปลอม) */
export function verifySignedPolicy(
  signed: SignedDetectionPolicy,
  sessionKey: Buffer
): boolean {
  return verifyHmacTimingSafe(
    sessionKey,
    canonicalPolicyBytes(signed.body),
    Buffer.from(signed.signature, 'base64')
  )
}

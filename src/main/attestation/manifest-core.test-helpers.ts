import { createHash } from 'node:crypto'

/** sha256 hex ชุดเครื่องมือช่วยทดสอบ (ตรงกับ readRangeDigest ของ client-responder) */
export function shaOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

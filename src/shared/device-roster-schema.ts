import { z } from 'zod'
import { createHash } from 'node:crypto'

/* ============================================================
 * Per-device attestation roster (แทน native global signing key)
 * - แต่ละเครื่องสร้าง Ed25519 keypair ของตัวเอง (private seed อยู่ฝั่ง client)
 * - host เชื่อถือเฉพาะ public key ที่อยู่ใน roster ที่ลงนามด้วย admin key
 * - deviceId = sha256(publicKey raw 32 bytes) 32 hex ตัวแรก (ผูกกับ key โดยตรง)
 *
 * ไฟล์นี้ใช้ได้ทั้ง runtime และ scripts (import แค่ zod + node:crypto)
 * ============================================================ */

export const DEVICE_ID_HEX_LENGTH = 32

export const DeviceRosterEntrySchema = z
  .object({
    /** sha256(publicKey).slice(0, 32) — lowercase hex */
    deviceId: z.string().regex(/^[0-9a-f]{32}$/),
    /** raw Ed25519 public key 32 bytes (hex) */
    publicKey: z.string().regex(/^[0-9a-fA-F]{64}$/),
    /** studentId ที่ผูกกับเครื่องนี้ (optional — ใช้ตรวจ 1 คน = 1 เครื่อง) */
    studentId: z.string().min(1).max(40).optional(),
    /** ป้ายชื่อเครื่อง (optional, diagnostics) */
    label: z.string().min(1).max(80).optional()
  })
  .strict()
export type DeviceRosterEntry = z.infer<typeof DeviceRosterEntrySchema>

export const DeviceRosterBodySchema = z
  .object({
    version: z.literal(1),
    /** ผูก roster กับห้อง/รอบสอบ (optional) */
    roomId: z.string().min(1).max(80).optional(),
    devices: z.array(DeviceRosterEntrySchema).max(500)
  })
  .strict()
export type DeviceRosterBody = z.infer<typeof DeviceRosterBodySchema>

export const SignedDeviceRosterSchema = DeviceRosterBodySchema.extend({
  keyId: z.string().min(1).max(80),
  signatureBase64: z.string().min(1).max(200)
}).strict()
export type SignedDeviceRoster = z.infer<typeof SignedDeviceRosterSchema>

export const EnrolledDeviceStatusSchema = z.enum(['active', 'blocked'])
export type EnrolledDeviceStatus = z.infer<typeof EnrolledDeviceStatusSchema>

/** แถวที่ host เก็บจากการ enroll ตอน join (TOFU) — ใช้แสดงใน dashboard */
export const EnrolledDeviceViewSchema = z
  .object({
    deviceId: z.string().regex(/^[0-9a-f]{32}$/),
    publicKey: z.string().regex(/^[0-9a-f]{64}$/),
    studentId: z.string().min(1).max(40),
    label: z.string().max(80).nullable(),
    status: EnrolledDeviceStatusSchema,
    hardwareBound: z.boolean(),
    firstSeenAtMs: z.number().int().nonnegative(),
    lastSeenAtMs: z.number().int().nonnegative(),
    seenCount: z.number().int().nonnegative()
  })
  .strict()
export type EnrolledDeviceView = z.infer<typeof EnrolledDeviceViewSchema>

/** deviceId จาก public key hex (ต้องตรงกับฝั่ง client ทุกไบต์) */
export function deriveDeviceId(publicKeyHex: string): string {
  const raw = Buffer.from(publicKeyHex.replace(/^0x/i, ''), 'hex')
  return createHash('sha256').update(raw).digest('hex').slice(0, DEVICE_ID_HEX_LENGTH)
}

/**
 * Canonical bytes ที่ลงลายเซ็น — ต้องเหมือนกันทั้งฝั่ง script และ runtime:
 * - เรียง devices ตาม deviceId
 * - lowercase deviceId/publicKey
 * - ใส่ optional field เฉพาะที่มีค่า (ไม่ใส่ undefined)
 */
export function canonicalizeDeviceRosterBody(body: DeviceRosterBody): string {
  const devices = [...body.devices]
    .map((device) => ({
      deviceId: device.deviceId.toLowerCase(),
      publicKey: device.publicKey.toLowerCase(),
      ...(device.studentId !== undefined ? { studentId: device.studentId } : {}),
      ...(device.label !== undefined ? { label: device.label } : {})
    }))
    .sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0))
  const normalized: Record<string, unknown> = { version: 1 }
  if (body.roomId !== undefined) normalized.roomId = body.roomId
  normalized.devices = devices
  return JSON.stringify(normalized)
}

export function computeDeviceRosterHash(body: DeviceRosterBody): string {
  return createHash('sha256').update(canonicalizeDeviceRosterBody(body), 'utf8').digest('hex')
}

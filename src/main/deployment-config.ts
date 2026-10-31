import fs from 'node:fs'
import { z } from 'zod'
import { ed25519Verify } from './crypto/primitives'
import { trustedKeyPemSet } from './attestation/trusted-keys'

/* ============================================================
 * Deployment config ที่ลงลายเซ็น (Ed25519) — ใช้แทน env ที่ผู้ใช้แก้เองได้
 * - ไฟล์: { config, keyId, signature(base64) }
 * - ลายเซ็นครอบ canonical JSON ของ config เท่านั้น
 * - public key ต้องฝังมากับแอป (trusted manifest keys) ไม่ได้มาจาก env
 * ============================================================ */

export const DeploymentConfigSchema = z
  .object({
    version: z.literal(1),
    allowedProfiles: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(256).optional(),
    allowedRoles: z.array(z.enum(['host', 'student'])).min(1).max(2).optional(),
    /** ล็อกบทบาทของเครื่องนี้ (เช่นเครื่องนักเรียนห้ามเปิด host UI) */
    lockedRole: z.enum(['host', 'student']).optional(),
    allowWindowedKiosk: z.boolean().optional(),
    /** รายชื่อ studentId ที่อนุญาตให้เข้าห้อง (roster) */
    roster: z.array(z.string().min(1).max(40)).max(500).optional(),
    /** จำนวน reconnect สูงสุดต่อคน (0 = ไม่จำกัด) */
    maxReconnectsPerStudent: z.number().int().min(0).max(100).optional(),
    /** หลุดต่อเนื่องเกินกี่ ms แล้ว auto-freeze (null = ไม่ freeze) */
    disconnectFreezeMs: z.number().int().min(5_000).max(600_000).nullable().optional()
  })
  .strict()
export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>

export const SignedDeploymentConfigSchema = z
  .object({
    config: DeploymentConfigSchema,
    keyId: z.string().min(1).max(64),
    signature: z.string().min(1).max(256)
  })
  .strict()
export type SignedDeploymentConfig = z.infer<typeof SignedDeploymentConfigSchema>

/** bytes ที่ลงลายเซ็น — ต้องเหมือนกันทั้งฝั่งเซ็นและฝั่งตรวจ */
export function canonicalDeploymentConfigBytes(config: DeploymentConfig): Buffer {
  return Buffer.from(JSON.stringify(config), 'utf8')
}

/**
 * ตรวจลายเซ็นแล้วคืน config — คืน null เมื่อรูปแบบผิด/คีย์ไม่รู้จัก/ลายเซ็นไม่ผ่าน
 * (fail-closed: ผู้เรียกต้องไม่ใช้ config ที่ไม่ผ่าน)
 */
export function verifyDeploymentConfig(
  raw: unknown,
  trustedKeys: Record<string, string> = trustedKeyPemSet()
): DeploymentConfig | null {
  const parsed = SignedDeploymentConfigSchema.safeParse(raw)
  if (!parsed.success) return null
  const pem = trustedKeys[parsed.data.keyId]
  if (!pem) return null
  const ok = ed25519Verify(
    canonicalDeploymentConfigBytes(parsed.data.config),
    Buffer.from(parsed.data.signature, 'base64'),
    pem
  )
  return ok ? parsed.data.config : null
}

/** อ่าน + ตรวจไฟล์ deployment config (null = ไม่มี/ไม่ผ่าน — ใช้ค่า default ต่อ) */
export function loadDeploymentConfig(
  filePath: string | null | undefined,
  trustedKeys: Record<string, string> = trustedKeyPemSet()
): DeploymentConfig | null {
  if (!filePath) return null
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return verifyDeploymentConfig(raw, trustedKeys)
  } catch {
    return null
  }
}

/** ใช้ฝั่ง tools/สคริปต์: ตรวจไฟล์แล้วบอกเหตุผลแบบไม่ throw */
export function inspectDeploymentConfig(
  filePath: string,
  trustedKeys: Record<string, string> = trustedKeyPemSet()
): { ok: true; config: DeploymentConfig } | { ok: false; reason: string } {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const parsed = SignedDeploymentConfigSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, reason: 'invalid-shape' }
    if (!trustedKeys[parsed.data.keyId]) return { ok: false, reason: 'unknown-key-id' }
    const config = verifyDeploymentConfig(raw, trustedKeys)
    return config ? { ok: true, config } : { ok: false, reason: 'bad-signature' }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'read-failed' }
  }
}

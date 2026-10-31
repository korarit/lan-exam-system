import { z } from 'zod'
import { createHash } from 'node:crypto'

/* ============================================================
 * Phase 4 — Binary Attestation (สไตล์ Arma 3 signed manifest)
 * - Build time: สแกนไฟล์สำคัญ → sha256 ทั้งไฟล์ + blockHashes64k แล้วเซ็นด้วย Ed25519
 * - Runtime: เครื่องแม่ถือ public key, ยิง challenge สุ่ม offset ให้เครื่องนักเรียน
 * - Response HMAC ถูกผูกกับ tlsExporter (channel binding) ตรวจกัน Relay Attack
 * ไฟล์นี้ต้อง import โมดูลภายนอกเท่านั้น (zod + node:crypto) เพื่อให้
 * scripts/*.ts เรียก canonical hash เดียวกันกับ runtime ได้โดยตรง
 * ============================================================ */

/** ขนาดบล็อกสำหรับ blockHashes64k — สุ่มตรวจทีละบล็อก 64 KB ตอนรันจริง */
export const ATTESTATION_BLOCK_SIZE = 64 * 1024

/** จำนวนช่วงไบต์สูงสุดต่อ challenge หนึ่งครั้ง (เครื่องแม่สุ่มใหม่แต่ละรอบ) */
export const MAX_SAMPLE_RANGES = 3

export const ManifestPlatformSchema = z.enum(['win32', 'darwin', 'linux'])
export type ManifestPlatform = z.infer<typeof ManifestPlatformSchema>

export const ManifestArchSchema = z.enum(['x64', 'arm64'])
export type ManifestArch = z.infer<typeof ManifestArchSchema>

/** เนื้อหา per-file: hash รวมทั้งไฟล์ + hash รายบล็อก 64 KB (ใช้ถามแบบสุ่ม offset) */
export const ManifestFileEntrySchema = z
  .object({
    size: z.number().int().nonnegative(),
    sha256: z.string().length(64),
    blockHashes64k: z.array(z.string().length(64))
  })
  .strict()
export type ManifestFileEntry = z.infer<typeof ManifestFileEntrySchema>

/**
 * ส่วน canonical ของ manifest (ไม่รวม signatureBase64) — คำนวณ hash ส่วนนี้แล้วเซ็น
 * keyId อยู่ใน canonical เพื่อไม่ให้สลับ key id ระหว่างลายเซ็นกับเนื้อหา
 */
export const AppManifestBodySchema = z
  .object({
    manifestId: z.string().min(8).max(64),
    appVersion: z.string().max(40),
    platform: ManifestPlatformSchema,
    arch: ManifestArchSchema,
    builtAt: z.number().int().nonnegative(),
    /** relativePath (ประกอบด้วย "/" เสมอ) → เนื้อหาไฟล์ */
    files: z.record(z.string().min(1).max(300), ManifestFileEntrySchema)
  })
  .strict()
export type AppManifestBody = z.infer<typeof AppManifestBodySchema>

/** manifest เต็ม: body + keyId + ลายเซ็น Ed25519 (base64) */
export const SignedAppManifestSchema = AppManifestBodySchema.extend({
  keyId: z.string().min(1).max(80),
  signatureBase64: z.string().max(200)
}).strict()
export type SignedAppManifest = z.infer<typeof SignedAppManifestSchema>

/* ---------- Challenge-Response (ตลอดการสอบ) ---------- */

export const AttestationSampleRangeSchema = z
  .object({
    relativePath: z.string().min(1).max(300),
    /** ตำแหน่งไบต์เริ่มของบล็อก (aligned กับ ATTESTATION_BLOCK_SIZE) */
    offset: z.number().int().nonnegative(),
    /** ความยาวจริงของบล็อกนี้ (อาจสั้นกว่า 64KB ถ้าขอบหางไฟล์) */
    length: z.number().int().min(1).max(64 * 1024)
  })
  .strict()
export type AttestationSampleRange = z.infer<typeof AttestationSampleRangeSchema>

/** ไฟล์ที่ native ต้อง hash ทั้งไฟล์เองก่อนเซ็น (ทุก target ใน manifest ไม่ใช่แค่ asar) */
export const NativeAttestationTargetSchema = z
  .object({
    relativePath: z.string().min(1).max(300),
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/)
  })
  .strict()
export type NativeAttestationTarget = z.infer<typeof NativeAttestationTargetSchema>

export const AttestationChallengeSchema = z
  .object({
    challengeId: z.string().min(1).max(64),
    /** random 32 bytes (base64) ต่อหนึ่ง challenge */
    serverNonce: z.string().min(40).max(80),
    sampleRanges: z.array(AttestationSampleRangeSchema).max(MAX_SAMPLE_RANGES),
    /** ต้องตอบกลับภายในเวลานี้ (หน่วย ms — วัดด้วยนาฬิกาเครื่องแม่) */
    deadlineMs: z.number().int().positive(),
    /** บังคับให้แนบ SignedAppManifest มาด้วย (ครั้งแรกที่เข้าห้อง) */
    requireManifest: z.boolean(),
    /**
     * รายการไฟล์ที่ native ต้อง hash ทั้งไฟล์เองแล้วเทียบ (ทุก target ใน manifest)
     * — public เพราะยืนยันโดย manifest ที่เซ็นแล้ว; native ปฏิเสธถ้าไฟล์จริงไม่ตรง
     */
    nativeTargets: z.array(NativeAttestationTargetSchema).max(64).optional(),
    /** @deprecated ใช้ nativeTargets — คงไว้เพื่อ backward compat กับ challenge เก่า */
    expectedAsarSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    /** @deprecated ใช้ nativeTargets */
    targetRelativePath: z.string().min(1).max(300).optional()
  })
  .strict()
export type AttestationChallenge = z.infer<typeof AttestationChallengeSchema>

/**
 * Runtime binding ที่ client รายงานให้ host ตรวจ (VULN-05/62)
 * - host ใช้ตรวจว่า process ที่ขอ attestation ไม่ใช่ wrapper ที่รันโค้ดจากที่อื่น
 * - ยังเป็น client-reported; native runtime guard เป็นชั้นตรวจจับฝั่งเครื่อง
 */
export const RuntimeBindingSchema = z
  .object({
    executablePath: z.string().min(1).max(500),
    resourcesPath: z.string().max(500),
    commandLine: z.string().max(2000),
    packaged: z.boolean(),
    defaultApp: z.boolean(),
    platform: z.string().min(1).max(20),
    addonPath: z.string().max(500).optional()
  })
  .strict()
export type RuntimeBinding = z.infer<typeof RuntimeBindingSchema>

export const AttestationResponseSchema = z
  .object({
    challengeId: z.string().min(1).max(64),
    /** HMAC-SHA256 ที่คีย์ด้วย tlsExporter ของการเชื่อมต่อปัจจุบัน (base64, 32 bytes) */
    responseHmac: z.string().min(40).max(80),
    /** sha256 ของ canonical manifest ที่เครื่องนักเรียนถือ (hex) */
    manifestHash: z.string().length(64).optional(),
    manifest: SignedAppManifestSchema.optional(),
    /** จำนวนช่วงที่อ่านได้จริง (host ใช้เทียบกับที่สุ่มถาม) */
    sampleCount: z.number().int().nonnegative().optional(),
    /** Ed25519 signature จาก native addon (base64) — ผูกกับไฟล์จริงที่ native hash เอง */
    nativeSignature: z.string().min(1).max(200).optional(),
    /** deviceId ของเครื่อง (sha256 ของ public key 32 hex) — host เลือก public key จาก signed roster */
    deviceId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
    /** raw Ed25519 public key ของเครื่อง — ใช้ enroll ครั้งแรก (TOFU) เมื่อยังไม่มี roster */
    publicKeyHex: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    /** keyId ของ native key (optional, diagnostics) */
    nativeKeyId: z.string().min(1).max(80).optional(),
    /** runtime binding สำหรับตรวจ wrapper / การรันโค้ดจากที่อื่น */
    runtimeBinding: RuntimeBindingSchema.optional()
  })
  .strict()
export type AttestationResponse = z.infer<typeof AttestationResponseSchema>

/* ============================================================
 * Canonical serialization (แชร์กันระหว่าง build script กับ runtime)
 * ============================================================ */

/**
 * Canonical JSON ของ manifest body:
 * - เรียง key ของ files ตามลำดับพจนานุกรม (กันการโกงลำดับตอนเซ็น)
 * - กำหนดลำดับ key ระดับบนให้ตายตัว (JSON.stringify ได้ string เดิมเสมอ ทั้ง script และ runtime)
 * - path ประกอบด้วย "/" เสมอ (กันปัญหา Windows "\\" สร้าง hash ต่างกัน)
 */
export function canonicalizeManifestBody(body: AppManifestBody): string {
  const normalized: AppManifestBody = {
    manifestId: body.manifestId,
    appVersion: body.appVersion,
    platform: body.platform,
    arch: body.arch,
    builtAt: body.builtAt,
    files: Object.fromEntries(
      Object.keys(body.files)
        .sort()
        .map((key) => [key, body.files[key] as ManifestFileEntry])
    )
  }
  return JSON.stringify(normalized)
}

/** sha256 ของ canonical body (ใช้ผูกลายเซ็น + ผูก HMAC ของ responses) */
export function computeManifestHash(body: AppManifestBody): string {
  return createHash('sha256').update(canonicalizeManifestBody(body), 'utf8').digest('hex')
}

/** manifestId คือ prefix ของ canonical hash (ตรวจคู่กันตอนรับ manifest ใหม่) */
export function deriveManifestId(body: Omit<AppManifestBody, 'manifestId'>): string {
  const candidate: AppManifestBody = { ...body, manifestId: 'PENDING' }
  return computeManifestHash(candidate).slice(0, 16)
}

/** keyId จาก public key PEM (sha256(pem.trim()) 12 ตัวแรก — keygen/sign script ใช้ id เดียวกัน) */
export function deriveKeyIdFromPublicKeyPem(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem.trim(), 'utf8').digest('hex').slice(0, 12)
}

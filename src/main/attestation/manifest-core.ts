import { createHash } from 'node:crypto'
import {
  ATTESTATION_BLOCK_SIZE,
  computeManifestHash,
  type AppManifestBody,
  type ManifestFileEntry,
  type SignedAppManifest,
  type AttestationSampleRange
} from '@shared/attestation-schema'
import { ed25519Sign, ed25519Verify, computeHmac, verifyHmacTimingSafe } from '../crypto/primitives'

/* ============================================================
 * Phase 4 — Attestation Core (pure logic — ทดสอบ unit ได้)
 * - สร้าง hash แบบบล็อก 64 KB → เซ็น manifest ด้วย Ed25519
 * - คำนวณ/ตรวจ HMAC ของ challenge โดยผูกกับ TLS exporter
 * ============================================================ */

export interface ManifestTarget {
  /** relativePath ตาม schema (ใช้ "/" เสมอ) */
  relativePath: string
  absolutePath: string
  /** ย่อ/สแกนแบบบล็อกเพื่อเปิดช่องให้สุ่มถามระดับไบต์ (default: true) */
  blockSampled?: boolean
}

/** คำนวณ sha256 ทั้งไฟล์ + blockHashes64k พร้อมกัน (อ่านไฟล์เดียวสิ้นเปลืองครั้งเดียว) */
export function hashFileWithBlocks(buffer: Buffer): ManifestFileEntry {
  return hashFileStreaming((length, position) =>
    position >= buffer.length ? null : buffer.subarray(position, Math.min(position + length, buffer.length))
  )
}

/**
 * แบบ streaming — ไม่ต้องโหลดไฟล์ทั้งไฟล์เข้า RAM ครั้งเดียว (app.asar เป็นร้อย MB ได้)
 * read(length, position) คื่น Buffer ของไบต์จริงหรือ null เมื่อเลยช่วง
 */
export function hashFileStreaming(
  read: (length: number, position: number) => Buffer | null
): ManifestFileEntry {
  const fileHash = createHash('sha256')
  let carry = Buffer.alloc(0)
  const blocks: string[] = []
  let size = 0
  let position = 0
  for (;;) {
    const chunk = read(ATTESTATION_BLOCK_SIZE, position)
    if (!chunk || chunk.length === 0) break
    fileHash.update(chunk)
    size += chunk.length
    position += chunk.length
    const merged = Buffer.concat([carry, chunk])
    const fullBlocks = Math.floor(merged.length / ATTESTATION_BLOCK_SIZE)
    for (let i = 0; i < fullBlocks; i++) {
      blocks.push(
        createHash('sha256')
          .update(merged.subarray(i * ATTESTATION_BLOCK_SIZE, (i + 1) * ATTESTATION_BLOCK_SIZE))
          .digest('hex')
      )
    }
    carry = merged.subarray(fullBlocks * ATTESTATION_BLOCK_SIZE)
  }
  if (carry.length > 0) {
    blocks.push(createHash('sha256').update(carry).digest('hex'))
  }
  if (blocks.length === 0) {
    blocks.push(createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
  }
  return { size, sha256: fileHash.digest('hex'), blockHashes64k: blocks }
}

/** สร้าง manifest body จากไฟล์เป้าหมาย (read ทุกไฟล์ — เรียกตอน build/dev จึงไม่เป็นธุระหลัก runtime) */
export function buildManifestBodyFromBuffers(
  version: string,
  platform: AppManifestBody['platform'],
  arch: AppManifestBody['arch'],
  builtAt: number,
  buffers: Map<string, Buffer>
): AppManifestBody {
  const body: Omit<AppManifestBody, 'manifestId'> = {
    appVersion: version,
    platform,
    arch,
    builtAt,
    files: Object.fromEntries(
      [...buffers.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, buf]) => [name, hashFileWithBlocks(buf)])
    )
  }
  return {
    ...body,
    manifestId: computeManifestHash({
      ...body,
      manifestId: 'PENDING'
    }).slice(0, 16)
  }
}

/** เซ็น canonical hash ของ body ด้วย Ed25519 private key ที่ส่งเข้า (script/runtime บนเครื่อง dev) */
export function signManifest(
  body: AppManifestBody,
  privateKeyPem: string,
  keyId: string
): SignedAppManifest {
  const signature = ed25519Sign(computeManifestHash(body), privateKeyPem)
  return {
    ...body,
    keyId,
    signatureBase64: signature.toString('base64')
  }
}

/* ============================================================
 * Challenge ↔ Response (TLS channel binding)
 * ============================================================ */

export interface AttestationDigestInput {
  challengeId: string
  serverNonce: string
  manifestHash: string
  /** sha256 hex ของแต่ละช่วงไบต์ (ตามลำดับ sampleRanges ของ challenge) */
  sampleDigests: string[]
}

/**
 * HMAC ที่ผูกกับ TLS session:
 *   HMAC_SHA256(key = tlsExporter,
 *     data = challengeId|serverNonce|manifestHash|<sha256 hex ตามลำดับของช่วงไบต์>)
 * เครื่องแม่มีแค่ hash ของบล็อก (จาก manifest เซ็นแล้ว) และ exporter ของท่อจริง
 * จึงตรวจได้ว่า byte ต้นทางจริงเป็นของไฟล์ต้นฉบับ "และ" ตอบผ่านท่อ TLS นี้เท่านั้น
 */
export function computeAttestationHmac(
  tlsExporter: Buffer,
  input: AttestationDigestInput
): Buffer {
  return computeHmac(tlsExporter, buildAttestationHmacPayload(input))
}

/** ตรวจ HMAC แบบ timing-safe (คืน false เฉย ๆ เมื่อไม่ตรง — ไม่โยน error) */
export function verifyAttestationHmac(
  tlsExporter: Buffer,
  input: AttestationDigestInput,
  hmacBase64: string
): boolean {
  const provided = Buffer.from(hmacBase64, 'base64')
  if (provided.length !== 32) return false
  return verifyHmacTimingSafe(tlsExporter, buildAttestationHmacPayload(input), provided)
}

function buildAttestationHmacPayload(input: AttestationDigestInput): string {
  return [
    input.challengeId,
    input.serverNonce,
    input.manifestHash,
    input.sampleDigests.join(',')
  ].join('|')
}

export interface NativeAttestationPayloadInput {
  challengeId: string
  serverNonce: string
  manifestHash: string
  sampleDigests: string[]
  /** ทุก target ที่ native hash ทั้งไฟล์เอง (path:sha256 เรียงตาม path) */
  targets?: ReadonlyArray<{ relativePath: string; sha256: string }>
}

/**
 * canonical ของ targets — ต้องตรงกับ C++ (attestation_native.cc) ทุกไบต์:
 * เรียงตาม relativePath, sha256 ตัวพิมพ์เล็ก, คั่นด้วย ',' และ "path:sha256"
 */
export function canonicalizeNativeTargets(
  targets: ReadonlyArray<{ relativePath: string; sha256: string }> = []
): string {
  return [...targets]
    .map((target) => ({ relativePath: target.relativePath, sha256: target.sha256.toLowerCase() }))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))
    .map((target) => `${target.relativePath}:${target.sha256}`)
    .join(',')
}

/** canonical payload ที่ native addon เซ็น (ต้องตรงกับ attestation_native.cc ทุกไบต์) */
export function buildNativeAttestationPayload(input: NativeAttestationPayloadInput): string {
  return [
    input.challengeId,
    input.serverNonce,
    input.manifestHash,
    input.sampleDigests.join(','),
    canonicalizeNativeTargets(input.targets)
  ].join('|')
}

/** แปลง manifest files → รายการ target ที่ native ต้อง hash เอง (ทั้งหมด ไม่ใช่แค่ asar) */
export function nativeTargetsFromFiles(
  files: Record<string, ManifestFileEntry>
): Array<{ relativePath: string; sha256: string }> {
  return Object.entries(files)
    .map(([relativePath, entry]) => ({ relativePath, sha256: entry.sha256 }))
    .slice(0, 64)
}

/** ยืนยันลายเซ็น manifest กับชุด public key ที่เชื่อถือ (รวม revoke list) */
export function verifySignedManifest(
  manifest: SignedAppManifest,
  trustedKeys: Record<string, string>,
  revokedManifestIds: ReadonlySet<string> = new Set()
): { ok: boolean; reason: string } {
  const bodyCandidate: AppManifestBody = {
    manifestId: manifest.manifestId,
    appVersion: manifest.appVersion,
    platform: manifest.platform,
    arch: manifest.arch,
    builtAt: manifest.builtAt,
    files: manifest.files
  }
  if (revokedManifestIds.has(manifest.manifestId)) {
    return { ok: false, reason: 'manifest-revoked' }
  }
  const trustedPem = trustedKeys[manifest.keyId]
  if (!trustedPem) {
    return { ok: false, reason: `untrusted-key:${manifest.keyId}` }
  }
  const canonicalHash = computeManifestHash(bodyCandidate)
  // manifestId ต้องมาจาก canonical hash เสมอ — กันการตัดต่อ id
  if (deriveManifestIdPrefix(bodyCandidate) !== manifest.manifestId.slice(0, 16)) {
    return { ok: false, reason: 'manifest-id-mismatch' }
  }
  const signatureOk = ed25519Verify(canonicalHash, Buffer.from(manifest.signatureBase64, 'base64'), trustedPem)
  if (!signatureOk) {
    return { ok: false, reason: 'signature-invalid' }
  }
  return { ok: true, reason: canonicalHash }
}

function deriveManifestIdPrefix(body: AppManifestBody): string {
  // manifestId ถูกสร้างจาก body ที่ใส่ manifestId = 'PENDING'
  const { manifestId: _ignored, ...rest } = body
  void _ignored
  return computeManifestHash({ ...(rest as AppManifestBody), manifestId: 'PENDING' }).slice(0, 16)
}

/**
 * สุ่มเลือกช่วงไบต์ที่จะถาม (aligned กับบล็อก 64 KB ของ manifest ที่เซ็นแล้ว)
 * ให้ exporter ใช้ hostRandom — runtime ใช้ crypto.randomInt, ทดสอบใช้ค่าคงตัว
 */
export function sampleChallengeRanges(
  files: Record<string, ManifestFileEntry>,
  maxRanges: number,
  hostRandom: () => number = Math.random
): AttestationSampleRange[] {
  const candidates: Array<{ path: string; file: ManifestFileEntry; blockIndex: number }> = []
  for (const [path, file] of Object.entries(files)) {
    file.blockHashes64k.forEach((_, blockIndex) => {
      candidates.push({ path, file, blockIndex })
    })
  }
  if (candidates.length === 0) return []
  const ranges: AttestationSampleRange[] = []
  const used = new Set<string>()
  const count = Math.max(1, Math.min(maxRanges, candidates.length))
  for (let i = 0; i < count; i++) {
    let chosen: (typeof candidates)[number] | null = null
    // สุ่มก่อน (jitter) — ถ้า deterministic random ทับ key เดิมซ้ำ ให้ fallback เดินหาตัวที่ยังไม่ใช้
    for (let attempt = 0; attempt < 4 && !chosen; attempt++) {
      const index = Math.floor(hostRandom() * candidates.length)
      const candidate = candidates[Math.min(candidates.length - 1, index)]
      if (!candidate) continue
      const key = `${candidate.path}@${candidate.blockIndex}`
      if (!used.has(key)) chosen = candidate
    }
    if (!chosen) {
      chosen =
        candidates.find((candidate) => !used.has(`${candidate.path}@${candidate.blockIndex}`)) ?? null
    }
    if (!chosen) break
    used.add(`${chosen.path}@${chosen.blockIndex}`)
    ranges.push({
      relativePath: chosen.path,
      offset: chosen.blockIndex * ATTESTATION_BLOCK_SIZE,
      length: Math.min(ATTESTATION_BLOCK_SIZE, chosen.file.size - chosen.blockIndex * ATTESTATION_BLOCK_SIZE)
    })
  }
  return ranges
}

/** blockHash ที่ตรงกับช่วงถาม (host ใช้เทียบกับ digests ที่ client คำนวณจากไฟล์จริง) */
export function expectedDigestForRange(
  files: Record<string, ManifestFileEntry>,
  range: AttestationSampleRange
): string | null {
  const file = files[range.relativePath]
  if (!file) return null
  const blockIndex = Math.floor(range.offset / ATTESTATION_BLOCK_SIZE)
  return file.blockHashes64k[blockIndex] ?? null
}

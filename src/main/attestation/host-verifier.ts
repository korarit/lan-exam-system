import { randomFillSync, randomInt, randomUUID } from 'node:crypto'
import {
  AttestationResponseSchema,
  computeManifestHash,
  type AppManifestBody,
  type AttestationChallenge,
  type AttestationResponse,
  type ManifestFileEntry,
  type SignedAppManifest
} from '@shared/attestation-schema'
import { NetMsgType } from '@shared/protocol-schema'
import {
  buildNativeAttestationPayload,
  expectedDigestForRange,
  sampleChallengeRanges,
  verifyAttestationHmac,
  verifySignedManifest
} from './manifest-core'
import { trustedKeyPemSet, revokedManifestIdSet } from './trusted-keys'
import { nativeTrustedPublicKeyHex } from './native-trusted-keys'
import { ed25519VerifyRawPublicKeyHex } from '../crypto/primitives'
import { findRuntimeBindingViolation } from './runtime-binding'

/* ============================================================
 * ประเภทที่ใช้ (แยกเป็น structural type เพื่อไม่พึ่งคลาส concrete — ทดสอบ unit ได้)
 * ============================================================ */
export interface AttestationTlsServerAdapter {
  sendToStudent(studentId: string, type: string, payload: unknown): void
  getStudentExporter(studentId: string): Buffer | null
}
export interface AttestationRoomAdapter {
  tlsServerInstance: AttestationTlsServerAdapter | null | undefined
}

/* ============================================================
 * Phase 4.2 — AttestationVerifier ฝั่งเครื่องแม่
 * - ยิง ATTESTATION_CHALLENGE (สุ่มเวลา 45–120 วินาที) ตลอดการสอบ
 * - ตรวจลายเซ็น Ed25519 ของ manifest + HMAC ที่ผูกกับ tlsExporter
 * - Fail → caller จัดการตามหลัก fail-closed (คนแดง + Freeze จอข้อสอบ)
 * ============================================================ */

export const ATTESTATION_MIN_INTERVAL_MS = 45_000
export const ATTESTATION_MAX_INTERVAL_MS = 120_000
/** ขอแรกให้ส่งมาเร็ว (ทันทีหลัง established / reconnect) */
export const ATTESTATION_FIRST_DELAY_MS = 1_500
export const ATTESTATION_DEADLINE_MS = 2_500

/** เปรียบเทียบ semver แบบตัวเลข (1.2.10 > 1.2.9); คืนค่าลบเมื่อ a < b */
export function compareAppVersion(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .split(/[.+-]/)
      .map((part) => {
        const match = /^\d+/.exec(part)
        return match ? Number.parseInt(match[0], 10) : 0
      })
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

export interface AttestationFailure {
  studentId: string
  reason: string
  challengeId: string
}

export interface AttestationSuccess {
  studentId: string
  manifestHash: string | null
  signedOnDevice: boolean
}

export interface AttestationHostOptions {
  getRoom: () => AttestationRoomAdapter | null
  /** dev = ยังไม่บังคับลายเซ็น (แสดงป้าย DEV MODE); prod บังคับเสมอ */
  isDev: () => boolean
  /** สวิตช์บังคับตรวจลายเซ็นจริงแม้ใน dev (จากหน้าตั้งค่าห้องสอบ) */
  isSignatureEnforced: () => boolean
  /** build ต่ำสุดที่ยอมรับ (จาก signed deployment config) — กัน downgrade ไป build เก่า */
  minAppVersion?: () => string | null
  /** production: บังคับให้ client รายงาน runtime binding และต้องผ่านการตรวจ */
  requireRuntimeBinding?: () => boolean
  onVerified: (ok: AttestationSuccess, isNew: boolean) => void
  onFailed: (failure: AttestationFailure) => void
  /** inject trusted native public key (raw 32-byte hex) ใน unit test */
  nativePublicKeyHex?: () => string | null
  now?: () => number
  /** ฟังก์ชันสุ่มช่วงเวลา (inject ได้เพื่อทดสอบ) */
  randomInterval?: (min: number, max: number) => number
  maxRanges?: number
}

interface StudentAttestationState {
  manifestHash: string | null
  manifestBody: AppManifestBody | null
  manifest: SignedAppManifest | null
  keyId: string | null
  signatureOkAtLeastOnce: boolean
  timer: NodeJS.Timeout | null
  pending: AttestationChallenge | null
  pendingIssuedAt: number
}

export interface ChallengeOutcome {
  ok: boolean
  reason: string
}

function freshState(): StudentAttestationState {
  return {
    manifestHash: null,
    manifestBody: null,
    manifest: null,
    keyId: null,
    signatureOkAtLeastOnce: false,
    timer: null,
    pending: null,
    pendingIssuedAt: 0
  }
}

export class AttestationHostService {
  private readonly state = new Map<string, StudentAttestationState>()
  private readonly now: () => number
  private readonly randomInterval: (min: number, max: number) => number
  private readonly maxRanges: number
  private readonly deadlineMs = ATTESTATION_DEADLINE_MS
  private active = false

  constructor(private readonly opts: AttestationHostOptions) {
    this.now = opts.now ?? Date.now
    this.randomInterval = opts.randomInterval ?? ((min: number, max: number) => randomInt(min, max))
    this.maxRanges = opts.maxRanges ?? 3
  }

  get isRunning(): boolean {
    return this.active
  }

  get studentsTracked(): string[] {
    return [...this.state.keys()]
  }

  getStatus(studentId: string): { tracked: boolean; manifestHash: string | null; signed: boolean } {
    const target = this.state.get(studentId)
    if (!target) return { tracked: false, manifestHash: null, signed: false }
    return {
      tracked: true,
      manifestHash: target.manifestHash,
      signed: target.signatureOkAtLeastOnce
    }
  }

  /** เริ่มการสอบ — ยิง challenge แรกให้ทุกคนที่ออนไลน์ (ตาม established) */
  startExam(studentIds: string[]): void {
    this.active = true
    for (const studentId of studentIds) {
      this.noteStudentEstablished(studentId)
    }
  }

  /** จบการสอบ / ปิดห้อง — เคลียร์ทุกตัวจับเวลา (ไม่เก็บคีย์ค้างในหน่วยความจำ) */
  stop(): void {
    this.active = false
    for (const entry of this.state.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
    }
    this.state.clear()
  }

  /** นักเรียน established ด้วยท่อ TLS ใหม่ (join แรก/response หลัง reconnect) */
  noteStudentEstablished(studentId: string): void {
    if (!this.active) return
    const existing = this.state.get(studentId) ?? freshState()
    const next: StudentAttestationState = { ...existing, pending: null, timer: null }
    this.state.set(studentId, next)
    this.scheduleChallenge(studentId, ATTESTATION_FIRST_DELAY_MS)
  }

  /** นักเรียนหลุดการเชื่อมต่อ — ยกเลิก pending ล่าสุด (จะถูก re-established ใหม่เมื่อกลับมา) */
  forget(studentId: string): void {
    const entry = this.state.get(studentId)
    if (!entry) return
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
      entry.timer = null
    }
    entry.pending = null
  }

  /** dev: ขัดขวางเวลาก่อนกำหนด (ใช้บังคับ challenge เช่นหลัง att บูรณภาพ/ณ ตนเองถูกสงสัย) */
  forceChallengeNow(studentId: string): void {
    this.scheduleChallenge(studentId, 0)
  }

  /* ============================================================
   * Challenge → Response (แกนการตรวจ)
   * ============================================================ */

  /** สร้างและส่ง challenge (ใช้เวลาเสีย ocasiones ต่อเดิมไปสุ่มถามตรงไม่ทัน deadline) */
  issueChallenge(studentId: string): AttestationChallenge | null {
    const room = this.opts.getRoom()
    const tlsServer = room?.tlsServerInstance
    const entry = this.state.get(studentId)
    if (!tlsServer || !entry) return null
    const ranges = entry.manifestBody ? sampleChallengeRanges(entry.manifestBody.files, this.maxRanges) : []
    const target = entry.manifestBody ? chooseNativeTarget(entry.manifestBody.files) : null
    const challenge: AttestationChallenge = {
      challengeId: randomUUID(),
      serverNonce: freshNonceBase64(),
      sampleRanges: ranges,
      deadlineMs: this.deadlineMs,
      requireManifest: entry.manifestHash === null,
      ...(target
        ? { expectedAsarSha256: target.sha256, targetRelativePath: target.relativePath }
        : {})
    }
    entry.pending = challenge
    entry.pendingIssuedAt = this.now()
    tlsServer.sendToStudent(studentId, NetMsgType.attestationChallenge, challenge)
    entry.timer = setTimeout(() => {
      const current = this.state.get(studentId)
      if (!current) return
      current.timer = null
      if (current.pending?.challengeId === challenge.challengeId) {
        this.applyFailure(studentId, 'response-deadline', challenge.challengeId)
      }
    }, challenge.deadlineMs)
    return challenge
  }

  /** เส้นทางผู้รับของ ATTESTATION_RESPONSE จากท่อ TLS หลัก (จัดการอย่าง fail-closed) */
  handleResponse(studentId: string, rawPayload: unknown): ChallengeOutcome {
    const parsed = AttestationResponseSchema.safeParse(rawPayload)
    if (!parsed.success) return this.reject(studentId, 'malformed-response')
    const response: AttestationResponse = parsed.data
    const entry = this.state.get(studentId)
    if (!entry) return this.reject(studentId, 'unknown-student')
    const pending = entry.pending
    if (!pending || pending.challengeId !== response.challengeId) {
      return this.reject(studentId, 'unknown-challenge')
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.pending = null
    const elapsed = this.now() - entry.pendingIssuedAt
    if (elapsed > pending.deadlineMs) {
      return this.reject(studentId, 'response-too-late')
    }

    // 1. รับ manifest ครั้งแรก (หรือมาก่อนตาม requireManifest) — ตรวจลายเซ็นตามโหมด
    if (response.manifest !== undefined) {
      const verdict = this.acceptManifest(studentId, response.manifest)
      if (!verdict.ok) return this.reject(studentId, verdict.reason)
    }

    // 2. ผูกกับ manifest ที่รู้จักแล้ว: manifestHash ต้องตรงที่เก็บไว้
    const manifestHash = response.manifestHash ?? entry.manifestHash
    if (!manifestHash) return this.reject(studentId, 'missing-manifest')
    if (entry.manifestHash !== null && entry.manifestHash !== manifestHash) {
      return this.reject(studentId, 'manifest-hash-changed')
    }
    if (!entry.manifestBody) return this.reject(studentId, 'manifest-not-available')

    // 3. ตรวจ HMAC ที่คีย์ด้วย tlsExporter ของท่อจริง + digests จาก blockHashes64k
    const exporter = this.opts.getRoom()?.tlsServerInstance?.getStudentExporter(studentId)
    if (!exporter) return this.reject(studentId, 'missing-tls-exporter')
    const expectedDigests: string[] = []
    if (pending.sampleRanges.length > 0) {
      for (const range of pending.sampleRanges) {
        const digest = expectedDigestForRange(entry.manifestBody.files, range)
        if (digest === null) return this.reject(studentId, 'unknown-range')
        expectedDigests.push(digest)
      }
      if (response.sampleCount !== undefined && response.sampleCount !== pending.sampleRanges.length) {
        return this.reject(studentId, 'sample-count-mismatch')
      }
    }
    const hmacOk = verifyAttestationHmac(
      exporter,
      {
        challengeId: pending.challengeId,
        serverNonce: pending.serverNonce,
        manifestHash,
        sampleDigests: expectedDigests
      },
      response.responseHmac
    )
    if (!hmacOk) return this.reject(studentId, 'response-hmac-mismatch')

    // 4. VULN-05: production ต้องมีลายเซ็นจาก native ที่ hash ไฟล์จริงเอง (dev ผ่อนปรน)
    //    challenge แรกที่ยังไม่รู้ manifest ไม่มี expected hash → bootstrap ด้วย HMAC/manifest ก่อน
    const nativeRequired = !this.opts.isDev() && pending.expectedAsarSha256 !== undefined
    const nativeKeyHex = this.opts.nativePublicKeyHex?.() ?? nativeTrustedPublicKeyHex()
    if (!response.nativeSignature) {
      if (nativeRequired) return this.reject(studentId, 'native-signature-missing')
    } else if (!nativeKeyHex) {
      if (nativeRequired) return this.reject(studentId, 'native-key-unavailable')
    } else if (!pending.expectedAsarSha256) {
      if (nativeRequired) return this.reject(studentId, 'missing-expected-asar-hash')
    } else {
      const nativePayload = buildNativeAttestationPayload({
        challengeId: pending.challengeId,
        serverNonce: pending.serverNonce,
        manifestHash,
        sampleDigests: expectedDigests,
        expectedAsarSha256: pending.expectedAsarSha256
      })
      const nativeSignature = Buffer.from(response.nativeSignature, 'base64')
      if (!ed25519VerifyRawPublicKeyHex(nativePayload, nativeSignature, nativeKeyHex)) {
        return this.reject(studentId, 'native-signature-invalid')
      }
    }

    // 5. VULN-05/62: ตรวจ runtime binding — กัน wrapper ที่รันโค้ดจากที่อื่น
    const requireRuntimeBinding = this.opts.requireRuntimeBinding?.() === true
    if (requireRuntimeBinding) {
      if (!response.runtimeBinding) return this.reject(studentId, 'runtime-binding-missing')
      const violation = findRuntimeBindingViolation(response.runtimeBinding)
      if (violation) return this.reject(studentId, violation)
    }

    // ผ่านทั้งหมด → สุ่มเวลาถึงรอบถัดไป (45–120s)
    this.scheduleNextChallenge(studentId)
    this.opts.onVerified(
      {
        studentId,
        manifestHash,
        signedOnDevice: entry.signatureOkAtLeastOnce
      },
      true
    )
    return { ok: true, reason: 'verified' }
  }

  /* ---------- internals ---------- */

  private acceptManifest(
    studentId: string,
    manifest: SignedAppManifest
  ): { ok: true } | { ok: false; reason: string } {
    const entry = this.state.get(studentId)
    if (!entry) return { ok: false, reason: 'unknown-student' }
    const enforceSignature = !this.opts.isDev() || this.opts.isSignatureEnforced()
    const verdict = verifySignedManifest(manifest, trustedKeyPemSet(), revokedManifestIdSet())
    const isDevUnsigned = manifest.keyId === 'dev-unsigned' && manifest.signatureBase64 === ''
    if (enforceSignature) {
      if (!verdict.ok) return { ok: false, reason: verdict.reason }
      entry.signatureOkAtLeastOnce = true
    } else {
      // permissive (ดีฟโหมด): ยอมรับ manifest ที่ไม่มีลายเซ็นโดยเฉพาะ
      if (!verdict.ok && !isDevUnsigned) return { ok: false, reason: verdict.reason }
      if (verdict.ok) entry.signatureOkAtLeastOnce = true
    }
    // กัน downgrade: build เก่าที่เซ็นถูกต้องแต่มี guard อ่อนกว่าต้องไม่ผ่าน
    const minVersion = this.opts.minAppVersion?.() ?? null
    if (minVersion !== null && minVersion !== '' && compareAppVersion(manifest.appVersion, minVersion) < 0) {
      return { ok: false, reason: 'app-version-too-old' }
    }
    const body: AppManifestBody = {
      manifestId: manifest.manifestId,
      appVersion: manifest.appVersion,
      platform: manifest.platform,
      arch: manifest.arch,
      builtAt: manifest.builtAt,
      files: manifest.files
    }
    entry.manifest = manifest
    entry.manifestBody = body
    entry.manifestHash = computeManifestHash(body)
    entry.keyId = manifest.keyId
    if (isDevUnsigned) entry.signatureOkAtLeastOnce = false
    return { ok: true }
  }

  private reject(studentId: string, reason: string): ChallengeOutcome {
    this.applyFailure(studentId, reason, this.state.get(studentId)?.pending?.challengeId ?? 'unknown')
    return { ok: false, reason }
  }

  private applyFailure(studentId: string, reason: string, challengeId: string): void {
    const entry = this.state.get(studentId)
    if (entry) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      entry.pending = null
    }
    this.opts.onFailed({ studentId, reason, challengeId })
    // ทุกความล้มเหลวต้องตวจใหม่อีกครั้ง (สุ่มเวลา 45–120 วินาทีถัดไป) — ไม่ปล่อยค้างเงียบ
    this.scheduleNextChallenge(studentId)
  }

  private scheduleNextChallenge(studentId: string): void {
    const delay = Math.max(
      ATTESTATION_MIN_INTERVAL_MS,
      Math.min(ATTESTATION_MAX_INTERVAL_MS, this.randomInterval(ATTESTATION_MIN_INTERVAL_MS, ATTESTATION_MAX_INTERVAL_MS))
    )
    this.scheduleChallenge(studentId, delay)
  }

  private scheduleChallenge(studentId: string, delayMs: number): void {
    const entry = this.state.get(studentId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      const current = this.state.get(studentId)
      if (!current) return
      current.timer = null
      this.issueChallenge(studentId)
    }, delayMs)
  }
}

function freshNonceBase64(): string {
  return randomFillSync(Buffer.alloc(32)).toString('base64')
}

/** ไฟล์ที่ native จะ hash ทั้งไฟล์: app.asar ก่อน (prod) หรือไฟล์แรกของ manifest (dev) */
function chooseNativeTarget(
  files: Record<string, ManifestFileEntry>
): { relativePath: string; sha256: string } | null {
  const asar = files['app.asar']
  if (asar) return { relativePath: 'app.asar', sha256: asar.sha256 }
  const firstPath = Object.keys(files)[0]
  if (!firstPath) return null
  const firstEntry = files[firstPath]
  return firstEntry ? { relativePath: firstPath, sha256: firstEntry.sha256 } : null
}

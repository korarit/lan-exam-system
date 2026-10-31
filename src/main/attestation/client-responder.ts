import {
  AttestationChallengeSchema,
  type AttestationChallenge,
  type AttestationResponse,
  type NativeAttestationTarget,
  type RuntimeBinding
} from '@shared/attestation-schema'
import { NetMsgType } from '@shared/protocol-schema'
import { computeAttestationHmac } from './manifest-core'
import {
  readRangeDigest,
  signWithDevKeyIfAvailable,
  type AttestationSnapshot
} from './manifest'
import {
  signAttestation as signNativeAttestation,
  type NativeAttestationSigner
} from './native-attestation'

/* ============================================================
 * Phase 4.2 — AttestationResponder ฝั่งเครื่องนักเรียน
 * - รับ ATTESTATION_CHALLENGE (ถูกผูกกับ TLS session ของเรา)
 * - อ่านไบต์จริงจากไฟล์ตาม sampleRanges → sha256 ต่อช่วง
 * - responseHmac = HMAC(tlsExporter, challenge|nonce|manifestHash|digests)
 * - ครั้งแรกที่เข้าห้อง: แนบ SignedAppManifest (หรือ dev ที่ไม่เซ็น) ไปด้วย
 * ============================================================ */

export interface AttestationClientOptions {
  /** ส่งข้อความผ่านท่อ TLS (SecureConnection ครอบ HMAC ประจำ session ให้แล้ว) */
  sendToHost: (type: string, payload: unknown) => void
  /** exporter ของการเชื่อมต่อปัจจุบัน (null = handshake ยังไม่พร้อม → ตอบไม่ได้) */
  getTlsExporter: () => Buffer | null
  /** สร้าง/โหลด manifest ของตัวเอง (cache ภายใน) */
  getSnapshot: () => AttestationSnapshot | null
  /** production (!dev) บังคับ native signature — dev อนุญาต HMAC-only fallback */
  isDev?: () => boolean
  /** inject native signer ใน unit test (default = native-attestation module) */
  nativeSigner?: NativeAttestationSigner
  /** runtime binding ที่ host ใช้ตรวจ wrapper (VULN-05/62) */
  getRuntimeBinding?: () => RuntimeBinding | null
  now?: () => number
}

export class AttestationResponder {
  private readonly sentManifestIn = new Set<string>()
  private respondedCount = 0

  constructor(private readonly opts: AttestationClientOptions) {}

  get responseCount(): number {
    return this.respondedCount
  }

  /** ตั้ง flag: หลุดการเชื่อมต่อ → การเชื่อมต่อถัดไป exporter ต่างเดิม จึงต้องส่ง manifest ใหม่ */
  resetOnReconnect(): void {
    this.sentManifestIn.clear()
  }

  /**
   * จัดการข้อความ ATTESTATION_CHALLENGE ของเครื่องแม่
   * คืน true เมื่อได้ประกอบและส่ง response แล้ว (ให้ forwarder ข้ามเส้นทางอื่น)
   */
  handleChallengeMessage(rawPayload: unknown): boolean {
    const parsed = AttestationChallengeSchema.safeParse(rawPayload)
    if (!parsed.success) return true
    const challenge: AttestationChallenge = parsed.data
    this.respond(challenge)
    return true
  }

  /** สร้าง + ส่ง response ต่อหนึ่ง challenge (ยกเว้น exporter ยังไม่พร้อม) */
  respond(challenge: AttestationChallenge): boolean {
    const exporter = this.opts.getTlsExporter()
    if (!exporter) return false
    const snapshot = this.opts.getSnapshot()
    if (!snapshot || snapshot.manifestHash === null) {
      // อ่านไฟล์ตัวเองไม่ได้เลย = ระบบป้องกันถูกบุกรุกหรือยังไม่ build — ยอมอยู่เงียบแล้วกำชับต่อ host
      return false
    }
    const manifestHash = snapshot.manifestHash
    // target ที่ native ต้อง hash เอง — รับจาก challenge (host) และ map legacy ได้
    const targets = challengeTargets(challenge)
    // challenge แรก (ยังไม่แนบ manifest) ไม่มี target → native เซ็นไม่ได้ ต้อง bootstrap ก่อน
    const nativeRequired = !(this.opts.isDev?.() ?? false) && targets.length > 0

    const digests: string[] = []
    for (const range of challenge.sampleRanges) {
      const digest = readRangeDigest(snapshot, range)
      if (!digest) {
        // ไฟล์เปลี่ยน/หาย — เอา digest ค่าว่างไปเลย ให้ HMAC เสียเอง (fail-closed)
        digests.push('missing')
        continue
      }
      digests.push(digest)
    }

    const nativeSignature = this.signWithNative(challenge, manifestHash, digests, targets)
    if (!nativeSignature && nativeRequired) {
      // production: native signer ต้องพร้อมและตรวจไฟล์จริงผ่านเท่านั้น — ไม่ส่ง response เลย
      return false
    }

    const includeManifest = challenge.requireManifest || !this.sentManifestIn.has('once')
    const runtimeBinding = this.opts.getRuntimeBinding?.() ?? null
    const payload: AttestationResponse = {
      challengeId: challenge.challengeId,
      responseHmac: computeAttestationHmac(exporter, {
        challengeId: challenge.challengeId,
        serverNonce: challenge.serverNonce,
        manifestHash,
        sampleDigests: digests
      }).toString('base64'),
      manifestHash,
      sampleCount: challenge.sampleRanges.length,
      ...(runtimeBinding ? { runtimeBinding } : {})
    }
    if (nativeSignature) payload.nativeSignature = nativeSignature
    if (includeManifest && snapshot.manifest) {
      let manifest = snapshot.manifest
      // โหมด dev ที่มีกุญแจในเครื่อง (env): ลองเซ็นจริงเพื่อซ้อม E2E ด้วยลายเซ็นที่ตรวจได้
      if (snapshot.body) {
        const devSigned = signWithDevKeyIfAvailable(snapshot.body)
        if (devSigned) {
          manifest = {
            ...snapshot.body,
            keyId: devSigned.keyId,
            signatureBase64: devSigned.signatureBase64
          }
        }
      }
      payload.manifest = manifest
      this.sentManifestIn.add('once')
    }
    this.respondedCount += 1
    this.opts.sendToHost(NetMsgType.attestationResponse, payload)
    return true
  }

  /**
   * ให้ native hash target ทุกไฟล์ + คำนวณ sample digests เองแล้วเซ็น
   * (JS ส่งแค่ช่วงไบต์; ค่า digest ที่ native คำนวณคือค่าที่ถูกลายเซ็น)
   * dev ที่ไม่มี addon คืน null
   */
  private signWithNative(
    challenge: AttestationChallenge,
    manifestHash: string,
    sampleDigests: string[],
    targets: NativeAttestationTarget[]
  ): string | null {
    if (targets.length === 0) return null
    const signer = this.opts.nativeSigner?.signAttestation ?? signNativeAttestation
    try {
      const signature = signer({
        challengeId: challenge.challengeId,
        serverNonce: challenge.serverNonce,
        manifestHash,
        sampleDigests,
        sampleRanges: challenge.sampleRanges,
        targets
      })
      return signature && signature.length > 0 ? signature : null
    } catch {
      return null
    }
  }
}

/** target ของ challenge — รองรับทั้ง nativeTargets (ใหม่) และ expectedAsarSha256 (legacy) */
export function challengeTargets(challenge: AttestationChallenge): NativeAttestationTarget[] {
  if (challenge.nativeTargets && challenge.nativeTargets.length > 0) {
    return challenge.nativeTargets.map((target) => ({
      relativePath: target.relativePath,
      sha256: target.sha256
    }))
  }
  if (challenge.expectedAsarSha256) {
    return [
      {
        relativePath: challenge.targetRelativePath ?? 'app.asar',
        sha256: challenge.expectedAsarSha256
      }
    ]
  }
  return []
}

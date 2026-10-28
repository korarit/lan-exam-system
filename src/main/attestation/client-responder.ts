import {
  AttestationChallengeSchema,
  type AttestationChallenge,
  type AttestationResponse
} from '@shared/attestation-schema'
import { NetMsgType } from '@shared/protocol-schema'
import { computeAttestationHmac } from './manifest-core'
import {
  readRangeDigest,
  signWithDevKeyIfAvailable,
  type AttestationSnapshot
} from './manifest'

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

    const includeManifest = challenge.requireManifest || !this.sentManifestIn.has('once')
    const payload: AttestationResponse = {
      challengeId: challenge.challengeId,
      responseHmac: computeAttestationHmac(exporter, {
        challengeId: challenge.challengeId,
        serverNonce: challenge.serverNonce,
        manifestHash: snapshot.manifestHash,
        sampleDigests: digests
      }).toString('base64'),
      manifestHash: snapshot.manifestHash,
      sampleCount: challenge.sampleRanges.length
    }
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
}

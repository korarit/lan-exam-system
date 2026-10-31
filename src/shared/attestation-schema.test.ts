import { describe, expect, it } from 'vitest'
import {
  AttestationChallengeSchema,
  AttestationResponseSchema
} from './attestation-schema'

const baseChallenge = {
  challengeId: 'c1',
  serverNonce: 'n'.repeat(43),
  sampleRanges: [],
  deadlineMs: 2_500,
  requireManifest: true
}

describe('attestation schema — native attestation fields', () => {
  it('challenge เดิม (ไม่มี expectedAsarSha256) ยังใช้ได้', () => {
    expect(AttestationChallengeSchema.safeParse(baseChallenge).success).toBe(true)
  })

  it('challenge รับ expectedAsarSha256 + targetRelativePath', () => {
    const parsed = AttestationChallengeSchema.safeParse({
      ...baseChallenge,
      expectedAsarSha256: 'a'.repeat(64),
      targetRelativePath: 'app.asar'
    })
    expect(parsed.success).toBe(true)
  })

  it('challenge ปฏิเสธ expectedAsarSha256 ที่ไม่ใช่ hex 64 ตัว', () => {
    expect(
      AttestationChallengeSchema.safeParse({ ...baseChallenge, expectedAsarSha256: 'xyz' }).success
    ).toBe(false)
  })

  it('challenge ปฏิเสธ targetRelativePath ยาวเกิน 300', () => {
    expect(
      AttestationChallengeSchema.safeParse({
        ...baseChallenge,
        targetRelativePath: 'a'.repeat(301)
      }).success
    ).toBe(false)
  })

  it('response รับ nativeSignature/nativeKeyId และยังรับแบบไม่มีได้', () => {
    const baseResponse = {
      challengeId: 'c1',
      responseHmac: 'h'.repeat(44)
    }
    expect(AttestationResponseSchema.safeParse(baseResponse).success).toBe(true)
    expect(
      AttestationResponseSchema.safeParse({
        ...baseResponse,
        nativeSignature: 'c2lnbmF0dXJl',
        nativeKeyId: 'key-1'
      }).success
    ).toBe(true)
  })
})

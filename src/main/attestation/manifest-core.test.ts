import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  ATTESTATION_BLOCK_SIZE,
  computeManifestHash,
  deriveKeyIdFromPublicKeyPem
} from '@shared/attestation-schema'
import {
  buildManifestBodyFromBuffers,
  buildNativeAttestationPayload,
  canonicalizeNativeTargets,
  computeAttestationHmac,
  hashFileWithBlocks,
  nativeTargetsFromFiles,
  sampleChallengeRanges,
  signManifest,
  verifyAttestationHmac,
  verifySignedManifest
} from './manifest-core'
import { generateEd25519KeyPair } from '../crypto/primitives'

/* ============================================================
 * Phase 4 — เกณฑ์ผ่าน (Definition of Done):
 * 1. Manifest Tamper Test — แก้ไฟล์จำลอง 1 ไบต์ ต้องถูกจับ
 * 2. Relay Attack Prevention — exporter ต่างกัน (คนละ TLS session) ต้องถูกปฏิเสธ
 * 3. Signature Verification — ตรวจ/ปฏิเสธ/revoke ลายเซ็น Ed25519
 * ============================================================ */

function pemPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateEd25519KeyPair()
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}

function sha256OfRange(bytes: Buffer, range: { offset: number; length: number }): string {
  return createHash('sha256').update(bytes.subarray(range.offset, range.offset + range.length)).digest('hex')
}

describe('manifest building & signing', () => {
  it('คำนวณ hash รวมและ blockHashes64k ครบรวมขอบหางไฟล์', () => {
    const data = Buffer.alloc(ATTESTATION_BLOCK_SIZE + 100, 7)
    const entry = hashFileWithBlocks(data)
    expect(entry.size).toBe(data.length)
    expect(entry.blockHashes64k).toHaveLength(2)
    expect(entry.sha256).toHaveLength(64)
  })

  it('เซ็นและตรวจ manifest ด้วย Ed25519', () => {
    const keys = pemPair()
    const keyId = deriveKeyIdFromPublicKeyPem(keys.publicKeyPem)
    const body = buildManifestBodyFromBuffers('1.0.0', 'win32', 'x64', Date.now(), new Map([
      ['app.asar', Buffer.from('fake-asar-content'.repeat(4096))]
    ]))
    const manifest = signManifest(body, keys.privateKeyPem, keyId)
    expect(verifySignedManifest(manifest, { [keyId]: keys.publicKeyPem }).ok).toBe(true)
    // key ที่ไม่เชื่อถือ → ปฏิเสธ
    expect(verifySignedManifest(manifest, { 'other-key': keys.publicKeyPem }).ok).toBe(false)
    // revoke → ปฏิเสธ
    expect(
      verifySignedManifest(manifest, { [keyId]: keys.publicKeyPem }, new Set([manifest.manifestId])).ok
    ).toBe(false)
  })

  it('ไฟล์ที่ถูกดัดแปรหลังอยุ่เซ็น ต้องถูกจับที่ลายเซ็น', () => {
    const keys = pemPair()
    const keyId = deriveKeyIdFromPublicKeyPem(keys.publicKeyPem)
    const body = buildManifestBodyFromBuffers('1.0.0', 'win32', 'x64', 1, new Map([
      ['a.bin', Buffer.from([1, 2, 3])]
    ]))
    const manifest = signManifest(body, keys.privateKeyPem, keyId)
    const tampered = { ...manifest, appVersion: '9.9.9' }
    expect(verifySignedManifest(tampered, { [keyId]: keys.publicKeyPem }).ok).toBe(false)
  })
})

describe('Manifest Tamper Test (Definition of Done #1)', () => {
  it('แก้ไฟล์จำลอง 1 ไบต์ → ตรวจพบว่า HMAC ของบล็อกที่สุ่มถามไม่ตรง', () => {
    const keys = pemPair()
    const keyId = deriveKeyIdFromPublicKeyPem(keys.publicKeyPem)
    const exporter = Buffer.alloc(32, 11)

    const genuine = Buffer.alloc(2 * ATTESTATION_BLOCK_SIZE, 0x42)
    const tampered = Buffer.from(genuine)
    const originalByte = tampered.at(10_000)
    if (originalByte === undefined) throw new Error('unexpected empty buffer')
    tampered[10_000] = originalByte ^ 0xff // แก้ไฟล์ 1 ไบต์

    const body = buildManifestBodyFromBuffers('1.0.0', 'win32', 'x64', Date.now(), new Map([['app.asar', genuine]]))
    const manifest = signManifest(body, keys.privateKeyPem, keyId)
    expect(verifySignedManifest(manifest, { [keyId]: keys.publicKeyPem }).ok).toBe(true)

    // เครื่องแม่สุ่มถามสองบล็อกจาก manifest ที่เซ็นไว้
    const ranges = sampleChallengeRanges(manifest.files, 2, () => 0)
    expect(ranges).toHaveLength(2)
    const challenge = {
      challengeId: 'c1',
      serverNonce: Buffer.alloc(32, 1).toString('base64'),
      manifestHash: computeManifestHash(body)
    }
    const honestDigests = ranges.map((range) => sha256OfRange(genuine, range))

    // ไฟล์จริง → ผ่าน
    expect(
      verifyAttestationHmac(
        exporter,
        { ...challenge, sampleDigests: honestDigests },
        computeAttestationHmac(exporter, { ...challenge, sampleDigests: honestDigests }).toString('base64')
      )
    ).toBe(true)

    // ไฟล์ถูกแก้ → digest ต้องไม่เท่ากับ blockHashes64k ที่เซ็นไว้ จึง HMAC ไม่ตรงและถูกปฏิเสธ
    const firstRange = ranges[0]!
    const secondRange = ranges[1]!
    const tamperedBlockIndex = Math.floor(firstRange.offset / ATTESTATION_BLOCK_SIZE)
    const firstDigest = sha256OfRange(tampered, firstRange)
    expect(firstDigest).not.toBe(manifest.files['app.asar']?.blockHashes64k[tamperedBlockIndex])
    expect(
      verifyAttestationHmac(
        exporter,
        { ...challenge, sampleDigests: honestDigests },
        computeAttestationHmac(exporter, {
          ...challenge,
          sampleDigests: [firstDigest, sha256OfRange(genuine, secondRange)]
        }).toString('base64')
      )
    ).toBe(false)
  })
})

describe('Relay Attack Prevention (Definition of Done #2)', () => {
  it('challenge ถูกย้ายไปตอบต่าง TLS session (exporter ต่างกัน) → ปฏิเสธทันที', () => {
    // ไฟล์แท้เดียวกัน แต่ท่อ TLS ต่างกัน (exporter ของแต่ละเชื่อมต่อไม่ซ้ำกัน)
    const genuine = Buffer.alloc(ATTESTATION_BLOCK_SIZE + 500, 0x99)
    const body = buildManifestBodyFromBuffers('1.0.0', 'win32', 'x64', Date.now(), new Map([['app.asar', genuine]]))
    const challenge = {
      challengeId: 'c2',
      serverNonce: Buffer.alloc(32, 2).toString('base64'),
      manifestHash: computeManifestHash(body)
    }
    const ranges = sampleChallengeRanges(body.files, 1, () => 0)
    const digests = ranges.map((range) => sha256OfRange(genuine, range))

    const exporterSessionA = Buffer.alloc(32, 0xaa)
    const exporterSessionB = Buffer.alloc(32, 0xbb)

    // Client B ยืม challenge ของ A ไปคำนวณในท่อตัวเองแล้วส่งคำตอบกลับมา
    const forgedHmac = computeAttestationHmac(exporterSessionB, {
      ...challenge,
      sampleDigests: digests
    }).toString('base64')

    // เครื่องแม่ตรวจด้วย exporter ของท่อ A → ต้องปฏิเสธ
    expect(
      verifyAttestationHmac(exporterSessionA, { ...challenge, sampleDigests: digests }, forgedHmac)
    ).toBe(false)
    // exporter เดียวกับที่คำนวณจริงเท่านั้นที่ตรวจผ่าน
    expect(
      verifyAttestationHmac(exporterSessionB, { ...challenge, sampleDigests: digests }, forgedHmac)
    ).toBe(true)
  })
})

describe('native attestation payload (targets + digests)', () => {
  const base = {
    challengeId: 'c-1',
    serverNonce: 'nonce',
    manifestHash: 'm'.repeat(64),
    sampleDigests: ['a'.repeat(64), 'b'.repeat(64)]
  }

  it('canonicalize targets: เรียงตาม path + sha256 ตัวพิมพ์เล็ก', () => {
    expect(
      canonicalizeNativeTargets([
        { relativePath: 'z.bin', sha256: 'A'.repeat(64) },
        { relativePath: 'a.bin', sha256: 'B'.repeat(64) }
      ])
    ).toBe(`a.bin:${'b'.repeat(64)},z.bin:${'a'.repeat(64)}`)
  })

  it('payload ผูก targets — เปลี่ยน target แล้วลายเซ็นเพี้ยน', () => {
    const withOne = buildNativeAttestationPayload({
      ...base,
      targets: [{ relativePath: 'app.asar', sha256: 'c'.repeat(64) }]
    })
    const withFake = buildNativeAttestationPayload({
      ...base,
      targets: [{ relativePath: 'app.asar', sha256: 'd'.repeat(64) }]
    })
    expect(withOne).not.toBe(withFake)
    expect(withOne).toContain('app.asar:' + 'c'.repeat(64))
  })

  it('nativeTargetsFromFiles ครอบทุกไฟล์ใน manifest (ไม่ใช่แค่ asar)', () => {
    const body = buildManifestBodyFromBuffers('1.0.0', 'win32', 'x64', 1, new Map([
      ['app.asar', Buffer.alloc(16, 1)],
      ['native/os_guard.node', Buffer.alloc(16, 2)]
    ]))
    const targets = nativeTargetsFromFiles(body.files)
    expect(targets.map((t) => t.relativePath).sort()).toEqual(['app.asar', 'native/os_guard.node'])
  })
})

describe('sampleChallengeRanges (โครงการสุ่มถามระดับไบต์)', () => {
  it('offset aligned กับบล็อก 64KB และตัดขอบหางไฟล์ให้ถูก', () => {
    const smallSize = 10 * 1024
    const body = buildManifestBodyFromBuffers('1.0.0', 'linux', 'x64', Date.now(), new Map([
      ['small.bin', Buffer.alloc(smallSize)]
    ]))
    const ranges = sampleChallengeRanges(body.files, 3, () => 0)
    expect(ranges).toHaveLength(1)
    const alignedRange = ranges[0]!
    expect(alignedRange.length).toBe(smallSize)
    const edgeRange = sampleChallengeRanges(body.files, 3, () => 0.999)[0]!
    expect(edgeRange.length).toBe(smallSize)
    expect(edgeRange.offset).toBe(0)
  })

  it('ไฟล์ใหญ่หลายบล็อก → ได้หลายตำแหน่งและไม่ซ้ำ (หากไม่ซ้ำกัน)', () => {
    const big = Buffer.alloc(ATTESTATION_BLOCK_SIZE * 4)
    const body = buildManifestBodyFromBuffers('1.0.0', 'linux', 'x64', Date.now(), new Map([['big.bin', big]]))
    const ranges = sampleChallengeRanges(body.files, 3, () => 0.5)
    expect(ranges).toHaveLength(3)
    const distinctOffsets = new Set(ranges.map((range) => `${range.offset}:${range.length}`))
    expect(distinctOffsets.size).toBe(3)
    for (const range of ranges) {
      expect(range.length).toBe(Math.min(ATTESTATION_BLOCK_SIZE, big.length - range.offset))
    }
  })
})

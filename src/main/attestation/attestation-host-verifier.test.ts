import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ATTESTATION_BLOCK_SIZE,
  computeManifestHash,
  deriveKeyIdFromPublicKeyPem,
  type AttestationChallenge,
  type AttestationSampleRange,
  type SignedAppManifest
} from '@shared/attestation-schema'
import { deriveDeviceId } from '@shared/device-roster-schema'
import {
  buildManifestBodyFromBuffers,
  buildNativeAttestationPayload,
  computeAttestationHmac,
  signManifest
} from './manifest-core'
import { shaOf } from './manifest-core.test-helpers'
import { AttestationHostService } from './host-verifier'
import { AttestationResponder, challengeTargets } from './client-responder'
import { ed25519Sign, generateEd25519KeyPair } from '../crypto/primitives'
import type { AttestationSnapshot } from './manifest'
import type { NativeAttestationSigner } from './native-attestation'

/* ============================================================
 * Phase 4.2 — ทดสอบ AttestationHostService (เครื่องแม่) + AttestationResponder (นักเรียน)
 * - ขอแรกภายใน 1.5s หลัง established แล้วสุ่มถามใหม่ตามช่วง (45–120s)
 * - deadline 2.5s ไม่มีคำตอบ → fail-closed
 * - Manifest Tamper และ Relay Attack (host key + Hash ผูกกับ TLS exporter)
 * ============================================================ */

const keyHolder = vi.hoisted(() => ({
  keys: {} as Record<string, string>,
  revoked: [] as string[]
}))

vi.mock('./trusted-keys', () => ({
  trustedKeyPemSet: () => ({ ...keyHolder.keys }),
  revokedManifestIdSet: () => new Set(keyHolder.revoked)
}))

interface FakeTlsServer {
  sent: Array<{ studentId: string; payload: unknown }>
  exporterFor: Map<string, Buffer>
  sendToStudent(studentId: string, _type: string, payload: unknown): void
  getStudentExporter(studentId: string): Buffer | null
}

function fakeRoom(): { room: { tlsServerInstance: FakeTlsServer }; server: FakeTlsServer } {
  const sent: Array<{ studentId: string; payload: unknown }> = []
  const server: FakeTlsServer = {
    sent,
    exporterFor: new Map(),
    sendToStudent(studentId, _type, payload) {
      sent.push({ studentId, payload })
    },
    getStudentExporter(studentId) {
      return this.exporterFor.get(studentId) ?? null
    }
  }
  return { room: { tlsServerInstance: server }, server }
}

interface SnapshotFixture {
  snapshot: AttestationSnapshot
  manifest: SignedAppManifest
  tempDir: string
  cleanup(): void
}

/** ไฟล์จำลอง 2 บล็อก 64 KB ใน temp dir + manifest (เซ็นจริงด้วย Ed25519 ของ keygen จำลอง) */
function makeSignedSnapshot(privateKeys: { publicPem: string; privatePem: string }): SnapshotFixture {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-attest-'))
  const filePath = path.join(tempDir, 'app.bin')
  fs.writeFileSync(filePath, Buffer.alloc(ATTESTATION_BLOCK_SIZE * 2, 0x42))
  const body = buildManifestBodyFromBuffers('1.0.0', 'win32', 'x64', 1, new Map([
    ['app.bin', fs.readFileSync(filePath)]
  ]))
  const manifest = signManifest(body, privateKeys.privatePem, deriveKeyIdFromPublicKeyPem(privateKeys.publicPem))
  const snapshot: AttestationSnapshot = {
    root: tempDir,
    manifest,
    manifestHash: computeManifestHash(body),
    body,
    paths: { 'app.bin': filePath }
  }
  return { snapshot, manifest, tempDir, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) }
}

function honestDigests(snapshot: AttestationSnapshot, ranges: AttestationSampleRange[]): string[] {
  const bytes = fs.readFileSync(snapshot.paths['app.bin'] ?? '')
  return ranges.map((range) => shaOf(bytes.subarray(range.offset, range.offset + range.length)))
}

type Ed25519KeyPair = ReturnType<typeof generateEd25519KeyPair>

function rawPublicKeyHex(pair: Ed25519KeyPair): string {
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x?: string }
  if (!jwk.x) throw new Error('missing jwk.x')
  return Buffer.from(jwk.x, 'base64url').toString('hex')
}

function makeNativeSigner(
  privateKey: Ed25519KeyPair['privateKey'],
  tamper?: (input: Parameters<typeof buildNativeAttestationPayload>[0]) => Parameters<typeof buildNativeAttestationPayload>[0]
): NativeAttestationSigner {
  return {
    signAttestation: (request) => {
      const payload = buildNativeAttestationPayload(tamper ? tamper(request) : request)
      return ed25519Sign(payload, privateKey).toString('base64')
    }
  }
}

describe('AttestationHostService + AttestationResponder (E2E logic)', () => {
  let rooms: ReturnType<typeof fakeRoom>
  let exporter: Buffer
  let snapshotCtx: SnapshotFixture
  let keys: { publicPem: string; privatePem: string; keyId: string }
  let nativeKeys: Ed25519KeyPair
  let nativeKeyHex: string
  const failures: Array<{ studentId: string; reason: string }> = []
  const successes: string[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    const generated = generateEd25519KeyPair()
    keys = {
      publicPem: generated.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privatePem: generated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: ''
    }
    keys.keyId = deriveKeyIdFromPublicKeyPem(keys.publicPem)
    keyHolder.keys = { [keys.keyId]: keys.publicPem }
    keyHolder.revoked = []
    nativeKeys = generateEd25519KeyPair()
    nativeKeyHex = rawPublicKeyHex(nativeKeys)
    exporter = Buffer.alloc(32, 0x77)
    rooms = fakeRoom()
    rooms.server.exporterFor.set('s1', exporter)
    snapshotCtx = makeSignedSnapshot(keys)
    failures.length = 0
    successes.length = 0
  })

  afterEach(() => {
    snapshotCtx.cleanup()
    vi.useRealTimers()
  })

  function buildHost(isDev: boolean, enforced: boolean, minVersion?: string): AttestationHostService {
    return new AttestationHostService({
      getRoom: () => rooms.room as never,
      isDev: () => isDev,
      isSignatureEnforced: () => enforced,
      ...(minVersion !== undefined ? { minAppVersion: () => minVersion } : {}),
      devicePublicKeyHex: () => nativeKeyHex,
      onVerified: (ok) => successes.push(ok.studentId),
      onFailed: (failure) => failures.push({ studentId: failure.studentId, reason: failure.reason }),
      randomInterval: () => 45_000
    })
  }

  /** เดินเครื่องตามจริง: responder ตอบข้อความเข้าท่อ (สมมุติ sendToHost) แล้ว host รับ */
  function wireResponder(
    host: AttestationHostService,
    snapshot: AttestationSnapshot = snapshotCtx.snapshot,
    options: { isDev?: boolean; nativeSigner?: NativeAttestationSigner; deviceId?: string | null } = {}
  ): AttestationResponder {
    const deviceId = options.deviceId === undefined ? 'd'.repeat(32) : options.deviceId
    return new AttestationResponder({
      sendToHost: (_type, payload) => {
        host.handleResponse('s1', payload)
      },
      getTlsExporter: () => exporter,
      getSnapshot: () => snapshot,
      isDev: () => options.isDev ?? true,
      getDeviceId: () => deviceId,
      nativeSigner: options.nativeSigner ?? { signAttestation: () => null }
    })
  }

  it('minAppVersion: build เก่าที่เซ็นแล้วถูกปฏิเสธ (กัน downgrade)', () => {
    const host = buildHost(true, true, '2.0.0')
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    wireResponder(host).handleChallengeMessage(rooms.server.sent[0]!.payload)
    expect(successes).toHaveLength(0)
    expect(failures.map((f) => f.reason)).toContain('app-version-too-old')
  })

  it('ตอบตามไฟล์จริง → ผ่าน (แนบ manifest ครั้งแรก) และสุ่มถามรอบถัดไป', () => {
    const host = buildHost(true, false)
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    const sent = rooms.server.sent
    expect(sent).toHaveLength(1)
    expect((sent[0]!.payload as { requireManifest: boolean }).requireManifest).toBe(true)

    wireResponder(host).handleChallengeMessage(sent[0]!.payload)
    expect(failures).toHaveLength(0)
    expect(successes).toEqual(['s1'])
    expect(host.getStatus('s1')).toEqual({
      tracked: true,
      manifestHash: snapshotCtx.snapshot.manifestHash,
      signed: true
    })

    vi.advanceTimersByTime(45_000)
    expect(rooms.server.sent.length).toBe(2)
    // ครั้งถัดไปจาก response ที่สำเร็จ ต้องไม่ขอ manifest อีก
    expect((rooms.server.sent[1]!.payload as { requireManifest: boolean }).requireManifest).toBe(false)
  })

  it('ไฟล์ถูกแก้ 1 ไบต์ → digest ไม่ตรง blockHashes64k → fail-closed (ตอนสุ่มถามกลางสอบ)', () => {
    const host = buildHost(true, false)
    const responder = wireResponder(host)
    host.startExam(['s1'])
    // รอบแรก (join): ยืนยัน manifest + ลายเซ็น → ผ่าน
    vi.advanceTimersByTime(1_500)
    responder.handleChallengeMessage(rooms.server.sent[0]!.payload)
    expect(successes).toHaveLength(1)
    // รอบถัดไป (กลางสอบ): เครื่องแม่สุ่มถามบล็อกจริงจาก manifest ที่เซ็นไว้
    vi.advanceTimersByTime(45_000)
    const challenge = rooms.server.sent[1]!.payload as {
      challengeId: string
      serverNonce: string
      sampleRanges: AttestationSampleRange[]
    }
    expect(challenge.sampleRanges.length).toBeGreaterThan(0)
    // ผู้สอบโกง: คำนวณ digest จากไฟล์ที่ถูกแก้บนดิสก์ (แก้ 1 ไบต์)
    const filePath = snapshotCtx.snapshot.paths['app.bin']!
    const tampered = Buffer.from(fs.readFileSync(filePath))
    const currentByte = tampered.at(100)
    if (currentByte === undefined) throw new Error('unexpected empty buffer')
    tampered[100] = currentByte ^ 0xff
    const responseHmac = computeAttestationHmac(exporter, {
      challengeId: challenge.challengeId,
      serverNonce: challenge.serverNonce,
      manifestHash: snapshotCtx.snapshot.manifestHash ?? '',
      sampleDigests: challenge.sampleRanges.map(
        (range) => shaOf(tampered.subarray(range.offset, range.offset + range.length))
      )
    }).toString('base64')
    const outcome = host.handleResponse('s1', {
      challengeId: challenge.challengeId,
      responseHmac,
      manifestHash: snapshotCtx.snapshot.manifestHash!
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('response-hmac-mismatch')
    expect(failures.map((f) => f.reason)).toEqual(['response-hmac-mismatch'])
  })

  it('Relay Attack: คำตอบที่ผลิตในคนละ TLS session (exporter ต่างกัน) ต้องถูกปฏิเสธ', () => {
    const host = buildHost(true, false)
    wireResponder(host)
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    const challenge = rooms.server.sent[0]!.payload as {
      challengeId: string
      serverNonce: string
      sampleRanges: AttestationSampleRange[]
    }
    const otherExporter = Buffer.alloc(32, 0x55)
    const responseHmac = computeAttestationHmac(otherExporter, {
      challengeId: challenge.challengeId,
      serverNonce: challenge.serverNonce,
      manifestHash: snapshotCtx.snapshot.manifestHash ?? '',
      sampleDigests: honestDigests(snapshotCtx.snapshot, challenge.sampleRanges)
    }).toString('base64')
    const outcome = host.handleResponse('s1', {
      challengeId: challenge.challengeId,
      responseHmac,
      manifestHash: snapshotCtx.snapshot.manifestHash,
      manifest: snapshotCtx.manifest,
      sampleCount: challenge.sampleRanges.length
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('response-hmac-mismatch')
  })

  it('ไม่ตอบภายใน deadline (2.5s) → fail และกำหนดรอบถัดไป', () => {
    const host = buildHost(true, false)
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    vi.advanceTimersByTime(2_500)
    expect(failures.map((f) => f.reason)).toEqual(['response-deadline'])
    vi.advanceTimersByTime(45_000)
    expect(rooms.server.sent.length).toBe(2)
  })

  it('dev unsigned manifest ยอมรับ (permissive) แต่ strict mode ปฏิเสธ', () => {
    // สนาม dev: snapshot ที่ไม่เซ็น (keyId = dev-unsigned) — block แรกตรงกับไฟล์จริง (0x42)
    const unsignedBody = buildManifestBodyFromBuffers('1.0.0', 'win32', 'x64', 2, new Map([
      ['app.bin', Buffer.alloc(ATTESTATION_BLOCK_SIZE, 0x42)]
    ]))
    const unsignedSnapshot: AttestationSnapshot = {
      root: snapshotCtx.tempDir,
      manifest: { ...unsignedBody, keyId: 'dev-unsigned', signatureBase64: '' },
      manifestHash: computeManifestHash(unsignedBody),
      body: unsignedBody,
      paths: { 'app.bin': snapshotCtx.snapshot.paths['app.bin'] ?? '' }
    }

    const hostDev = buildHost(true, false)
    const devResponder = wireResponder(hostDev, unsignedSnapshot)
    hostDev.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    devResponder.handleChallengeMessage(rooms.server.sent[0]!.payload)
    expect(failures).toHaveLength(0)
    expect(successes).toEqual(['s1'])
    expect(hostDev.getStatus('s1').signed).toBe(false)

    // ครูกดสวิตช์บังคับตรวจลายเซ็น → dev-unsigned ถูกปฏิเสธ
    failures.length = 0
    successes.length = 0
    const hostStrict = buildHost(true, true)
    const strictResponder = wireResponder(hostStrict, unsignedSnapshot)
    hostStrict.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    // ท่อเดียวกันกับของ dev จึงส่ง challenge ซ้อนต่อ (sent[1] = ของ strict host)
    strictResponder.handleChallengeMessage(rooms.server.sent[1]!.payload)
    expect(successes).toHaveLength(0)
    expect(failures.map((f) => f.reason)).toEqual(['untrusted-key:dev-unsigned'])
  })

  it('ลายเซ็นถูกต้อง + โหมด enforce → ผ่าน', () => {
    const host = buildHost(true, true)
    const responder = wireResponder(host)
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    responder.handleChallengeMessage(rooms.server.sent[0]!.payload)
    expect(failures).toHaveLength(0)
    expect(successes).toEqual(['s1'])
  })

  it('manifestHash เปลี่ยนหลังตรวจแล้ว → ปฏิเสธ (manifest-hash-changed)', () => {
    const host = buildHost(true, false)
    const responder = wireResponder(host)
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    responder.handleChallengeMessage(rooms.server.sent[0]!.payload)
    expect(successes).toEqual(['s1'])
    vi.advanceTimersByTime(45_000)
    const secondChallenge = rooms.server.sent[1]!.payload as {
      challengeId: string
      serverNonce: string
      sampleRanges: AttestationSampleRange[]
    }
    const responseHmac = computeAttestationHmac(exporter, {
      challengeId: secondChallenge.challengeId,
      serverNonce: secondChallenge.serverNonce,
      manifestHash: 'a'.repeat(64),
      sampleDigests: honestDigests(snapshotCtx.snapshot, secondChallenge.sampleRanges)
    }).toString('base64')
    const outcome = host.handleResponse('s1', {
      challengeId: secondChallenge.challengeId,
      responseHmac,
      manifestHash: 'a'.repeat(64)
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('manifest-hash-changed')
  })

  it('production: bootstrap manifest ก่อน แล้ว challenge ถัดไปมี expectedAsarSha256 + native signature ถูกต้อง → ผ่าน', () => {
    const host = buildHost(false, true)
    const responder = wireResponder(host, snapshotCtx.snapshot, {
      isDev: false,
      nativeSigner: makeNativeSigner(nativeKeys.privateKey)
    })
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    // challenge แรก: ยังไม่รู้ manifest จึง bootstrap ด้วย HMAC + manifest ที่เซ็นแล้ว
    responder.handleChallengeMessage(rooms.server.sent[0]!.payload)
    expect(failures).toHaveLength(0)
    expect(successes).toEqual(['s1'])
    // challenge ถัดไป: host รู้ manifest แล้ว → บังคับ native signature
    vi.advanceTimersByTime(45_000)
    const challenge = rooms.server.sent[1]!.payload as AttestationChallenge
    expect(challenge.expectedAsarSha256).toBe(snapshotCtx.snapshot.body!.files['app.bin']!.sha256)
    expect(challenge.targetRelativePath).toBe('app.bin')
    // 1) ต้องมี target ครบทุกไฟล์ใน manifest ให้ native hash เอง
    expect(challenge.nativeTargets).toEqual([
      { relativePath: 'app.bin', sha256: snapshotCtx.snapshot.body!.files['app.bin']!.sha256 }
    ])
    responder.handleChallengeMessage(challenge)
    expect(failures).toHaveLength(0)
    expect(successes).toEqual(['s1', 's1'])
  })

  it('production: native signature ถูกแก้ payload → ปฏิเสธ native-signature-invalid', () => {
    const host = buildHost(false, true)
    const responder = wireResponder(host, snapshotCtx.snapshot, {
      isDev: false,
      nativeSigner: makeNativeSigner(nativeKeys.privateKey, (input) => ({
        ...input,
        manifestHash: 'b'.repeat(64)
      }))
    })
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    responder.handleChallengeMessage(rooms.server.sent[0]!.payload)
    vi.advanceTimersByTime(45_000)
    responder.handleChallengeMessage(rooms.server.sent[1]!.payload)
    expect(successes).toEqual(['s1'])
    expect(failures.map((f) => f.reason)).toEqual(['native-signature-invalid'])
  })

  it('production: native เซ็นด้วย targets ปลอม (ไม่ตรง manifest) → native-signature-invalid', () => {
    const host = buildHost(false, true)
    const responder = wireResponder(host, snapshotCtx.snapshot, {
      isDev: false,
      // จำลอง client ที่พยายามส่ง target list เอง (เช่นข้ามการ hash addon บางไฟล์)
      nativeSigner: makeNativeSigner(nativeKeys.privateKey, (input) => ({
        ...input,
        targets: [{ relativePath: 'app.bin', sha256: 'c'.repeat(64) }]
      }))
    })
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    responder.handleChallengeMessage(rooms.server.sent[0]!.payload)
    vi.advanceTimersByTime(45_000)
    responder.handleChallengeMessage(rooms.server.sent[1]!.payload)
    expect(successes).toEqual(['s1'])
    expect(failures.map((f) => f.reason)).toEqual(['native-signature-invalid'])
  })

  it('challengeTargets: map legacy expectedAsarSha256 ได้', () => {
    expect(
      challengeTargets({
        challengeId: 'x',
        serverNonce: 'n'.repeat(43),
        sampleRanges: [],
        deadlineMs: 2_500,
        requireManifest: false,
        expectedAsarSha256: 'd'.repeat(64),
        targetRelativePath: 'app.bin'
      })
    ).toEqual([{ relativePath: 'app.bin', sha256: 'd'.repeat(64) }])
  })

  it('production: ไม่มี nativeSignature ใน challenge ที่มี expected hash → ปฏิเสธ native-signature-missing', () => {
    const host = buildHost(false, true)
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    const bootstrap = rooms.server.sent[0]!.payload as AttestationChallenge
    // bootstrap: ส่ง manifest + HMAC (ยังไม่มี expected hash จึงยังไม่บังคับ native)
    const bootstrapHmac = computeAttestationHmac(exporter, {
      challengeId: bootstrap.challengeId,
      serverNonce: bootstrap.serverNonce,
      manifestHash: snapshotCtx.snapshot.manifestHash!,
      sampleDigests: []
    }).toString('base64')
    const first = host.handleResponse('s1', {
      challengeId: bootstrap.challengeId,
      responseHmac: bootstrapHmac,
      manifestHash: snapshotCtx.snapshot.manifestHash,
      manifest: snapshotCtx.manifest,
      deviceId: 'd'.repeat(32),
      sampleCount: bootstrap.sampleRanges.length
    })
    expect(first.ok).toBe(true)
    vi.advanceTimersByTime(45_000)
    const challenge = rooms.server.sent[1]!.payload as AttestationChallenge
    const responseHmac = computeAttestationHmac(exporter, {
      challengeId: challenge.challengeId,
      serverNonce: challenge.serverNonce,
      manifestHash: snapshotCtx.snapshot.manifestHash!,
      sampleDigests: honestDigests(snapshotCtx.snapshot, challenge.sampleRanges)
    }).toString('base64')
    const outcome = host.handleResponse('s1', {
      challengeId: challenge.challengeId,
      responseHmac,
      manifestHash: snapshotCtx.snapshot.manifestHash,
      deviceId: 'd'.repeat(32),
      sampleCount: challenge.sampleRanges.length
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('native-signature-missing')
  })

  it('production: native signer ไม่พร้อม → responder ไม่ส่ง response (fail closed)', () => {
    const sendToHost = vi.fn()
    const responder = new AttestationResponder({
      sendToHost,
      getTlsExporter: () => exporter,
      getSnapshot: () => snapshotCtx.snapshot,
      isDev: () => false,
      nativeSigner: { signAttestation: () => null }
    })
    const challenge: AttestationChallenge = {
      challengeId: 'native-missing',
      serverNonce: 'n'.repeat(43),
      sampleRanges: [],
      deadlineMs: 2_500,
      requireManifest: true,
      expectedAsarSha256: snapshotCtx.snapshot.body!.files['app.bin']!.sha256,
      targetRelativePath: 'app.bin'
    }
    expect(responder.respond(challenge)).toBe(false)
    expect(sendToHost).not.toHaveBeenCalled()
  })

  it('dev: native signer พร้อม → แนบ nativeSignature ใน response', () => {
    const sendToHost = vi.fn()
    const responder = new AttestationResponder({
      sendToHost,
      getTlsExporter: () => exporter,
      getSnapshot: () => snapshotCtx.snapshot,
      isDev: () => true,
      nativeSigner: makeNativeSigner(nativeKeys.privateKey)
    })
    const challenge: AttestationChallenge = {
      challengeId: 'native-present',
      serverNonce: 'n'.repeat(43),
      sampleRanges: [],
      deadlineMs: 2_500,
      requireManifest: false,
      expectedAsarSha256: snapshotCtx.snapshot.body!.files['app.bin']!.sha256,
      targetRelativePath: 'app.bin'
    }
    expect(responder.respond(challenge)).toBe(true)
    const payload = sendToHost.mock.calls[0]?.[1] as { nativeSignature?: string }
    expect(payload.nativeSignature).toBeTruthy()
  })

  it('production: ไม่มี deviceId → ปฏิเสธ device-id-missing', () => {
    const host = new AttestationHostService({
      getRoom: () => rooms.room as never,
      isDev: () => false,
      isSignatureEnforced: () => true,
      devicePublicKeyHex: () => nativeKeyHex,
      onVerified: (ok) => successes.push(ok.studentId),
      onFailed: (failure) => failures.push({ studentId: failure.studentId, reason: failure.reason }),
      randomInterval: () => 45_000
    })
    const responder = new AttestationResponder({
      sendToHost: (_type, payload) => {
        host.handleResponse('s1', payload)
      },
      getTlsExporter: () => exporter,
      getSnapshot: () => snapshotCtx.snapshot,
      isDev: () => false,
      nativeSigner: makeNativeSigner(nativeKeys.privateKey)
    })
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    responder.handleChallengeMessage(rooms.server.sent[0]!.payload)
    expect(successes).toHaveLength(0)
    expect(failures.map((f) => f.reason)).toContain('device-id-missing')
  })

  it('TOFU: device ใหม่ enroll ครั้งแรกแล้วผ่าน challenge ถัดไป', () => {
    const deviceId = deriveDeviceId(nativeKeyHex)
    const enrolledKey = new Map<string, string>()
    const host = new AttestationHostService({
      getRoom: () => rooms.room as never,
      isDev: () => false,
      isSignatureEnforced: () => true,
      devicePublicKeyHex: (id) => (id === null ? null : (enrolledKey.get(id) ?? null)),
      enrollDevice: ({ deviceId: id, publicKeyHex }) => {
        enrolledKey.set(id, publicKeyHex)
        return { ok: true, publicKeyHex }
      },
      deviceStudentId: (id) => (id === deviceId ? 's1' : null),
      onVerified: (ok) => successes.push(ok.studentId),
      onFailed: (failure) => failures.push({ studentId: failure.studentId, reason: failure.reason }),
      randomInterval: () => 45_000
    })
    const responder = new AttestationResponder({
      sendToHost: (_type, payload) => {
        host.handleResponse('s1', payload)
      },
      getTlsExporter: () => exporter,
      getSnapshot: () => snapshotCtx.snapshot,
      isDev: () => false,
      getDeviceId: () => deviceId,
      getDevicePublicKey: () => nativeKeyHex,
      nativeSigner: makeNativeSigner(nativeKeys.privateKey)
    })
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    responder.handleChallengeMessage(rooms.server.sent[0]!.payload)
    expect(failures).toHaveLength(0)
    expect(successes).toEqual(['s1'])
    expect(enrolledKey.get(deviceId)).toBe(nativeKeyHex)

    vi.advanceTimersByTime(45_000)
    responder.handleChallengeMessage(rooms.server.sent[1]!.payload)
    expect(failures).toHaveLength(0)
    expect(successes).toEqual(['s1', 's1'])
  })

  it('TOFU: device ที่ถูก block → ปฏิเสธ device-blocked', () => {
    const deviceId = deriveDeviceId(nativeKeyHex)
    const host = new AttestationHostService({
      getRoom: () => rooms.room as never,
      isDev: () => false,
      isSignatureEnforced: () => true,
      devicePublicKeyHex: () => null,
      enrollDevice: () => ({ ok: false, reason: 'device-blocked' }),
      onVerified: (ok) => successes.push(ok.studentId),
      onFailed: (failure) => failures.push({ studentId: failure.studentId, reason: failure.reason }),
      randomInterval: () => 45_000
    })
    const responder = new AttestationResponder({
      sendToHost: (_type, payload) => {
        host.handleResponse('s1', payload)
      },
      getTlsExporter: () => exporter,
      getSnapshot: () => snapshotCtx.snapshot,
      isDev: () => false,
      getDeviceId: () => deviceId,
      getDevicePublicKey: () => nativeKeyHex,
      nativeSigner: makeNativeSigner(nativeKeys.privateKey)
    })
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    responder.handleChallengeMessage(rooms.server.sent[0]!.payload)
    expect(failures.map((f) => f.reason)).toContain('device-blocked')
  })

  it('production: deviceId ที่ไม่อยู่ใน roster → ปฏิเสธ native-device-unknown', () => {
    const host = new AttestationHostService({
      getRoom: () => rooms.room as never,
      isDev: () => false,
      isSignatureEnforced: () => true,
      devicePublicKeyHex: (deviceId) => (deviceId === 'd'.repeat(32) ? nativeKeyHex : null),
      onVerified: (ok) => successes.push(ok.studentId),
      onFailed: (failure) => failures.push({ studentId: failure.studentId, reason: failure.reason }),
      randomInterval: () => 45_000
    })
    const responder = new AttestationResponder({
      sendToHost: (_type, payload) => {
        host.handleResponse('s1', payload)
      },
      getTlsExporter: () => exporter,
      getSnapshot: () => snapshotCtx.snapshot,
      isDev: () => false,
      getDeviceId: () => 'e'.repeat(32),
      nativeSigner: makeNativeSigner(nativeKeys.privateKey)
    })
    host.startExam(['s1'])
    vi.advanceTimersByTime(1_500)
    responder.handleChallengeMessage(rooms.server.sent[0]!.payload)
    // bootstrap ยังไม่มี targets → ยังไม่บังคับ native; รอบถัดไปบังคับ + deviceId ไม่อยู่ใน roster
    vi.advanceTimersByTime(45_000)
    responder.handleChallengeMessage(rooms.server.sent[1]!.payload)
    expect(failures.map((f) => f.reason)).toContain('native-device-unknown')
  })
})

import { describe, it, expect } from 'vitest'
import {
  generateEphemeralCert,
  generateRoomPin,
  derivePinKey,
  computeServerProof,
  computeClientAuth,
  verifyServerProof,
  verifyClientAuth,
  generateNonce,
  generateSessionToken,
  normalizeFingerprint
} from './crypto-cert'

describe('crypto-cert', () => {
  it('generates an ephemeral cert with a 64-hex SHA-256 fingerprint', async () => {
    const cert = await generateEphemeralCert()
    expect(cert.certFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(cert.certFpShort).toBe(cert.certFingerprint.slice(0, 16))
    expect(cert.keyPem).toContain('PRIVATE KEY')
    expect(cert.certPem).toContain('BEGIN CERTIFICATE')
  })

  it('generates a fresh fingerprint each call (ephemeral per room)', async () => {
    const a = await generateEphemeralCert()
    const b = await generateEphemeralCert()
    expect(a.certFingerprint).not.toBe(b.certFingerprint)
    expect(a.keyPem).not.toBe(b.keyPem)
  })

  it('generates a uniform 6-digit PIN', () => {
    for (let i = 0; i < 50; i++) {
      const pin = generateRoomPin()
      expect(pin).toMatch(/^\d{6}$/)
    }
  })

  it('verifies a correct SERVER_PROOF and rejects a wrong PIN', () => {
    const roomId = '11111111-1111-4111-8111-111111111111'
    const correctPin = '482910'
    const wrongPin = '000000'
    const fp = 'a'.repeat(64)
    const clientNonce = generateNonce()
    const serverNonce = generateNonce()

    const proof = computeServerProof(derivePinKey(correctPin, roomId), fp, clientNonce, serverNonce)
    expect(verifyServerProof(derivePinKey(correctPin, roomId), fp, clientNonce, serverNonce, proof)).toBe(true)
    // ผู้โจมตีไม่รู้ PIN — สร้าง proof จาก PIN ผิดไม่ผ่าน
    expect(verifyServerProof(derivePinKey(wrongPin, roomId), fp, clientNonce, serverNonce, proof)).toBe(false)
    // ผู้โจมตีไม่รู้ fingerprint จริงของเครื่องแม่
    expect(verifyServerProof(derivePinKey(correctPin, roomId), 'b'.repeat(64), clientNonce, serverNonce, proof)).toBe(false)
  })

  it('verifies CLIENT_AUTH and rejects tampered studentId', () => {
    const roomId = '22222222-2222-4222-8222-222222222222'
    const pin = '123456'
    const pinKey = derivePinKey(pin, roomId)
    const fp = 'c'.repeat(64)
    const clientNonce = generateNonce()
    const serverNonce = generateNonce()
    const auth = computeClientAuth(pinKey, fp, serverNonce, clientNonce, 'std-01')
    expect(verifyClientAuth(pinKey, fp, serverNonce, clientNonce, 'std-01', auth)).toBe(true)
    expect(verifyClientAuth(pinKey, fp, serverNonce, clientNonce, 'std-02', auth)).toBe(false)
  })

  it('normalizes node-style colon fingerprints', () => {
    expect(normalizeFingerprint('AA:BB:CC:DD')).toBe('aabbccdd')
  })

  it('generates opaque session tokens', () => {
    expect(generateSessionToken().length).toBeGreaterThanOrEqual(16)
    expect(generateSessionToken()).not.toBe(generateSessionToken())
  })
})

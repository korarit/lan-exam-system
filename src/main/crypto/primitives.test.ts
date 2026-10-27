import { describe, it, expect } from 'vitest'
import {
  generateAesKey,
  encryptAes256Gcm,
  decryptAes256Gcm,
  computeHmac,
  verifyHmacTimingSafe,
  sha256Hex,
  generateEd25519KeyPair,
  ed25519Sign,
  ed25519Verify,
  generateRandomBytes
} from './primitives'

describe('AES-256-GCM', () => {
  it('encrypts and decrypts back to the original data', () => {
    const key = generateAesKey()
    const plaintext = Buffer.from('คำตอบข้อสอบ #1 — secret answer', 'utf8')
    const encrypted = encryptAes256Gcm(plaintext, key)

    expect(Buffer.from(encrypted.iv, 'base64').length).toBe(12)
    expect(Buffer.from(encrypted.tag, 'base64').length).toBe(16)
    expect(encrypted.ciphertext).not.toContain('secret')

    const decrypted = decryptAes256Gcm(encrypted, key)
    expect(decrypted.equals(plaintext)).toBe(true)
  })

  it('rejects keys of the wrong size', () => {
    const badKey = generateRandomBytes(16)
    expect(() => encryptAes256Gcm('data', badKey)).toThrow(/32 bytes/)
  })

  it('throws when ciphertext is tampered by even one bit', () => {
    const key = generateAesKey()
    const encrypted = encryptAes256Gcm(Buffer.from('payload'), key)
    const tampered = Buffer.from(encrypted.ciphertext, 'base64')
    const firstByte = tampered[0] ?? 0
    tampered[0] = firstByte ^ 0x01
    expect(() =>
      decryptAes256Gcm({ ...encrypted, ciphertext: tampered.toString('base64') }, key)
    ).toThrow()
  })

  it('throws when the auth tag is tampered', () => {
    const key = generateAesKey()
    const encrypted = encryptAes256Gcm(Buffer.from('payload'), key)
    const tag = Buffer.from(encrypted.tag, 'base64')
    const lastByte = tag[tag.length - 1] ?? 0
    tag[tag.length - 1] = lastByte ^ 0xff
    expect(() =>
      decryptAes256Gcm({ ...encrypted, tag: tag.toString('base64') }, key)
    ).toThrow()
  })

  it('throws when encrypted with one key and decrypted with another', () => {
    const encrypted = encryptAes256Gcm('data', generateAesKey())
    expect(() => decryptAes256Gcm(encrypted, generateAesKey())).toThrow()
  })
})

describe('HMAC-SHA256', () => {
  it('verifies a correct MAC', () => {
    const key = generateRandomBytes(32)
    const payload = 'answer:seq=3:q=12'
    const mac = computeHmac(key, payload)
    expect(verifyHmacTimingSafe(key, payload, mac)).toBe(true)
  })

  it('rejects a MAC over modified payload (constant-time path)', () => {
    const key = generateRandomBytes(32)
    const mac = computeHmac(key, 'answer:seq=3')
    expect(verifyHmacTimingSafe(key, 'answer:seq=4', mac)).toBe(false)
  })

  it('rejects a MAC of the wrong length without throwing', () => {
    const key = generateRandomBytes(32)
    expect(verifyHmacTimingSafe(key, 'payload', Buffer.alloc(4))).toBe(false)
  })
})

describe('SHA-256', () => {
  it('hashes strings and buffers to a stable hex digest', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'))
  })
})

describe('Ed25519', () => {
  it('signs and verifies valid signatures', () => {
    const { publicKey, privateKey } = generateEd25519KeyPair()
    const manifest = Buffer.from('app-file-hashes...')
    const signature = ed25519Sign(manifest, privateKey)
    expect(ed25519Verify(manifest, signature, publicKey)).toBe(true)
  })

  it('rejects modified data', () => {
    const { publicKey, privateKey } = generateEd25519KeyPair()
    const signature = ed25519Sign('manifest v1', privateKey)
    expect(ed25519Verify('manifest v2', signature, publicKey)).toBe(false)
  })

  it('rejects invalid signature input without throwing', () => {
    const { publicKey } = generateEd25519KeyPair()
    expect(ed25519Verify('data', Buffer.alloc(10), publicKey)).toBe(false)
  })
})

describe('CSPRNG', () => {
  it('generates unique random buffers of the requested size', () => {
    const a = generateRandomBytes(32)
    const b = generateRandomBytes(32)
    expect(a.length).toBe(32)
    expect(a.equals(b)).toBe(false)
  })
})

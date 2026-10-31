import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  canonicalizeDeviceRosterBody,
  deriveDeviceId,
  type DeviceRosterBody
} from '@shared/device-roster-schema'
import { deriveKeyIdFromPublicKeyPem } from '@shared/attestation-schema'
import { ed25519Sign, generateEd25519KeyPair } from '../crypto/primitives'
import {
  buildDeviceRosterLookup,
  loadDeviceRoster,
  verifySignedDeviceRoster
} from './device-roster'

const tempDirs: string[] = []
function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-device-roster-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function keyFixture(): { publicPem: string; privatePem: string; keyId: string } {
  const pair = generateEd25519KeyPair()
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return { publicPem, privatePem, keyId: deriveKeyIdFromPublicKeyPem(publicPem) }
}

function deviceFixture(studentId?: string): { deviceId: string; publicKey: string; studentId?: string } {
  const pair = generateEd25519KeyPair()
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x?: string }
  if (!jwk.x) throw new Error('missing jwk.x')
  const publicKey = Buffer.from(jwk.x, 'base64url').toString('hex')
  const entry: { deviceId: string; publicKey: string; studentId?: string } = {
    deviceId: deriveDeviceId(publicKey),
    publicKey
  }
  if (studentId !== undefined) entry.studentId = studentId
  return entry
}

function signBody(
  body: DeviceRosterBody,
  keys: { privatePem: string; keyId: string }
): Record<string, unknown> {
  const signature = ed25519Sign(canonicalizeDeviceRosterBody(body), keys.privatePem)
  return { ...body, keyId: keys.keyId, signatureBase64: signature.toString('base64') }
}

describe('signed device roster', () => {
  it('roster ที่เซ็นถูกต้อง → ผ่าน + lookup public key ได้', () => {
    const keys = keyFixture()
    const body: DeviceRosterBody = { version: 1, roomId: 'room-1', devices: [deviceFixture('s01')] }
    const raw = signBody(body, keys)
    const verified = verifySignedDeviceRoster(raw, { [keys.keyId]: keys.publicPem })
    expect(verified).not.toBeNull()
    const lookup = buildDeviceRosterLookup(verified!)
    expect(lookup.size).toBe(1)
    expect(lookup.publicKeyHexFor(body.devices[0]!.deviceId)).toBe(body.devices[0]!.publicKey)
    expect(lookup.studentIdFor(body.devices[0]!.deviceId)).toBe('s01')
  })

  it('แก้ device แล้วไม่เซ็นใหม่ → ปฏิเสธ', () => {
    const keys = keyFixture()
    const body: DeviceRosterBody = { version: 1, devices: [deviceFixture()] }
    const raw = signBody(body, keys)
    const tampered = {
      ...raw,
      devices: [{ ...body.devices[0]!, studentId: 'attacker' }]
    }
    expect(verifySignedDeviceRoster(tampered, { [keys.keyId]: keys.publicPem })).toBeNull()
  })

  it('deviceId ไม่ตรงกับ public key → ปฏิเสธ', () => {
    const keys = keyFixture()
    const device = deviceFixture()
    const body: DeviceRosterBody = {
      version: 1,
      devices: [{ ...device, deviceId: 'a'.repeat(32) }]
    }
    const raw = signBody(body, keys)
    expect(verifySignedDeviceRoster(raw, { [keys.keyId]: keys.publicPem })).toBeNull()
  })

  it('โหลดจากไฟล์ที่ไม่มี/ลายเซ็นเสีย → null (fail-closed)', () => {
    const dir = makeDir()
    expect(loadDeviceRoster(path.join(dir, 'missing.json'))).toBeNull()
    const filePath = path.join(dir, 'bad.json')
    fs.writeFileSync(filePath, '{not json')
    expect(loadDeviceRoster(filePath)).toBeNull()
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveDeviceId } from '@shared/device-roster-schema'
import { generateEd25519KeyPair } from '../crypto/primitives'
import { HostDatabase } from '../storage/db'
import { DeviceEnrollmentService } from './device-enrollment'

function deviceFixture(): { deviceId: string; publicKey: string } {
  const pair = generateEd25519KeyPair()
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x?: string }
  if (!jwk.x) throw new Error('missing jwk.x')
  const publicKey = Buffer.from(jwk.x, 'base64url').toString('hex')
  return { deviceId: deriveDeviceId(publicKey), publicKey }
}

describe('DeviceEnrollmentService (TOFU auto-accept)', () => {
  let db: HostDatabase
  let now: number
  let service: DeviceEnrollmentService

  beforeEach(() => {
    db = new HostDatabase({ filePath: ':memory:' })
    now = 1_000
    service = new DeviceEnrollmentService(db, { now: () => now })
  })

  afterEach(() => {
    db.close()
  })

  it('join ครั้งแรก → enrolled + lookup/list ได้', () => {
    const device = deviceFixture()
    const result = service.observe({ deviceId: device.deviceId, publicKeyHex: device.publicKey, studentId: 's01' })
    expect(result).toEqual({ ok: true, status: 'enrolled', publicKeyHex: device.publicKey })
    expect(service.lookupPublicKey(device.deviceId)).toBe(device.publicKey)
    expect(service.studentIdFor(device.deviceId)).toBe('s01')
    expect(service.count()).toBe(1)
    expect(service.list()[0]).toMatchObject({
      deviceId: device.deviceId,
      publicKey: device.publicKey,
      studentId: 's01',
      status: 'active',
      firstSeenAtMs: 1_000,
      lastSeenAtMs: 1_000,
      seenCount: 1
    })
  })

  it('join ซ้ำ device เดิม → known + seenCount เพิ่ม', () => {
    const device = deviceFixture()
    service.observe({ deviceId: device.deviceId, publicKeyHex: device.publicKey, studentId: 's01' })
    now = 2_000
    const second = service.observe({ deviceId: device.deviceId, publicKeyHex: device.publicKey, studentId: 's01' })
    expect(second).toEqual({ ok: true, status: 'known', publicKeyHex: device.publicKey })
    expect(service.list()[0]).toMatchObject({ lastSeenAtMs: 2_000, seenCount: 2 })
    expect(service.count()).toBe(1)
  })

  it('device เดิมแต่ studentId ต่าง → student-conflict', () => {
    const device = deviceFixture()
    service.observe({ deviceId: device.deviceId, publicKeyHex: device.publicKey, studentId: 's01' })
    expect(
      service.observe({ deviceId: device.deviceId, publicKeyHex: device.publicKey, studentId: 's02' })
    ).toEqual({ ok: false, reason: 'student-conflict' })
  })

  it('deviceId ไม่ตรงกับ public key → device-id-mismatch', () => {
    const device = deviceFixture()
    expect(
      service.observe({ deviceId: 'a'.repeat(32), publicKeyHex: device.publicKey, studentId: 's01' })
    ).toEqual({ ok: false, reason: 'device-id-mismatch' })
  })

  it('block → lookup คืน null + observe ถูกปฏิเสธ, unblock กลับมาได้', () => {
    const device = deviceFixture()
    service.observe({ deviceId: device.deviceId, publicKeyHex: device.publicKey, studentId: 's01' })
    expect(service.setStatus(device.deviceId, 'blocked')).toBe(true)
    expect(service.lookupPublicKey(device.deviceId)).toBeNull()
    expect(
      service.observe({ deviceId: device.deviceId, publicKeyHex: device.publicKey, studentId: 's01' })
    ).toEqual({ ok: false, reason: 'blocked' })
    expect(service.setStatus(device.deviceId, 'active')).toBe(true)
    expect(service.lookupPublicKey(device.deviceId)).toBe(device.publicKey)
  })

  it('remove → ลบออกจากรายการ', () => {
    const device = deviceFixture()
    service.observe({ deviceId: device.deviceId, publicKeyHex: device.publicKey, studentId: 's01' })
    expect(service.remove(device.deviceId)).toBe(true)
    expect(service.hasDevice(device.deviceId)).toBe(false)
    expect(service.lookupPublicKey(device.deviceId)).toBeNull()
    expect(service.count()).toBe(0)
  })

  it('key รูปแบบผิด → invalid-key', () => {
    expect(
      service.observe({ deviceId: 'x', publicKeyHex: 'y', studentId: 's01' })
    ).toEqual({ ok: false, reason: 'invalid-key' })
  })
})

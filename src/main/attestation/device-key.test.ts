import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deriveDeviceId } from '@shared/device-roster-schema'
import {
  DeviceKeyStoreError,
  deviceKeyFilePath,
  loadOrCreateDeviceIdentity,
  readDeviceIdentityPublic,
  resetDeviceIdentityCacheForTests
} from './device-key'

const tempDirs: string[] = []

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-device-key-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  resetDeviceIdentityCacheForTests()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('per-device attestation key store', () => {
  it('สร้าง identity ใหม่ + deviceId ตรงกับ public key', () => {
    const dir = makeDir()
    const filePath = deviceKeyFilePath(dir)
    const identity = loadOrCreateDeviceIdentity({
      filePath,
      binding: { value: 'test:machine-a', hardware: true },
      now: () => 1_700_000_000_000
    })
    expect(identity.publicKeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(identity.seedHex).toMatch(/^[0-9a-f]{64}$/)
    expect(identity.deviceId).toBe(deriveDeviceId(identity.publicKeyHex))
    expect(identity.hardwareBound).toBe(true)
    expect(fs.existsSync(filePath)).toBe(true)
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
    expect(JSON.stringify(raw)).not.toContain(identity.seedHex)
  })

  it('โหลดซ้ำได้ identity เดิม (seed เดียวกัน)', () => {
    const dir = makeDir()
    const filePath = deviceKeyFilePath(dir)
    const first = loadOrCreateDeviceIdentity({
      filePath,
      binding: { value: 'test:machine-a', hardware: true }
    })
    resetDeviceIdentityCacheForTests()
    const second = loadOrCreateDeviceIdentity({
      filePath,
      binding: { value: 'test:machine-a', hardware: true }
    })
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.seedHex).toBe(first.seedHex)
  })

  it('copy ไฟล์ไปเครื่องอื่น (binding ต่าง) → ถอดไม่ได้ fail-closed', () => {
    const dir = makeDir()
    const filePath = deviceKeyFilePath(dir)
    loadOrCreateDeviceIdentity({
      filePath,
      binding: { value: 'test:machine-a', hardware: true }
    })
    resetDeviceIdentityCacheForTests()
    expect(() =>
      loadOrCreateDeviceIdentity({
        filePath,
        binding: { value: 'test:machine-b', hardware: true }
      })
    ).toThrow(DeviceKeyStoreError)
  })

  it('readDeviceIdentityPublic คืนเฉพาะ public data (ไม่ถอด seed)', () => {
    const dir = makeDir()
    const filePath = deviceKeyFilePath(dir)
    const identity = loadOrCreateDeviceIdentity({
      filePath,
      binding: { value: 'test:machine-a', hardware: true }
    })
    expect(readDeviceIdentityPublic(filePath)).toEqual({
      deviceId: identity.deviceId,
      publicKeyHex: identity.publicKeyHex,
      createdAtMs: identity.createdAtMs,
      hardwareBound: true
    })
  })
})

import fs from 'node:fs'
import {
  SignedDeviceRosterSchema,
  canonicalizeDeviceRosterBody,
  deriveDeviceId,
  type DeviceRosterBody
} from '@shared/device-roster-schema'
import { ed25519Verify } from '../crypto/primitives'
import { trustedKeyPemSet } from './trusted-keys'

/* ============================================================
 * Signed device roster — host เชื่อเฉพาะ key ที่อยู่ใน roster
 * (แทน native global public key ที่เดิมฝังมากับแอป)
 *
 * รูปแบบไฟล์: { version, roomId?, devices, keyId, signatureBase64 }
 * ลายเซ็น Ed25519 ครอบ canonicalizeDeviceRosterBody(body)
 * ============================================================ */

export interface DeviceRosterLookup {
  publicKeyHexFor(deviceId: string): string | null
  studentIdFor(deviceId: string): string | null
  size: number
  deviceIds(): string[]
}

/**
 * ตรวจลายเซ็น roster — คืน body เมื่อผ่าน หรือ null เมื่อรูปแบบ/คีย์/ลายเซ็นไม่ถูก
 * (ตรวจ deviceId ↔ publicKey ให้สอดคล้องกันด้วย)
 */
export function verifySignedDeviceRoster(
  raw: unknown,
  trustedKeys: Record<string, string> = trustedKeyPemSet()
): DeviceRosterBody | null {
  const parsed = SignedDeviceRosterSchema.safeParse(raw)
  if (!parsed.success) return null
  const pem = trustedKeys[parsed.data.keyId]
  if (!pem) return null
  const { keyId: _keyId, signatureBase64, ...rest } = parsed.data
  void _keyId
  const body: DeviceRosterBody = rest
  for (const device of body.devices) {
    if (deriveDeviceId(device.publicKey) !== device.deviceId.toLowerCase()) return null
  }
  const signatureOk = ed25519Verify(
    canonicalizeDeviceRosterBody(body),
    Buffer.from(signatureBase64, 'base64'),
    pem
  )
  return signatureOk ? body : null
}

/** อ่าน + ตรวจ roster จากไฟล์ (null = ไม่มี/ไม่ผ่าน — host ต้องถือว่าไม่มี device ที่เชื่อถือ) */
export function loadDeviceRoster(
  filePath: string | null | undefined,
  trustedKeys: Record<string, string> = trustedKeyPemSet()
): DeviceRosterBody | null {
  if (!filePath) return null
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return verifySignedDeviceRoster(raw, trustedKeys)
  } catch {
    return null
  }
}

export function buildDeviceRosterLookup(body: DeviceRosterBody): DeviceRosterLookup {
  const byId = new Map<string, { publicKeyHex: string; studentId: string | null }>()
  for (const device of body.devices) {
    byId.set(device.deviceId.toLowerCase(), {
      publicKeyHex: device.publicKey.toLowerCase(),
      studentId: device.studentId ?? null
    })
  }
  return {
    publicKeyHexFor(deviceId: string): string | null {
      return byId.get(deviceId.toLowerCase())?.publicKeyHex ?? null
    },
    studentIdFor(deviceId: string): string | null {
      return byId.get(deviceId.toLowerCase())?.studentId ?? null
    },
    size: byId.size,
    deviceIds(): string[] {
      return [...byId.keys()]
    }
  }
}

export function emptyDeviceRosterLookup(): DeviceRosterLookup {
  return buildDeviceRosterLookup({ version: 1, devices: [] })
}

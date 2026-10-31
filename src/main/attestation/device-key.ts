import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes
} from 'node:crypto'
import { decryptAes256Gcm, encryptAes256Gcm, type EncryptedPayload } from '../crypto/primitives'
import { deriveDeviceId } from '@shared/device-roster-schema'

/* ============================================================
 * Per-device attestation key (แทน native global signing key)
 *
 * ข้อจำกัดที่ตั้งใจ:
 * - ไม่ใช้ TPM / DPAPI / Keychain / WDAC (ตามข้อกำหนดของโปรเจกต์)
 * - private seed ถูกเข้ารหัส AES-256-GCM ด้วย key ที่ derive จาก machine identity
 *   (Windows MachineGuid / Linux machine-id / macOS IOPlatformUUID)
 * - นี่คือ "obfuscation + machine binding" ไม่ใช่ hardware root of trust:
 *   ผู้ใช้บนเครื่องเดิมที่ตั้งใจยังถอด seed ได้ — แต่ copy ไฟล์ไปเครื่องอื่นจะใช้ไม่ได้
 * - host ยังต้องตรวจ public key กับ signed roster เสมอ (ไม่เชื่อ key ที่ client ส่งมา)
 *
 * หมายเหตุ: ถ้า machine identity เปลี่ยน (hostname/MachineGuid) ไฟล์จะถอดไม่ได้
 * → fail-closed และต้อง provision ใหม่ (ถูกต้องกว่า silently สร้าง identity ใหม่)
 * ============================================================ */

export interface MachineBinding {
  value: string
  /** true = อ่าน machine id จาก OS ได้ (ไม่ใช่ fallback จาก hostname) */
  hardware: boolean
}

export interface DeviceIdentity {
  deviceId: string
  publicKeyHex: string
  /** seed 32 bytes (hex) — ส่งเข้า native addon ตอน boot เท่านั้น ไม่เขียนลงดิสก์แบบ plaintext */
  seedHex: string
  createdAtMs: number
  hardwareBound: boolean
}

export interface DeviceKeyStoreOptions {
  /** ปกติ = path.join(app.getPath('userData'), 'device-key.json') */
  filePath: string
  /** override สำหรับ test (ไม่ระบุ = อ่านจาก OS จริง) */
  binding?: MachineBinding
  now?: () => number
}

export class DeviceKeyStoreError extends Error {
  constructor(
    message: string,
    readonly reason: 'unreadable' | 'invalid-shape' | 'binding-changed' | 'write-failed'
  ) {
    super(message)
    this.name = 'DeviceKeyStoreError'
  }
}

interface DeviceKeyFile {
  version: 1
  deviceId: string
  publicKeyHex: string
  createdAtMs: number
  hardwareBound: boolean
  salt: string
  sealed: EncryptedPayload
}

const DEVICE_KEY_INFO = 'zt-exam-device-key-v1'

let cachedIdentity: DeviceIdentity | null = null
let cachedPath: string | null = null

export function deviceKeyFilePath(userDataPath: string): string {
  return path.join(userDataPath, 'device-key.json')
}

/** อ่าน machine identity ของ OS (คืน null = อ่านไม่ได้) */
function readPlatformMachineId(platform: NodeJS.Platform): string | null {
  try {
    if (platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', timeout: 3_000, windowsHide: true }
      )
      const match = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{16,})/i.exec(out)
      return match?.[1] ? `win:${match[1].toLowerCase()}` : null
    }
    if (platform === 'linux') {
      for (const candidate of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (!fs.existsSync(candidate)) continue
        const value = fs.readFileSync(candidate, 'utf8').trim()
        if (value.length > 0) return `linux:${value}`
      }
      return null
    }
    if (platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true
      })
      const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)
      return match?.[1] ? `darwin:${match[1].toLowerCase()}` : null
    }
  } catch {
    return null
  }
  return null
}

/**
 * binding ที่ใช้ derive key เข้ารหัส seed
 * - hardware=true: MachineGuid / machine-id / IOPlatformUUID
 * - hardware=false: fallback จาก hostname (ยังกัน copy ข้ามเครื่องได้ระดับหนึ่ง)
 */
export function readMachineBinding(platform: NodeJS.Platform = process.platform): MachineBinding {
  const platformId = readPlatformMachineId(platform)
  if (platformId) return { value: platformId, hardware: true }
  let username = 'unknown'
  try {
    username = os.userInfo().username
  } catch {
    // บาง sandbox ไม่ให้ userInfo — ใช้ค่า default
  }
  return {
    value: `host:${os.hostname()}:${username}:${platform}:${process.arch}`,
    hardware: false
  }
}

function deriveStoreKey(binding: MachineBinding, salt: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(binding.value, 'utf8'),
      salt,
      Buffer.from(DEVICE_KEY_INFO, 'utf8'),
      32
    )
  )
}

function jwkFromPrivate(seed: Buffer, publicKeyXB64url: string): { d: string; publicKeyHex: string } {
  const d = seed.toString('base64url')
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d, x: publicKeyXB64url },
    format: 'jwk'
  })
  const publicJwk = createPublicKey(key).export({ format: 'jwk' }) as { x?: string }
  if (!publicJwk.x || publicJwk.x !== publicKeyXB64url) {
    throw new DeviceKeyStoreError('device key public part does not match seed', 'invalid-shape')
  }
  return { d, publicKeyHex: Buffer.from(publicKeyXB64url, 'base64url').toString('hex') }
}

function isValidFile(raw: unknown): raw is DeviceKeyFile {
  if (!raw || typeof raw !== 'object') return false
  const record = raw as Record<string, unknown>
  const sealed = record.sealed as Record<string, unknown> | undefined
  return (
    record.version === 1 &&
    typeof record.deviceId === 'string' &&
    /^[0-9a-f]{32}$/.test(record.deviceId) &&
    typeof record.publicKeyHex === 'string' &&
    /^[0-9a-fA-F]{64}$/.test(record.publicKeyHex) &&
    typeof record.createdAtMs === 'number' &&
    typeof record.hardwareBound === 'boolean' &&
    typeof record.salt === 'string' &&
    !!sealed &&
    typeof sealed.iv === 'string' &&
    typeof sealed.tag === 'string' &&
    typeof sealed.ciphertext === 'string'
  )
}

function readIdentityFile(filePath: string, binding: MachineBinding): DeviceIdentity | null {
  if (!fs.existsSync(filePath)) return null
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    throw new DeviceKeyStoreError(`device key file is not valid JSON: ${filePath}`, 'unreadable')
  }
  if (!isValidFile(raw)) {
    throw new DeviceKeyStoreError(`device key file shape is invalid: ${filePath}`, 'invalid-shape')
  }
  let seed: Buffer
  try {
    const storeKey = deriveStoreKey(binding, Buffer.from(raw.salt, 'base64'))
    seed = decryptAes256Gcm(raw.sealed, storeKey)
  } catch {
    throw new DeviceKeyStoreError(
      `device key cannot be decrypted on this machine (moved or binding changed): ${filePath}`,
      'binding-changed'
    )
  }
  if (seed.length !== 32) {
    throw new DeviceKeyStoreError('device key seed length is invalid', 'invalid-shape')
  }
  const derived = jwkFromPrivate(seed, Buffer.from(raw.publicKeyHex, 'hex').toString('base64url'))
  if (derived.publicKeyHex !== raw.publicKeyHex.toLowerCase()) {
    throw new DeviceKeyStoreError('device key does not match stored public key', 'invalid-shape')
  }
  if (deriveDeviceId(derived.publicKeyHex) !== raw.deviceId) {
    throw new DeviceKeyStoreError('deviceId does not match device key', 'invalid-shape')
  }
  return {
    deviceId: raw.deviceId,
    publicKeyHex: derived.publicKeyHex,
    seedHex: seed.toString('hex'),
    createdAtMs: raw.createdAtMs,
    hardwareBound: raw.hardwareBound
  }
}

function writeIdentityFile(
  filePath: string,
  binding: MachineBinding,
  seed: Buffer,
  publicKeyHex: string,
  deviceId: string,
  createdAtMs: number
): void {
  const salt = randomBytes(16)
  const sealed = encryptAes256Gcm(seed, deriveStoreKey(binding, salt))
  const file: DeviceKeyFile = {
    version: 1,
    deviceId,
    publicKeyHex,
    createdAtMs,
    hardwareBound: binding.hardware,
    salt: salt.toString('base64'),
    sealed
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const temp = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, filePath)
  } catch (error) {
    throw new DeviceKeyStoreError(
      `cannot write device key file: ${error instanceof Error ? error.message : 'unknown'}`,
      'write-failed'
    )
  }
}

/**
 * โหลด identity เดิม หรือสร้างใหม่ถ้ายังไม่มี
 * - ไฟล์มีอยู่แต่ถอดไม่ได้ = throw (fail-closed) ไม่ silently สร้าง key ใหม่
 * - cache ตาม filePath (เรียกซ้ำได้)
 */
export function loadOrCreateDeviceIdentity(options: DeviceKeyStoreOptions): DeviceIdentity {
  if (cachedIdentity && cachedPath === options.filePath) return cachedIdentity
  const binding = options.binding ?? readMachineBinding()
  const now = options.now ?? Date.now
  let identity = readIdentityFile(options.filePath, binding)
  if (!identity) {
    const pair = generateKeyPairSync('ed25519')
    const privateJwk = pair.privateKey.export({ format: 'jwk' }) as { d?: string; x?: string }
    if (!privateJwk.d || !privateJwk.x) {
      throw new DeviceKeyStoreError('cannot export device private key', 'invalid-shape')
    }
    const seed = Buffer.from(privateJwk.d, 'base64url')
    const derived = jwkFromPrivate(seed, privateJwk.x)
    const deviceId = deriveDeviceId(derived.publicKeyHex)
    const createdAtMs = now()
    writeIdentityFile(options.filePath, binding, seed, derived.publicKeyHex, deviceId, createdAtMs)
    identity = {
      deviceId,
      publicKeyHex: derived.publicKeyHex,
      seedHex: seed.toString('hex'),
      createdAtMs,
      hardwareBound: binding.hardware
    }
  }
  cachedIdentity = identity
  cachedPath = options.filePath
  return identity
}

/** ข้อมูล public ของ identity ที่เก็บไว้ (ไม่ถอด seed) — ใช้ตอน provision roster */
export function readDeviceIdentityPublic(
  filePath: string
): { deviceId: string; publicKeyHex: string; createdAtMs: number; hardwareBound: boolean } | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!isValidFile(raw)) return null
    return {
      deviceId: raw.deviceId,
      publicKeyHex: raw.publicKeyHex.toLowerCase(),
      createdAtMs: raw.createdAtMs,
      hardwareBound: raw.hardwareBound
    }
  } catch {
    return null
  }
}

/** ใช้ใน unit test — ล้าง cache หน่วยความจำ */
export function resetDeviceIdentityCacheForTests(): void {
  cachedIdentity = null
  cachedPath = null
}

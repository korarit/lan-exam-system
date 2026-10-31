import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

/* ============================================================
 * VULN-05 — Native attestation signer bridge
 * - โหลด os_guard.node แบบ lazy (ตำแหน่งเดียวกับ native-bridge)
 * - Native เป็นคน hash app.asar และเซ็นด้วย seed ที่ฝังใน addon
 * - JS เรียกได้แค่ signAttestation(request) — ไม่มีทางข้ามการตรวจไฟล์
 * ============================================================ */

export interface NativeAttestationRequest {
  challengeId: string
  serverNonce: string
  manifestHash: string
  /** JS-computed digests (ใช้ในโหมด dev/test เท่านั้น — native จะคำนวณใหม่เอง) */
  sampleDigests: string[]
  /** ช่วงไบต์ที่ต้องให้ native อ่าน+hash เอง */
  sampleRanges: Array<{ relativePath: string; offset: number; length: number }>
  /** ไฟล์ที่ native ต้อง hash ทั้งไฟล์เองแล้วเทียบ sha256 */
  targets: Array<{ relativePath: string; sha256: string }>
}

interface NativeAttestationAddon {
  attestationSign(requestJson: string): string | null
  attestationPublicKey(): string
}

export interface NativeAttestationSigner {
  signAttestation(request: NativeAttestationRequest): string | null
  getPublicKey?(): string | null
}

let loadedAddon: NativeAttestationAddon | null | undefined
let testSigner: NativeAttestationSigner | null | undefined

/** ใช้ใน unit test เท่านั้น — null = บังคับให้ unavailable */
export function setNativeAttestationSignerForTests(signer: NativeAttestationSigner | null): void {
  testSigner = signer
}

export function resetNativeAttestationForTests(): void {
  testSigner = undefined
  loadedAddon = undefined
}

function loadAddon(): NativeAttestationAddon | null {
  const resolved = defaultAddonPath()
  if (!resolved) return null
  try {
    const requireNative = createRequire(__filename)
    const loaded = requireNative(resolved) as Partial<NativeAttestationAddon>
    if (typeof loaded?.attestationSign === 'function') {
      return loaded as NativeAttestationAddon
    }
  } catch {
    // โหลดไม่ได้/ABI ไม่ตรง — เรียกฝั่ง caller ตัดสินใจ fail-closed ตามโหมด
  }
  return null
}

function currentSigner(): NativeAttestationSigner | null {
  if (testSigner !== undefined) return testSigner
  if (loadedAddon === undefined) loadedAddon = loadAddon()
  const addon = loadedAddon
  if (!addon) return null
  return {
    signAttestation: (request) => {
      try {
        return addon.attestationSign(JSON.stringify(request))
      } catch {
        return null
      }
    },
    getPublicKey: () => {
      try {
        const key = addon.attestationPublicKey()
        return key.length > 0 ? key : null
      } catch {
        return null
      }
    }
  }
}

export function isNativeAttestationAvailable(): boolean {
  return currentSigner() !== null
}

export function signAttestation(request: NativeAttestationRequest): string | null {
  const signer = currentSigner()
  if (!signer) return null
  try {
    return signer.signAttestation(request)
  } catch {
    return null
  }
}

export function getPublicKey(): string | null {
  const signer = currentSigner()
  if (!signer) return null
  try {
    return signer.getPublicKey?.() ?? null
  } catch {
    return null
  }
}

/** แหล่งที่ .node อยู่: dev = native/build/Release, package = extraResources native/ */
function defaultAddonPath(): string | null {
  const moduleName = `os_guard_${process.platform}_${process.arch}.node`
  const plainName = 'os_guard.node'
  // อนุญาต env override เฉพาะ dev ที่ประกาศชัดเจน — production ต้องใช้ addon ที่ manifest ครอบเท่านั้น
  if (process.env.NODE_ENV === 'development') {
    const explicitEnvironment = process.env.ZTEXAM_NATIVE_ADDON
    if (explicitEnvironment && fs.existsSync(explicitEnvironment)) return explicitEnvironment
  }
  const candidates: string[] = []
  candidates.push(path.resolve(__dirname, '../../native/build/Release'))
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'native'))
  }
  for (const dir of candidates) {
    for (const name of [moduleName, plainName]) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

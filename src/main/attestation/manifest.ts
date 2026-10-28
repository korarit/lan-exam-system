import fs from 'node:fs'
import path from 'node:path'
import {
  AppManifestBodySchema,
  SignedAppManifestSchema,
  computeManifestHash,
  deriveManifestId,
  type AppManifestBody,
  type SignedAppManifest
} from '@shared/attestation-schema'
import { buildManifestBodyFromBuffers, hashFileStreaming } from './manifest-core'
import { ed25519Sign, ed25519Verify, sha256Hex } from '../crypto/primitives'

/* ============================================================
 * Phase 4 — Manifest ณ รันไทม์ (scope ของไฟล์ตัวเอง + โหลดลายเซ็นจาก build)
 * - Production: อ่าน `resources/app-manifest.sig.json` ที่ pipeline เซ็นให้
 * - Development: สร้าง manifest แบบ dev จากไฟล์ out/ จริง (ลายเซ็นได้ถ้ามี dev key)
 * ============================================================ */

export interface ManifestScope {
  root: string
  targets: Array<{ relativePath: string; absolutePath: string }>
}

/** ตำแหน่งไฟล์ลายเซ็น (build output ใช้ชื่อเดียวกันทุกแพลตฟอร์ม) */
export function signedManifestPath(scopeRoot: string): string {
  return path.join(scopeRoot, 'app-manifest.sig.json')
}

/** รู้ scope ไฟล์ตัวเอง: dev = โปรเจกต์ (out/), prod = resources ของแพ็กเกจ */
export function resolveManifestScope(isDev: boolean): ManifestScope {
  if (isDev) {
    const projectRoot = path.resolve(__dirname, '../..')
    const candidates = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
    return {
      root: projectRoot,
      targets: candidates
        .map((relativePath) => ({
          relativePath,
          absolutePath: path.join(projectRoot, ...relativePath.split('/'))
        }))
        .filter((t) => fs.existsSync(t.absolutePath))
    }
  }
  const resourcesRoot = process.resourcesPath
  const candidates = [
    'app.asar',
    'app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'native/os_guard.node'
  ]
  return {
    root: resourcesRoot,
    targets: candidates
      .map((relativePath) => ({
        relativePath,
        absolutePath: path.join(resourcesRoot, ...relativePath.split('/'))
      }))
      .filter((t) => fs.existsSync(t.absolutePath))
  }
}

/** อ่านไฟล์เป็น entry (บล็อก 64 KB แบบ streaming — ไม่กินแรมทั้งไฟล์ในหน่วยความจำ) */
export function describeFileEntry(absolutePath: string): {
  size: number
  sha256: string
  blockHashes64k: string[]
} {
  const descriptor = fs.openSync(absolutePath, 'r')
  try {
    return hashFileStreaming((length, position) => {
      const out = Buffer.alloc(length)
      let offset = 0
      while (offset < length) {
        const bytesRead = fs.readSync(descriptor, out, offset, length - offset, position + offset)
        if (bytesRead <= 0) break
        offset += bytesRead
      }
      if (offset === 0) return null
      return offset === length ? out : out.subarray(0, offset)
    })
  } finally {
    fs.closeSync(descriptor)
  }
}

export interface AttestationSnapshot {
  root: string
  /** manifest ที่จะแนบใน response แรก (null = ไม่มีไฟล์เป้าหมายเลย เช่น ยังไม่ build) */
  manifest: SignedAppManifest | null
  /** sha256 canonical ของ manifest ที่เครื่องนักเรียนถือ (ใช้ผูก HMAC) */
  manifestHash: string | null
  body: AppManifestBody | null
  /** relativePath → absolute path จริงบนดิสก์ (client ใช้อ่านไบต์ตอนถูกถาม) */
  paths: Record<string, string>
}

let cachedSnapshot: AttestationSnapshot | null = null

/**
 * จุดใช้งานหลักของเครื่องนักเรียน (cache ครั้งเดียวต่อการรันตัวแอป)
 * คืน null เมื่อหาไฟล์เป้าหมายไม่ได้เลย (เช่น ยังไม่ build)
 */
export function ensureLocalManifestSnapshot(isDev: boolean): AttestationSnapshot | null {
  if (cachedSnapshot) return cachedSnapshot
  try {
    const scope = resolveManifestScope(isDev)
    if (scope.targets.length === 0) return null
    const loaded = loadSignedManifestFromDisk(scope.root, isDev)
    if (loaded) {
      const paths: Record<string, string> = {}
      for (const relativePath of Object.keys(loaded.body.files)) {
        paths[relativePath] = path.join(scope.root, ...relativePath.split('/'))
      }
      cachedSnapshot = {
        root: scope.root,
        manifest: loaded.manifest,
        manifestHash: computeManifestHash(loaded.body),
        body: loaded.body,
        paths
      }
      return cachedSnapshot
    }
    // Dev: สร้าง manifest ของตัวเองจากไฟล์จริง (เครื่องแม่ dev อยู่ในโหมด permissive — DEV MODE banner)
    const buffers = new Map<string, Buffer>()
    for (const target of scope.targets) {
      buffers.set(target.relativePath, fs.readFileSync(target.absolutePath))
    }
    const body = buildManifestBodyFromBuffers(
      appVersionOf(),
      process.platform as AppManifestBody['platform'],
      process.arch === 'arm64' ? 'arm64' : 'x64',
      Date.now(),
      buffers
    )
    const paths: Record<string, string> = Object.fromEntries(
      Object.keys(body.files).map((relativePath) => [
        relativePath,
        path.join(scope.root, ...relativePath.split('/'))
      ])
    )
    cachedSnapshot = {
      root: scope.root,
      manifest: bodyAsUnsignedManifest(body),
      manifestHash: computeManifestHash(body),
      body,
      paths
    }
    return cachedSnapshot
  } catch {
    return null
  }
}

/** dev manifest ที่ยังไม่เซ็น — ลายเซ็นว่าง + keyId ทำเครื่องหมาย dev (host ต้องอยู่โหมด permissive เท่านั้น) */
function bodyAsUnsignedManifest(body: AppManifestBody): SignedAppManifest {
  return {
    ...body,
    keyId: 'dev-unsigned',
    signatureBase64: ''
  }
}

interface LoadedManifest {
  manifest: SignedAppManifest
  body: AppManifestBody
}

/** อ่าน manifest ที่อยู่บนดิสก์ + ตรวจเนื้อไฟล์จริงยังตรงกับ hash ที่ประกาศ (prod เคร่งครัด, dev ข้าม) */
function loadSignedManifestFromDisk(scopeRoot: string, isDev: boolean): LoadedManifest | null {
  const signatureFile = signedManifestPath(scopeRoot)
  if (!fs.existsSync(signatureFile)) return null
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(signatureFile, 'utf8'))
    const parsedSignature = SignedAppManifestSchema.safeParse(parsed)
    if (!parsedSignature.success) return null
    const manifest = parsedSignature.data
    const parsedBody = AppManifestBodySchema.safeParse({
      manifestId: manifest.manifestId,
      appVersion: manifest.appVersion,
      platform: manifest.platform,
      arch: manifest.arch,
      builtAt: manifest.builtAt,
      files: manifest.files
    })
    if (!parsedBody.success) return null
    const body = parsedBody.data
    // manifestId ต้องมาจาก canonical hash ของ body จริง (กันตัดแปะสมุดลายเซ็นอื่น)
    if (
      deriveManifestId({
        appVersion: body.appVersion,
        platform: body.platform,
        arch: body.arch,
        builtAt: body.builtAt,
        files: body.files
      }) !== manifest.manifestId.slice(0, 16)
    ) {
      return null
    }
    // เครื่องผู้รัน (prod): ตรวจไฟล์บนดิสก์ว่ายังเท่ากับ manifest ทีละไฟล์
    if (!isDev) {
      for (const [relativePath, entry] of Object.entries(body.files)) {
        const absolutePath = path.join(scopeRoot, ...relativePath.split('/'))
        if (!fs.existsSync(absolutePath)) return null
        if (describeFileEntry(absolutePath).sha256 !== entry.sha256) return null
      }
    }
    // ลายเซ็นที่ dev ชุด (เครื่องเดียวกัน): ตรวจกับ public key จาก env ถ้ามี
    const signatureOk = verifyWithLocalDevPublicKey(body, manifest.keyId, manifest.signatureBase64)
    if (!signatureOk && !isDev) return null
    return { manifest, body }
  } catch {
    return null
  }
}

/** dev signing key (env: ZTEXAM_DEV_SIGNING_PUBLIC_KEY) — ใช้ซ้อม E2E attestation ตอนพัฒนา */
function verifyWithLocalDevPublicKey(body: AppManifestBody, keyId: string, signatureBase64: string): boolean {
  const pemFile = process.env.ZTEXAM_DEV_SIGNING_PUBLIC_KEY
  if (!pemFile || !fs.existsSync(pemFile)) return false
  try {
    const pem = fs.readFileSync(pemFile, 'utf8').trim()
    if (deriveKeyIdFromLocalPem(pem) !== keyId) return false
    return ed25519Verify(computeManifestHash(body), Buffer.from(signatureBase64, 'base64'), pem)
  } catch {
    return false
  }
}

/** keyId จาก PEM ในเครื่อง (ตรงกับ scripts/keygen.ts — sha256 ของ pem ตัด 12 ตัวแรก) */
function deriveKeyIdFromLocalPem(publicKeyPem: string): string {
  return sha256Hex(publicKeyPem).slice(0, 12)
}

function appVersionOf(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../../../package.json') as { version?: string }
  return pkg.version ?? '0-dev'
}

/* ============================================================
 * การตอบ challenge (ใช้โดย client-responder)
 * ============================================================ */

/** อ่านแค่ช่วงไบต์ที่ถูกถาม → sha256 hex (ต้องได้เท่ากับ blockHash ที่เซ็นไว้) */
export function readRangeDigest(
  snapshot: AttestationSnapshot,
  range: { relativePath: string; offset: number; length: number }
): string | null {
  const absolutePath = snapshot.paths[range.relativePath]
  if (!absolutePath || !fs.existsSync(absolutePath)) return null
  const descriptor = fs.openSync(absolutePath, 'r')
  try {
    const buf = Buffer.alloc(range.length)
    let readTotal = 0
    while (readTotal < range.length) {
      const bytesRead = fs.readSync(descriptor, buf, readTotal, range.length - readTotal, range.offset + readTotal)
      if (bytesRead <= 0) break
      readTotal += bytesRead
    }
    if (readTotal === 0) return null
    return sha256Hex(buf.subarray(0, readTotal))
  } catch {
    return null
  } finally {
    fs.closeSync(descriptor)
  }
}

/** เซ็น dev key ถ้ามี (env: ZTEXAM_DEV_SIGNING_PRIVATE_KEY) — ทางเลือกเพิ่มเติมของโหมด dev */
export function signWithDevKeyIfAvailable(body: AppManifestBody): { signatureBase64: string; keyId: string } | null {
  const pemFile = process.env.ZTEXAM_DEV_SIGNING_PRIVATE_KEY
  if (!pemFile || !fs.existsSync(pemFile)) return null
  try {
    const pem = fs.readFileSync(pemFile, 'utf8').trim()
    const signature = ed25519Sign(computeManifestHash(body), pem)
    return { signatureBase64: signature.toString('base64'), keyId: deriveKeyIdFromLocalPem(pem) }
  } catch {
    return null
  }
}

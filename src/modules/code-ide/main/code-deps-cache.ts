import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import {
  STUDENT_BUNDLE_BLOB_BUDGET_BYTES,
  STUDENT_BUNDLE_BLOB_FILE_CAP_BYTES,
  type DependencyBundle,
  type StudentBundleBlob
} from '../shared/code-schema'
import { assertPathInside } from './anti-delete-guard'

/* ============================================================
 * Phase 10 (ค้าง) — Offline Dependency Cache (เครื่องแม่)
 * แตกไฟล์ libraries ที่ครูฝังมากับ .ztcode (blobs) ลง cache ครั้งเดียว
 * แล้วลิงก์เข้า Isolated Run Directory ทุกครั้งที่รัน/ตรวจ:
 * - node: junction node_modules (+ NODE_PATH fallback)
 * - python: PYTHONPATH ชี้ site-packages/wheels ที่แตกแล้ว
 * - java: .jar ต่อท้าย -cp ตอน javac/java
 * รองรับ: .zip / .whl (zip format) / .jar / ไฟล์เดี่ยว (.d.ts/.sql/.sqlite)
 * ยังไม่รองรับ: .tar.zst / .tgz (แจ้งครูให้อัปโหลดเป็น .zip แทน)
 * ============================================================ */

export interface DepsCacheLayout {
  root: string
  nodeModulesDir?: string | undefined
  sitePackagesDirs: string[]
  jarFiles: string[]
  /** archive ที่ข้ามไป (format ไม่รองรับ / blob หาย) — โชว์ใน UI ให้ครูแก้ */
  unsupported: string[]
}

const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
const MAX_EXTRACTED_FILES = 5000

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sanitizeKey(key: string): string {
  return key.replace(/\\/g, '/').replace(/\.\./g, '_').replace(/^\/+/, '').slice(0, 200)
}

/**
 * แตก cache ของ package หนึ่งชุด (idempotent — มี marker ตรง sha แล้วข้าม)
 * cacheRoot ปกติ = os.tmpdir()/ztcode-deps-cache (เรียกครั้งเดียวตอน attach)
 */
export function materializeDependencyCache(
  pkg: {
    packageId: string
    dependencies: DependencyBundle[]
    blobs: Record<string, { dataBase64: string }>
  },
  cacheRoot: string = path.join(os.tmpdir(), 'ztcode-deps-cache')
): DepsCacheLayout {
  const root = path.join(cacheRoot, pkg.packageId)
  const layout: DepsCacheLayout = { root, sitePackagesDirs: [], jarFiles: [], unsupported: [] }
  const marker = path.join(root, '.cache-sha')
  const fingerprint = sha256Hex(
    JSON.stringify({
      deps: pkg.dependencies,
      blobKeys: Object.keys(pkg.blobs).sort(),
      blobSizes: Object.keys(pkg.blobs).sort().map((k) => pkg.blobs[k]?.dataBase64.length ?? 0)
    })
  )
  try {
    if (fs.readFileSync(marker, 'utf8') === fingerprint) {
      return readBackLayout(root, pkg)
    }
  } catch {
    /* ยังไม่เคยแตก — ทำใหม่ */
  }
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })

  for (const bundle of pkg.dependencies) {
    const blob = pkg.blobs[bundle.archiveRelativePath]
    if (!blob) {
      layout.unsupported.push(`${bundle.bundleId}: ไม่มี blob ${bundle.archiveRelativePath} ใน .ztcode`)
      continue
    }
    let bytes: Buffer
    try {
      bytes = Buffer.from(blob.dataBase64, 'base64')
    } catch {
      layout.unsupported.push(`${bundle.bundleId}: blob เสียหาย (decode ไม่ได้)`)
      continue
    }
    const lower = bundle.archiveRelativePath.toLowerCase()
    const destDir = path.join(root, sanitizeKey(bundle.bundleId))
    fs.mkdirSync(destDir, { recursive: true })
    if (lower.endsWith('.jar')) {
      const out = path.join(destDir, path.basename(bundle.archiveRelativePath))
      fs.writeFileSync(out, bytes)
      layout.jarFiles.push(out)
    } else if (lower.endsWith('.zip') || lower.endsWith('.whl')) {
      try {
        const extracted = extractZip(bytes, destDir)
        classifyExtracted(destDir, extracted, layout)
      } catch (err) {
        layout.unsupported.push(
          `${bundle.bundleId}: แตก .zip ไม่สำเร็จ (${err instanceof Error ? err.message.slice(0, 120) : 'unknown'})`
        )
      }
    } else if (lower.endsWith('.tar.zst') || lower.endsWith('.tgz') || lower.endsWith('.tar.gz')) {
      layout.unsupported.push(
        `${bundle.bundleId}: ยังไม่รองรับ ${path.extname(bundle.archiveRelativePath)} — อัปโหลดเป็น .zip แทน`
      )
    } else {
      // ไฟล์เดี่ยว (.d.ts / .sql / .sqlite / อื่น ๆ) — วางไว้ให้อ้าง path ได้
      const out = path.join(destDir, path.basename(bundle.archiveRelativePath))
      fs.writeFileSync(out, bytes)
      if (out.toLowerCase().endsWith('.jar')) layout.jarFiles.push(out)
    }
  }
  try {
    fs.writeFileSync(marker, fingerprint, 'utf8')
  } catch {
    /* marker เขียนไม่ได้ — รอบหน้าจะแตกใหม่ */
  }
  return layout
}

/** อ่าน layout กลับจาก cache เดิม (ไม่แตกใหม่) */
function readBackLayout(
  root: string,
  pkg: { dependencies: DependencyBundle[] }
): DepsCacheLayout {
  const layout: DepsCacheLayout = { root, sitePackagesDirs: [], jarFiles: [], unsupported: [] }
  for (const bundle of pkg.dependencies) {
    const destDir = path.join(root, sanitizeKey(bundle.bundleId))
    if (!fs.existsSync(destDir)) continue
    const extracted = listFilesRecursive(destDir).map((f) => path.relative(destDir, f).split(path.sep).join('/'))
    classifyExtracted(destDir, extracted, layout)
  }
  return layout
}

function classifyExtracted(destDir: string, extracted: string[], layout: DepsCacheLayout): void {
  for (const rel of extracted) {
    const abs = path.join(destDir, rel)
    if (rel.toLowerCase().endsWith('.jar')) layout.jarFiles.push(abs)
  }
  // node_modules สำเร็จรูป (ครู zip ทั้งโฟลเดอร์มา)
  const nodeModules = extracted.some((r) => r === 'node_modules' || r.startsWith('node_modules/'))
  if (nodeModules) {
    const dir = path.join(destDir, 'node_modules')
    if (layout.nodeModulesDir === undefined && fs.existsSync(dir)) layout.nodeModulesDir = dir
  }
  // python: มี .dist-info / top-level .py / site-packages → ชี้ PYTHONPATH ที่ destDir
  const looksPython =
    extracted.some((r) => r.endsWith('.dist-info/METADATA')) ||
    extracted.some((r) => /^[a-zA-Z0-9_]+\.py$/.test(r.split('/').pop() ?? '')) ||
    extracted.some((r) => r.startsWith('site-packages/'))
  if (looksPython && !layout.sitePackagesDirs.includes(destDir)) {
    const sp = path.join(destDir, 'site-packages')
    layout.sitePackagesDirs.push(fs.existsSync(sp) ? sp : destDir)
  }
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  let children: fs.Dirent[]
  try {
    children = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const child of children) {
    const abs = path.join(dir, child.name)
    if (child.isDirectory()) out.push(...listFilesRecursive(abs))
    else if (child.isFile()) out.push(abs)
  }
  return out
}

/* ---------- mini unzip (store + deflate, ไม่เข้ารหัส, ไม่ zip64) ---------- */

interface ZipEntry {
  name: string
  method: number
  compSize: number
  uncompSize: number
  localOffset: number
}

function extractZip(bytes: Buffer, destDir: string): string[] {
  const entries = readCentralDirectory(bytes)
  let totalUncompressed = 0
  const extracted: string[] = []
  for (const e of entries) {
    if (e.name.endsWith('/')) continue
    if (extracted.length >= MAX_EXTRACTED_FILES) throw new Error('ZIP_TOO_MANY_FILES')
    totalUncompressed += e.uncompSize
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error('ZIP_BOMB_GUARD')
    assertPathInside(destDir, e.name)
    const data = extractEntry(bytes, e)
    const abs = path.join(destDir, e.name)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, data)
    extracted.push(e.name)
  }
  return extracted
}

function readCentralDirectory(bytes: Buffer): ZipEntry[] {
  // หา EOCD จากท้ายไฟล์ (ไม่รองรับ zip64 / multi-disk / comment ยาวเกิน 64KB)
  let eocd = -1
  const start = Math.max(0, bytes.length - (22 + 65535))
  for (let i = bytes.length - 22; i >= start; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP_NO_EOCD')
  const count = bytes.readUInt16LE(eocd + 10)
  const cdOffset = bytes.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP_BAD_CENTRAL_DIR')
    const flags = bytes.readUInt16LE(p + 8)
    const method = bytes.readUInt16LE(p + 10)
    if ((flags & 0x1) !== 0) throw new Error('ZIP_ENCRYPTED_UNSUPPORTED')
    if ((flags & 0x8) !== 0) throw new Error('ZIP_DATA_DESCRIPTOR_UNSUPPORTED')
    const compSize = bytes.readUInt32LE(p + 20)
    const uncompSize = bytes.readUInt32LE(p + 24)
    const nameLen = bytes.readUInt16LE(p + 28)
    const extraLen = bytes.readUInt16LE(p + 30)
    const commentLen = bytes.readUInt16LE(p + 32)
    const localOffset = bytes.readUInt32LE(p + 42)
    const name = bytes.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (method !== 0 && method !== 8) throw new Error(`ZIP_METHOD_UNSUPPORTED:${method}`)
    entries.push({ name, method, compSize, uncompSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function extractEntry(bytes: Buffer, e: ZipEntry): Buffer {
  const p = e.localOffset
  if (bytes.readUInt32LE(p) !== 0x04034b50) throw new Error('ZIP_BAD_LOCAL_HEADER')
  const nameLen = bytes.readUInt16LE(p + 26)
  const extraLen = bytes.readUInt16LE(p + 28)
  const dataStart = p + 30 + nameLen + extraLen
  const data = bytes.subarray(dataStart, dataStart + e.compSize)
  if (e.method === 0) return Buffer.from(data)
  return inflateRawSync(data)
}

/* ============================================================
 * F-3 — คัด blobs ไฟล์เล็กแนบไปกับ stripped student view
 * (stateJson ผ่าน MODULE_STATE_PUSH จำกัด ~8MB → งบรวม 5MB, รายไฟล์ 3MB)
 * คืนรายการพร้อม sha256 ให้เครื่องนักเรียนตรวจก่อนแตก cache
 * ============================================================ */

export function pickStudentBlobs(
  blobs: Record<string, { dataBase64: string }>,
  opts: { budgetBytes?: number | undefined; fileCapBytes?: number | undefined } = {}
): StudentBundleBlob[] {
  const budget = opts.budgetBytes ?? STUDENT_BUNDLE_BLOB_BUDGET_BYTES
  const cap = opts.fileCapBytes ?? STUDENT_BUNDLE_BLOB_FILE_CAP_BYTES
  const picked: StudentBundleBlob[] = []
  let total = 0
  for (const archivePath of Object.keys(blobs).sort()) {
    const blob = blobs[archivePath]
    if (!blob) continue
    let bytes: Buffer
    try {
      bytes = Buffer.from(blob.dataBase64, 'base64')
    } catch {
      continue
    }
    if (bytes.length === 0 || bytes.length > cap) continue
    if (total + bytes.length > budget) continue
    total += bytes.length
    picked.push({
      archivePath,
      dataBase64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  }
  return picked
}

/* ============================================================
 * F-3 (ฝั่งเครื่องนักเรียน) — แคช blobs ที่มากับ stripped view
 * แยกโฟลเดอร์จาก cache ฝั่งครู (กันปนกับ grading cache ของเครื่องแม่)
 * ============================================================ */

export function studentDepsCacheRoot(): string {
  return path.join(os.tmpdir(), 'ztcode-student-deps-cache')
}

const studentLayouts = new Map<string, DepsCacheLayout>()

/** แคช blobs ของโจทย์ข้อนี้ (ตรวจ sha256 ทุกไฟล์ก่อนแตก) */
export function ensureStudentBundleCache(input: {
  packageId: string
  dependencies: DependencyBundle[]
  blobs: StudentBundleBlob[]
}): { layout: DepsCacheLayout; verified: number } {
  const blobs: Record<string, { dataBase64: string }> = {}
  for (const b of input.blobs) {
    let bytes: Buffer
    try {
      bytes = Buffer.from(b.dataBase64, 'base64')
    } catch {
      throw new Error(`BLOB_DECODE_FAILED:${b.archivePath}`)
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== b.sha256.toLowerCase()) {
      throw new Error(`BLOB_HASH_MISMATCH:${b.archivePath}`)
    }
    blobs[b.archivePath] = { dataBase64: b.dataBase64 }
  }
  const layout = materializeDependencyCache(
    { packageId: input.packageId, dependencies: input.dependencies, blobs },
    studentDepsCacheRoot()
  )
  studentLayouts.set(input.packageId, layout)
  return { layout, verified: input.blobs.length }
}

/** layout ที่แคชไว้ของโจทย์ข้อนี้ (undefined = ยังไม่แคช → รันด้วย runtime ตัวเองล้วน) */
export function getStudentDepsLayout(packageId: string): DepsCacheLayout | undefined {
  return studentLayouts.get(packageId)
}

/** ลงทะเบียน layout ที่ติดตั้งจากช่องทางอื่น (เช่น pip/npm install ฝั่งนักเรียน) */
export function registerStudentDepsLayout(packageId: string, layout: DepsCacheLayout): void {
  studentLayouts.set(packageId, layout)
}

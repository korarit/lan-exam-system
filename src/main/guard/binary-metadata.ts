import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseJsonLines, psQuote, runCommand, runPowerShell } from './system-probes'

/* ============================================================
 * Binary Metadata Reader — หัวใจของ Renamed Binary Detection
 * - Windows: อ่าน PE Version Information Resource (OriginalFilename ฯลฯ)
 * - macOS: อ่าน Contents/Info.plist (CFBundleIdentifier ฯลฯ)
 * - Linux: อ่าน /proc ข้อมูลจาก symlink/comm ของโปรเซส
 * แคชตาม filePath + mtimeMs + fileSize เพื่อไม่อ่านดิสก์ซ้ำ
 * ============================================================ */

export interface BinaryMetadata {
  filePath: string
  originalFilename?: string
  internalName?: string
  productName?: string
  fileDescription?: string
  companyName?: string
  bundleId?: string
  sha256?: string
}

export interface CacheKeyInfo {
  mtimeMs: number
  fileSize: number
}

export type MetadataReader = (filePath: string) => Promise<BinaryMetadata | null>

export class BinaryMetadataCache {
  private readonly cache = new Map<string, BinaryMetadata | null>()
  /** ล้างรายการที่ไฟล์หายไปแล้ว กันหน่วยความจำโตตอบสอบยาว */
  private readonly maxEntries: number

  constructor(
    private readonly reader: MetadataReader,
    maxEntries = 1_024
  ) {
    this.maxEntries = maxEntries
  }

  async get(filePath: string, keyInfo: CacheKeyInfo | null): Promise<BinaryMetadata | null> {
    const cacheKey = keyInfo
      ? `${filePath.toLowerCase()}|${keyInfo.mtimeMs}|${keyInfo.fileSize}`
      : filePath.toLowerCase()
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) ?? null
    }
    const metadata = await this.reader(filePath)
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(cacheKey, metadata)
    return metadata
  }

  /** ใส่ค่าที่อ่านที่อื่นแล้วลง cache ตรง ๆ (batch reader ใช้) */
  prime(filePath: string, metadata: BinaryMetadata | null): void {
    this.cache.set(filePath.toLowerCase(), metadata)
  }

  hasCached(filePath: string): boolean {
    return this.cache.has(filePath.toLowerCase())
  }

  clear(): void {
    this.cache.clear()
  }
}

interface PsVersionInfoLine {
  path: string
  original?: string
  internal?: string
  product?: string
  desc?: string
  company?: string
}

/** อ่าน VersionInfo ของหลายไฟล์ในครั้งเดียว (ลด cost การ spawn PowerShell) */
export function readPeVersionInfoBatch(filePaths: string[]): Promise<Map<string, BinaryMetadata>> {
  const result = new Map<string, BinaryMetadata>()
  if (filePaths.length === 0) return Promise.resolve(result)
  const pathList = filePaths.map((p) => `'${psQuote(p)}'`).join(',')
  const script = [
    `Get-Item -LiteralPath @(${pathList}) -ErrorAction SilentlyContinue | ForEach-Object {`,
    '$v = $_.VersionInfo;',
    `@{ path = $_.FullName; original = $v.OriginalFilename; internal = $v.InternalName; product = $v.ProductName; desc = $v.FileDescription; company = $v.CompanyName } | ConvertTo-Json -Compress`,
    '}'
  ].join(' ')
  return runPowerShell(script).then((output) => {
    for (const line of parseJsonLines<PsVersionInfoLine>(output)) {
      if (!line.path) continue
      const entry: BinaryMetadata = { filePath: line.path }
      if (line.original) entry.originalFilename = line.original
      if (line.internal) entry.internalName = line.internal
      if (line.product) entry.productName = line.product
      if (line.desc) entry.fileDescription = line.desc
      if (line.company) entry.companyName = line.company
      result.set(line.path.toLowerCase(), entry)
    }
    return result
  })
}

/** reader ต่อ platform — ใช้เป็น default ของ BinaryMetadataCache */
export function createPlatformMetadataReader(): MetadataReader {
  if (process.platform === 'win32') {
    return async (filePath) => {
      const batch = await readPeVersionInfoBatch([filePath])
      return batch.get(filePath.toLowerCase()) ?? null
    }
  }
  if (process.platform === 'darwin') {
    return async (filePath) => {
      // โครง .app: <bundle>/Contents/MacOS/<exe> → อ่าน Info.plist ถอยหลัง 2 ระดับ
      const bundleDir = path.dirname(path.dirname(filePath))
      const plistPath = path.join(bundleDir, 'Contents', 'Info.plist')
      if (!fs.existsSync(plistPath)) return null
      const output = await runCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath])
      if (!output) return null
      try {
        const parsed = JSON.parse(output) as { CFBundleIdentifier?: string; CFBundleName?: string }
        const metadata: BinaryMetadata = { filePath }
        if (parsed.CFBundleIdentifier) metadata.bundleId = parsed.CFBundleIdentifier
        if (parsed.CFBundleName) metadata.productName = parsed.CFBundleName
        return metadata
      } catch {
        return null
      }
    }
  }
  // linux: ไม่มี metadata กลาง อ่านชื่อ comm เสริมให้ matcher ใช้
  return async (filePath) => ({ filePath })
}

/** คำนวณ SHA-256 ของไฟล์ (แบบ stream — ไม่โหลดไฟล์ใหญ่เข้า RAM) */
export function hashFileSha256(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const stream = fs.createReadStream(filePath)
      const hash = createHash('sha256')
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', () => resolve(null))
    } catch {
      resolve(null)
    }
  })
}

/** ข้อมูล stat สำหรับ cache key (null เมื่อไฟล์หาย) */
export function statFile(filePath: string): CacheKeyInfo | null {
  try {
    const stat = fs.statSync(filePath)
    return { mtimeMs: stat.mtimeMs, fileSize: stat.size }
  } catch {
    return null
  }
}

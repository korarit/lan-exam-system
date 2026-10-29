import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { materializeDependencyCache } from './code-deps-cache'
import type { CodeExamPackage, DependencyBundle } from '../shared/code-schema'

/* Phase 10 (ค้าง) — Offline Dependency Cache: แตก .zip/.whl/.jar จาก blobs */

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztcode-deps-test-'))
  tempDirs.push(dir)
  return dir
}

/** สร้าง .zip แบบ stored (ไม่บีบอัด) ด้วยมือ — ไม่ต้องพึ่ง lib ภายนอก */
function buildStoredZip(files: Array<{ name: string; data: string }>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const dataBuf = Buffer.from(f.data, 'utf8')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0, 8)
    lh.writeUInt16LE(0, 10)
    lh.writeUInt32LE(0, 14) // crc (reader ไม่ตรวจ)
    lh.writeUInt32LE(dataBuf.length, 18)
    lh.writeUInt32LE(dataBuf.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    chunks.push(lh, nameBuf, dataBuf)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt32LE(dataBuf.length, 20)
    cd.writeUInt32LE(dataBuf.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += 30 + nameBuf.length + dataBuf.length
  }
  const cdStart = offset
  const cdBuf = Buffer.concat(central)
  chunks.push(cdBuf)
  offset += cdBuf.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(cdStart, 16)
  eocd.writeUInt16LE(0, 20)
  chunks.push(eocd)
  void offset
  return Buffer.concat(chunks)
}

function depPkg(
  packageId: string,
  dependencies: DependencyBundle[],
  blobs: Record<string, { encoding: 'base64'; dataBase64: string }>
): CodeExamPackage {
  return {
    moduleId: 'code-ide',
    packageId,
    title: 't',
    instructions: '',
    category: 'backend',
    language: 'node-backend',
    entries: [{ path: 'server.js', kind: 'file', content: '', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }],
    referenceSolution: [],
    policy: { entryPointPath: 'server.js', allowCreateFiles: true, allowCreateFolders: true, allowDeleteRename: true, allowStudentFileUpload: false, maxProjectSizeBytes: 1024 * 1024 },
    dependencies,
    database: {
      enabled: false, engine: 'sqlite', sqlMode: 'query',
      allowDestructiveQueries: true, respawnFreshDbOnEveryRun: true, exposeDbViewerToStudent: true,
      host: 'localhost', port: 3303, dbUser: 'root', dbPassword: '', databaseName: ''
    },
    testCases: [],
    blobs
  }
}

function bundle(bundleId: string, ecosystem: DependencyBundle['ecosystem'], archiveRelativePath: string): DependencyBundle {
  return { bundleId, ecosystem, packages: [{ name: 'x', version: '1.0.0' }], archiveRelativePath }
}

describe('Phase 10 — code-deps-cache', () => {
  it('แตก node_modules.zip → เจอ junction target + ไม่มีไฟล์หลุด', () => {
    const zip = buildStoredZip([
      { name: 'node_modules/left-pad/package.json', data: '{"name":"left-pad"}' },
      { name: 'node_modules/left-pad/index.js', data: 'module.exports = 1;' }
    ])
    const pkg = depPkg('623e4567-e89b-12d3-a456-426614174005',
      [bundle('b1', 'npm', 'vendor/npm/libs.zip')],
      { 'vendor/npm/libs.zip': { encoding: 'base64', dataBase64: zip.toString('base64') } })
    const layout = materializeDependencyCache(pkg, tempRoot())
    expect(layout.nodeModulesDir).toBeDefined()
    expect(fs.existsSync(path.join(layout.nodeModulesDir!, 'left-pad', 'index.js'))).toBe(true)
    expect(layout.unsupported).toHaveLength(0)
    // idempotent — เรียกซ้ำได้ layout เดิมโดยไม่แตกใหม่
    const again = materializeDependencyCache(pkg, path.dirname(layout.root))
    expect(again.nodeModulesDir).toBe(layout.nodeModulesDir)
  })

  it('แตก wheel (.whl = zip) → ชี้ PYTHONPATH ได้', () => {
    const whl = buildStoredZip([
      { name: 'mylib/__init__.py', data: 'X = 1' },
      { name: 'mylib-1.0.dist-info/METADATA', data: 'Name: mylib' }
    ])
    const pkg = depPkg('723e4567-e89b-12d3-a456-426614174006',
      [bundle('b2', 'pip', 'vendor/pip/mylib-1.0-py3-none-any.whl')],
      { 'vendor/pip/mylib-1.0-py3-none-any.whl': { encoding: 'base64', dataBase64: whl.toString('base64') } })
    const layout = materializeDependencyCache(pkg, tempRoot())
    expect(layout.sitePackagesDirs.length).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(path.join(layout.sitePackagesDirs[0]!, 'mylib', '__init__.py'))).toBe(true)
  })

  it('.jar ตรง ๆ เข้า classpath + .tar.zst ถูกปฏิเสธอย่างสุภาพ', () => {
    const pkg = depPkg('823e4567-e89b-12d3-a456-426614174007',
      [
        bundle('b3', 'maven-jar', 'vendor/maven-jar/gson.jar'),
        bundle('b4', 'npm', 'vendor/npm/huge.tar.zst')
      ],
      { 'vendor/maven-jar/gson.jar': { encoding: 'base64', dataBase64: Buffer.from('fake-jar').toString('base64') } })
    const layout = materializeDependencyCache(pkg, tempRoot())
    expect(layout.jarFiles).toHaveLength(1)
    expect(layout.jarFiles[0]!.endsWith('gson.jar')).toBe(true)
    expect(layout.unsupported.some((u) => u.includes('huge.tar.zst') || u.includes('.tar.zst'))).toBe(true)
  })

  it('zip traversal (../) ถูกบล็อก — ไม่มีไฟล์หลุดออกนอก cache', () => {
    const evil = buildStoredZip([{ name: '../evil.txt', data: 'pwned' }])
    const root = tempRoot()
    const pkg = depPkg('923e4567-e89b-12d3-a456-426614174008',
      [bundle('b5', 'npm', 'vendor/npm/evil.zip')],
      { 'vendor/npm/evil.zip': { encoding: 'base64', dataBase64: evil.toString('base64') } })
    const layout = materializeDependencyCache(pkg, root)
    expect(layout.unsupported.length).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(path.join(root, 'evil.txt'))).toBe(false)
    expect(fs.existsSync(path.join(path.dirname(root), 'evil.txt'))).toBe(false)
  })
})

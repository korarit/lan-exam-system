// scripts/sign-manifest.ts — สร้าง + เซ็น app-manifest.sig.json (Phase 4.1)
// การใช้งาน:
//   node scripts/sign-manifest.ts --root dist/win-unpacked/resources [--verify]
//   node scripts/sign-manifest.ts --root <หนึ่งโฟลเดอร์ resources> --platform win32 --arch x64
//
// - สแกนไฟล์สำคัญของ build output (app.asar, native .node, .node ของ better-sqlite3)
// - คำนวณ sha256 ทั้งไฟล์ + blockHashes64k (64KB ต่อบล็อก) เพื่อให้สู่การสุ่มถามระดับไบต์ตอน runtime
// - เซ็น canonical hash ของ body ด้วย Ed25519 private key
// - ผลลัพธ์: <root>/app-manifest.sig.json (ตาม arc: resources/app-manifest.sig.json)
import { createHash, createPublicKey, sign as ed25519Sign, verify as ed25519Verify, type KeyObject } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ATTESTATION_BLOCK_SIZE = 64 * 1024
const MANIFEST_FORMAT = 'zt-manifest-v1'

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let i = 2; i < argv.length; i++) {
    const item = argv[i]
    if (!item.startsWith('--')) continue
    const name = item.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args[name] = next
      i++
    } else {
      args[name] = true
    }
  }
  return args
}

/** แฮไขไฟล์แบบ streaming — app.asar อาจเป็นร้อย MB จึงไม่โหลดทั้งไฟล์ครั้งเดียว */
function hashFile(absolutePath: string): { size: number; sha256: string; blockHashes64k: string[] } {
  const descriptor = fs.openSync(absolutePath, 'r')
  try {
    const fileHash = createHash('sha256')
    let carry = Buffer.alloc(0)
    const blocks: string[] = []
    let size = 0
    let position = 0
    for (;;) {
      const buf = Buffer.alloc(ATTESTATION_BLOCK_SIZE)
      let offset = 0
      while (offset < ATTESTATION_BLOCK_SIZE) {
        const bytesRead = fs.readSync(descriptor, buf, offset, ATTESTATION_BLOCK_SIZE - offset, position + offset)
        if (bytesRead <= 0) break
        offset += bytesRead
      }
      if (offset === 0) break
      position += offset
      const chunk = offset === ATTESTATION_BLOCK_SIZE ? buf : buf.subarray(0, offset)
      fileHash.update(chunk)
      size += offset
      const merged = Buffer.concat([carry, chunk])
      const fullBlocks = Math.floor(merged.length / ATTESTATION_BLOCK_SIZE)
      for (let i = 0; i < fullBlocks; i++) {
        blocks.push(
          createHash('sha256')
            .update(merged.subarray(i * ATTESTATION_BLOCK_SIZE, (i + 1) * ATTESTATION_BLOCK_SIZE))
            .digest('hex')
        )
      }
      carry = merged.subarray(fullBlocks * ATTESTATION_BLOCK_SIZE)
    }
    if (carry.length > 0) blocks.push(createHash('sha256').update(carry).digest('hex'))
    if (blocks.length === 0) blocks.push(createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
    return { size, sha256: fileHash.digest('hex'), blockHashes64k: blocks }
  } finally {
    fs.closeSync(descriptor)
  }
}

/** Canonical JSON ต้องมีลำดับ=ระดับบน+files เรียงตาม path — ตรงกับ canonicalizeManifestBody ใน src/shared/attestation-schema.ts */
function canonical(body: Record<string, unknown>): string {
  const files = body.files as Record<string, unknown>
  return JSON.stringify({
    manifestId: body.manifestId,
    appVersion: body.appVersion,
    platform: body.platform,
    arch: body.arch,
    builtAt: body.builtAt,
    files: Object.fromEntries(Object.keys(files).sort().map((key) => [key, files[key]]))
  })
}

function deriveManifestId(probe: Record<string, unknown>): string {
  return createHash('sha256').update(canonical({ ...probe, manifestId: 'PENDING' }), 'utf8').digest('hex').slice(0, 16)
}

function keyIdOf(publicKeyObject: KeyObject): string {
  const pem = publicKeyObject.export({ type: 'spki', format: 'pem' }).toString().trim()
  return createHash('sha256').update(pem, 'utf8').digest('hex').slice(0, 12)
}

function collectTargets(root: string): Array<{ relativePath: string; absolutePath: string }> {
  const candidates = [
    'app.asar',
    'app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'native/os_guard.node'
  ]
  return candidates
    .map((relativePath) => ({ relativePath, absolutePath: path.join(root, ...relativePath.split('/')) }))
    .filter((target) => fs.existsSync(target.absolutePath))
}

function guessPlatform(root: string): string {
  const lower = root.toLowerCase()
  if (lower.includes('win-unpacked')) return 'win32'
  if (lower.includes('mac')) return 'darwin'
  if (lower.includes('linux')) return 'linux'
  return process.platform
}

function readAppVersion(): string {
  const projectRoot = path.resolve(import.meta.dirname, '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version?: string }
  return pkg.version ?? '0-dev'
}

function resolvePrivateKeyPath(explicit: string | undefined, projectRoot: string): string {
  return explicit ?? process.env.ZTEXAM_SIGNING_KEY ?? path.join(projectRoot, 'artifacts', 'zt-exam-signing-key.pem')
}

function verifyWithPem(probe: string, _manifestId: string, signatureBase64: string, publicKey: KeyObject): boolean {
  void _manifestId
  const digest = createHash('sha256').update(probe, 'utf8').digest()
  // node:crypto verify(algorithm, data, key, signature)
  return ed25519Verify(null, digest, publicKey, Buffer.from(signatureBase64, 'base64'))
}

function main(): number {
  const args = parseArgs(process.argv)
  const projectRoot = path.resolve(import.meta.dirname, '..')
  const root = typeof args.root === 'string' ? path.resolve(args.root) : null
  if (!root || !fs.existsSync(root)) {
    console.error('การใช้งาน: node scripts/sign-manifest.ts --root <โฟลเดอร์ resources ของแพ็กเกจ> [--key <pem>] [--verify]')
    return 1
  }

  // --verify = ตรวจไฟล์ลายเซ็นที่มีอยู่ "โดยไม่เซ็นใหม่" (กันหลุมพราง self-verifying)
  if (args.verify === true) {
    return verifyExisting(root, projectRoot)
  }
  return signAndWrite(root, projectRoot, args)
}

function signAndWrite(root: string, projectRoot: string, args: Record<string, string | boolean>): number {
  const keyPath = resolvePrivateKeyPath(typeof args.key === 'string' ? args.key : undefined, projectRoot)
  if (!fs.existsSync(keyPath)) {
    console.error(`ไม่พบ private key ที่ ${keyPath} — รัน npm run keys:generate ก่อน (หรือกำหนด --key)`)
    return 1
  }
  const privateKeyPem = fs.readFileSync(keyPath, 'utf8')
  const publicKey = createPublicKey(privateKeyPem)

  const targets = collectTargets(root)
  if (targets.length === 0) {
    console.error(`ไม่พบไฟล์เป้าหมายใน ${root} (app.asar / .node)`)
    return 1
  }

  const files: Record<string, { size: number; sha256: string; blockHashes64k: string[] }> = {}
  for (const target of targets) {
    files[target.relativePath] = hashFile(target.absolutePath)
    console.log(`scan: ${target.relativePath} (${files[target.relativePath].size} bytes)`)
  }

  const probe = {
    appVersion: readAppVersion(),
    platform: typeof args.platform === 'string' ? args.platform : guessPlatform(root),
    arch: typeof args.arch === 'string' ? args.arch : 'x64',
    builtAt: Date.now(),
    files
  }
  const manifestId = deriveManifestId(probe)
  const fullBody = { ...probe, manifestId }
  const manifestHash = createHash('sha256').update(canonical(fullBody), 'utf8').digest('hex')
  const signature = ed25519Sign(null, Buffer.from(manifestHash, 'hex'), privateKeyPem)

  const manifest = { ...fullBody, keyId: keyIdOf(publicKey), signatureBase64: signature.toString('base64') }
  const outPath = path.join(root, 'app-manifest.sig.json')
  fs.writeFileSync(outPath, `${JSON.stringify({ format: MANIFEST_FORMAT, manifestHash, manifest }, null, 2)}\n`)

  console.log(`เซ็นแล้ว: ${outPath}`)
  console.log(`manifestId: ${manifestId}  keyId: ${manifest.keyId}`)
  // ตรวจกลับด้วยไฟล์ที่เขียนลงดิสก์เสมอ (แสดงให้เห็นว่าลายเซ็นใช้งานได้จริง)
  return verifyExisting(root, projectRoot)
}

function verifyExisting(root: string, projectRoot: string): number {
  const outPath = path.join(root, 'app-manifest.sig.json')
  if (!fs.existsSync(outPath)) {
    console.error(`ไม่พบไฟล์ลายเซ็น: ${outPath} — รัน manifest:sign ก่อน`)
    return 1
  }
  const keyPath = resolvePrivateKeyPath(undefined, projectRoot)
  const publicKey = fs.existsSync(keyPath) ? createPublicKey(fs.readFileSync(keyPath, 'utf8')) : null
  if (!publicKey) {
    console.error(`ไม่พบ public key จาก private key ที่ ${keyPath}`)
    return 1
  }
  const readBack = JSON.parse(fs.readFileSync(outPath, 'utf8')) as {
    manifestHash: string
    manifest: {
      manifestId: string
      appVersion: string
      platform: string
      arch: string
      builtAt: number
      files: Record<string, { size: number; sha256: string; blockHashes64k: string[] }>
      signatureBase64: string
    }
  }
  // ตรวจ 2 ชั้น: (1) ไฟล์ต้นฉบับบนดิสก์ยังเท่ากับ hash ที่ประกาศ (2) ลายเซ็นครอบ canonical body
  for (const [relativePath, entry] of Object.entries(readBack.manifest.files)) {
    const absolutePath = path.join(root, ...relativePath.split('/'))
    if (!fs.existsSync(absolutePath) || hashFile(absolutePath).sha256 !== entry.sha256) {
      console.error(`ตรวจไม่ผ่าน: ไฟล์ถูกเปลี่ยน/ห่างจาก manifest → ${relativePath}`)
      return 1
    }
  }
  const readBackFiles = readBack.manifest.files
  const probeBack = canonical({
    manifestId: readBack.manifest.manifestId,
    appVersion: readBack.manifest.appVersion,
    platform: readBack.manifest.platform,
    arch: readBack.manifest.arch,
    builtAt: readBack.manifest.builtAt,
    files: readBackFiles
  })
  // manifestId = sha256(canonical(body with manifestId=PENDING)).slice(0,16) — เทียบกับการ derive เดิมเสมอ
  const derivedId = canonical({
    manifestId: 'PENDING',
    appVersion: readBack.manifest.appVersion,
    platform: readBack.manifest.platform,
    arch: readBack.manifest.arch,
    builtAt: readBack.manifest.builtAt,
    files: readBackFiles
  })
  const derivedIdHash = createHash('sha256').update(derivedId, 'utf8').digest('hex')
  const canonicalHash = createHash('sha256').update(probeBack, 'utf8').digest('hex')
  const signatureOk = verifyWithPem(probeBack, readBack.manifest.manifestId, readBack.manifest.signatureBase64, publicKey)
  const idOk = readBack.manifest.manifestId === derivedIdHash.slice(0, 16)
  if (signatureOk && idOk && readBack.manifestHash === canonicalHash) {
    console.log('ตรวจลายเซ็นกลับสำเร็จ — ไฟล์ต้นฉบับ + ลายเซ็น + manifestId ถูกต้องครบ')
    return 0
  }
  console.error(
    `ลายเซ็นไม่ถูกต้อง! (signature=${signatureOk}, manifestId=${idOk}, hashFile=${readBack.manifestHash === canonicalHash})`
  )
  return 1
}

process.exitCode = main()

// scripts/keygen.ts — สร้าง Ed25519 keypair ของ ZT-Exam (Phase 4.1)
//
// การใช้งาน:
//   node scripts/keygen.ts                 # สร้าง/ทับกุญแจใน artifacts/ (พร้อมอัปเดต trusted-keys.ts)
//   node scripts/keygen.ts --no-update     # สร้างกุญแจแต่ไม่แตะไฟล์ trusted-keys.ts
//
// กติกาสำคัญ:
// - Private Key เก็บใน artifacts/ (ไฟล์นี้ต้องอยู่ใน .gitignore — ห้าม commit เด็ดขาด)
// - Production จริงควรสร้าง/เก็บกุญแจบนเครื่อง offline หรือ Hardware Token แทนตามเอกสาร arc
// - keyId = sha256(publicKeyPem) 12 ตัวแรก (ตรงกับ deriveKeyIdFromPublicKeyPem ใน runtime)
import { createHash, generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// keyId ของกุญแจ public — ต้องตรงกับ deriveKeyIdFromPublicKeyPem ใน src/shared/attestation-schema.ts
// (script แยกโค้ดคุ้มค่าเองเพื่อไม่พึ่ง path alias ของ bundler)
function deriveKeyId(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem.trim(), 'utf8').digest('hex').slice(0, 12)
}

const projectRoot = path.resolve(import.meta.dirname, '..')
const artifactsDir = path.join(projectRoot, 'artifacts')
const privatePemPath = path.join(artifactsDir, 'zt-exam-signing-key.pem')
const publicPemPath = path.join(artifactsDir, 'zt-exam-signing-key.pub.pem')
const trustedKeysSource = path.join(projectRoot, 'src', 'main', 'attestation', 'trusted-keys.ts')
const MARKER = '// <ZT-EXAM-TRUSTED-MANIFEST-KEYS/>'

const shouldUpdateTrustedKeys = !process.argv.includes('--no-update')

fs.mkdirSync(artifactsDir, { recursive: true })

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

fs.writeFileSync(privatePemPath, privatePem, { mode: 0o600 })
fs.writeFileSync(publicPemPath, publicPem)

const keyId = deriveKeyId(publicPem)

if (shouldUpdateTrustedKeys && fs.existsSync(trustedKeysSource)) {
  const current = fs.readFileSync(trustedKeysSource, 'utf8')
  if (!current.includes(MARKER)) {
    console.error(`ไม่พบ marker ${MARKER} ใน ${trustedKeysSource} — ไม่ปรับปรุงไฟล์อัตโนมัติ`)
    process.exitCode = 1
  } else {
    const entry =
      `  '${keyId}': { publicKeyPem: ${JSON.stringify(publicPem.trim())}, comment: 'generated ${new Date().toISOString()}' },`
    const updated = current.replace(MARKER, `${MARKER}\n${entry}`)
    fs.writeFileSync(trustedKeysSource, updated)
    console.log(`อัปเดต ${path.relative(projectRoot, trustedKeysSource)} แล้ว (keyId=${keyId})`)
  }
}

console.log(`Private Key  : ${path.relative(projectRoot, privatePemPath)}  (ห้าม commit — อยู่ใน .gitignore)`)
console.log(`Public Key   : ${path.relative(projectRoot, publicPemPath)}`)
console.log(`keyId        : ${keyId}`)
console.log('')
console.log('ขั้นถัดไป:')
console.log('  1) npm run build            # สร้าง out/ ก่อน')
console.log('  2) npm run manifest:sign    # เซ็น resources/app-manifest.sig.json')

// scripts/sign-device-roster.ts — รวม roster entries แล้วเซ็นด้วย offline admin key
//
// การใช้งาน:
//   node scripts/sign-device-roster.ts --in entries.json --out device-roster.sig.json
//   node scripts/sign-device-roster.ts --in entries.ndjson --out <resources>/device-roster.sig.json --room room-01
//   node scripts/sign-device-roster.ts --in entries.json --key artifacts/zt-exam-signing-key.pem
//
// - entries.json รับได้ทั้ง array, { devices: [...] }, หรือ JSON Lines
// - ลายเซ็น Ed25519 ครอบ canonicalizeDeviceRosterBody(body) (ต้องตรงกับ src/shared/device-roster-schema.ts)
// - host โหลดไฟล์นี้จาก resources/device-roster.sig.json (หรือ env ZTEXAM_DEVICE_ROSTER ตอน dev)
import { createHash, createPublicKey, sign as ed25519Sign, type KeyObject } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  canonicalizeDeviceRosterBody,
  deriveDeviceId,
  type DeviceRosterBody
} from '../src/shared/device-roster-schema.ts'

interface RosterEntry {
  deviceId: string
  publicKey: string
  studentId?: string
  label?: string
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let i = 2; i < argv.length; i++) {
    const item = argv[i]
    if (!item || !item.startsWith('--')) continue
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

function keyIdOf(publicKeyObject: KeyObject): string {
  const pem = publicKeyObject.export({ type: 'spki', format: 'pem' }).toString().trim()
  return createHash('sha256').update(pem, 'utf8').digest('hex').slice(0, 12)
}

function readEntries(filePath: string): RosterEntry[] {
  const text = fs.readFileSync(filePath, 'utf8').trim()
  if (text === '') return []
  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed as RosterEntry[]
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { devices?: unknown }).devices)) {
      return (parsed as { devices: RosterEntry[] }).devices
    }
    return [parsed as RosterEntry]
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RosterEntry)
}

function normalizeEntries(entries: RosterEntry[]): RosterEntry[] {
  const seen = new Set<string>()
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('entry ไม่ถูกต้อง')
    const publicKey = String(entry.publicKey ?? '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(publicKey)) throw new Error(`publicKey ไม่ถูกต้อง: ${publicKey}`)
    const expectedId = deriveDeviceId(publicKey)
    if (entry.deviceId && String(entry.deviceId).toLowerCase() !== expectedId) {
      throw new Error(`deviceId ไม่ตรงกับ publicKey: ${entry.deviceId}`)
    }
    if (seen.has(expectedId)) throw new Error(`deviceId ซ้ำ: ${expectedId}`)
    seen.add(expectedId)
    return {
      deviceId: expectedId,
      publicKey,
      ...(typeof entry.studentId === 'string' && entry.studentId.trim() !== ''
        ? { studentId: entry.studentId.trim() }
        : {}),
      ...(typeof entry.label === 'string' && entry.label.trim() !== ''
        ? { label: entry.label.trim() }
        : {})
    }
  })
}

function main(): number {
  const args = parseArgs(process.argv)
  const input = typeof args.in === 'string' ? path.resolve(args.in) : null
  if (!input || !fs.existsSync(input)) {
    console.error('การใช้งาน: node scripts/sign-device-roster.ts --in <entries.json|ndjson> --out <device-roster.sig.json> [--key <pem>] [--room <roomId>]')
    return 1
  }
  const projectRoot = path.resolve(import.meta.dirname, '..')
  const keyPath = typeof args.key === 'string'
    ? path.resolve(args.key)
    : (process.env.ZTEXAM_SIGNING_KEY ?? path.join(projectRoot, 'artifacts', 'zt-exam-signing-key.pem'))
  if (!fs.existsSync(keyPath)) {
    console.error(`ไม่พบ private key ที่ ${keyPath} — รัน npm run keys:generate ก่อน (หรือกำหนด --key)`)
    return 1
  }

  let entries: RosterEntry[]
  try {
    entries = normalizeEntries(readEntries(input))
  } catch (error) {
    console.error(`roster entry ไม่ถูกต้อง: ${error instanceof Error ? error.message : 'unknown'}`)
    return 1
  }
  if (entries.length === 0) {
    console.error('ไม่มี entry ในไฟล์ input')
    return 1
  }

  const roomId = typeof args.room === 'string' ? args.room : undefined
  const body: DeviceRosterBody = { version: 1, devices: entries }
  if (roomId !== undefined) body.roomId = roomId

  const privateKeyPem = fs.readFileSync(keyPath, 'utf8')
  const publicKey = createPublicKey(privateKeyPem)
  const signature = ed25519Sign(
    null,
    Buffer.from(canonicalizeDeviceRosterBody(body), 'utf8'),
    privateKeyPem
  )
  const signed = { ...body, keyId: keyIdOf(publicKey), signatureBase64: signature.toString('base64') }

  const outPath = typeof args.out === 'string'
    ? path.resolve(args.out)
    : path.join(projectRoot, 'resources-unpacked', 'device-roster.sig.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(signed, null, 2)}\n`, 'utf8')

  console.log(`เซ็น roster แล้ว: ${outPath}`)
  console.log(`devices: ${entries.length}  keyId: ${signed.keyId}`)
  return 0
}

process.exitCode = main()

// scripts/provision-device.ts — อ่าน public key ของเครื่องนี้เพื่อสร้าง roster entry
//
// การใช้งาน (รันบนเครื่องนักเรียนหลังเปิดแอปครั้งแรก ซึ่งจะสร้าง device-key.json):
//   node scripts/provision-device.ts --file "%APPDATA%\zt-exam\device-key.json"
//   node scripts/provision-device.ts --data "%APPDATA%\zt-exam" --student s01
//   node scripts/provision-device.ts --file <...> --out entries.ndjson   # ต่อท้ายไฟล์รวม
//
// หมายเหตุ: อ่านเฉพาะ deviceId/publicKey (plaintext) — ไม่ถอด private seed
import fs from 'node:fs'
import path from 'node:path'
import { deriveDeviceId } from '../src/shared/device-roster-schema.ts'

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

interface DeviceKeyFile {
  deviceId?: unknown
  publicKeyHex?: unknown
  createdAtMs?: unknown
  hardwareBound?: unknown
}

function main(): number {
  const args = parseArgs(process.argv)
  const explicit = typeof args.file === 'string' ? path.resolve(args.file) : null
  const dataDir = typeof args.data === 'string' ? path.resolve(args.data) : null
  const filePath = explicit ?? (dataDir ? path.join(dataDir, 'device-key.json') : null)
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(
      'ไม่พบ device-key.json — ระบุ --file <path> หรือ --data <userDataDir> ' +
        '(เปิดแอปโหมดนักเรียนหนึ่งครั้งเพื่อสร้าง key ก่อน)'
    )
    return 1
  }

  let raw: DeviceKeyFile
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as DeviceKeyFile
  } catch {
    console.error(`อ่าน JSON ไม่ได้: ${filePath}`)
    return 1
  }

  const publicKeyHex =
    typeof raw.publicKeyHex === 'string' ? raw.publicKeyHex.toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) {
    console.error('publicKeyHex ใน device-key.json ไม่ถูกต้อง')
    return 1
  }
  const derivedId = deriveDeviceId(publicKeyHex)
  if (typeof raw.deviceId === 'string' && raw.deviceId.toLowerCase() !== derivedId) {
    console.error('deviceId ในไฟล์ไม่ตรงกับ public key (ไฟล์อาจถูกแก้)')
    return 1
  }

  const entry: Record<string, string> = { deviceId: derivedId, publicKey: publicKeyHex }
  if (typeof args.student === 'string' && args.student.trim() !== '') entry.studentId = args.student.trim()
  if (typeof args.label === 'string' && args.label.trim() !== '') entry.label = args.label.trim()

  const line = JSON.stringify(entry)
  console.log(line)
  if (typeof args.out === 'string') {
    fs.appendFileSync(path.resolve(args.out), `${line}\n`, 'utf8')
    console.log(`เพิ่ม entry ลง ${path.resolve(args.out)}`)
  }
  if (raw.hardwareBound === false) {
    console.warn('คำเตือน: เครื่องนี้ใช้ machine-id แบบ fallback (ไม่ผูกกับ MachineGuid/machine-id)')
  }
  return 0
}

process.exitCode = main()

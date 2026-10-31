import fs from 'node:fs'
import path from 'node:path'

/* ============================================================
 * Reconnect token store — เก็บ token ใต้ userData แบบเข้ารหัสด้วย OS
 * - vault ที่ส่งเข้ามาคือ safeStorage ของ Electron
 *   (Windows: DPAPI, macOS: Keychain, Linux: libsecret/kwallet)
 * - ถ้า OS ไม่มี keyring (Linux บางเครื่อง) จะ fallback เป็น plaintext
 *   พร้อมไฟล์ mode 0600 — ยังดีกว่าเดิมที่เขียน plaintext ตรง ๆ
 * ============================================================ */

export interface TokenVault {
  encrypt(plain: string): string | null
  decrypt(cipher: string): string | null
}

export interface ReconnectTokenStoreOptions {
  filePath: string
  /** ไฟล์รุ่นเก่า (plaintext map) — ย้ายเข้า store ใหม่อัตโนมัติเมื่ออ่าน */
  legacyFilePath?: string
  vault: TokenVault
}

const ENC_PREFIX = 'enc:'
const PLAIN_PREFIX = 'plain:'

function keyOf(roomId: string, studentId: string): string {
  return `${roomId}:${studentId}`
}

export class ReconnectTokenStore {
  constructor(private readonly opts: ReconnectTokenStoreOptions) {}

  load(roomId: string, studentId: string): string | null {
    const map = this.read()
    const value = map[keyOf(roomId, studentId)]
    if (typeof value === 'string') return this.decode(value)
    // fallback: ไฟล์ plaintext รุ่นเก่า → อ่านได้และย้ายเข้ารูปแบบใหม่
    const legacy = this.readLegacy()
    const old = legacy[keyOf(roomId, studentId)]
    if (typeof old !== 'string') return null
    this.save(roomId, studentId, old)
    return old
  }

  save(roomId: string, studentId: string, token: string): void {
    if (!token) return
    const map = this.read()
    map[keyOf(roomId, studentId)] = this.encode(token)
    this.write(map)
  }

  clear(roomId: string, studentId: string): void {
    const map = this.read()
    delete map[keyOf(roomId, studentId)]
    this.write(map)
  }

  /** จำนวน token ที่เก็บอยู่ (ใช้ตรวจการ migrate ใน test) */
  size(): number {
    return Object.keys(this.read()).length
  }

  private encode(token: string): string {
    try {
      const encrypted = this.opts.vault.encrypt(token)
      if (encrypted) return `${ENC_PREFIX}${encrypted}`
    } catch {
      // keyring ล็อก/ยังไม่พร้อม — ตกไป plaintext
    }
    return `${PLAIN_PREFIX}${Buffer.from(token, 'utf8').toString('base64')}`
  }

  private decode(value: string): string | null {
    if (value.startsWith(ENC_PREFIX)) {
      try {
        return this.opts.vault.decrypt(value.slice(ENC_PREFIX.length)) || null
      } catch {
        return null
      }
    }
    if (value.startsWith(PLAIN_PREFIX)) {
      try {
        return Buffer.from(value.slice(PLAIN_PREFIX.length), 'base64').toString('utf8') || null
      } catch {
        return null
      }
    }
    // ค่าเก่าที่เป็น token ตรง ๆ (ก่อนมี prefix)
    return value.length > 0 ? value : null
  }

  private read(): Record<string, string> {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.opts.filePath, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const map: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string') map[k] = v
      }
      return map
    } catch {
      return {}
    }
  }

  private readLegacy(): Record<string, string> {
    const file = this.opts.legacyFilePath
    if (!file) return {}
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const map: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string') map[k] = v
      }
      return map
    } catch {
      return {}
    }
  }

  private write(map: Record<string, string>): void {
    try {
      const file = this.opts.filePath
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(map), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {
      // เขียนไม่ได้ — token ในหน่วยความจำยังใช้ต่อได้ในรอบนี้
    }
  }
}

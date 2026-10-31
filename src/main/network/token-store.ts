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
  /**
   * อนุญาต fallback เป็น plaintext base64 เมื่อ OS keyring ใช้ไม่ได้
   * ค่าตั้งต้น false = fail-closed (ไม่เก็บ token ที่อ่านได้ด้วยคนอื่น)
   */
  allowPlaintextFallback?: boolean
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
    // fallback: ไฟล์ plaintext รุ่นเก่า → ย้ายได้เฉพาะเมื่อมี vault ที่เข้ารหัสได้จริง
    const legacy = this.readLegacy()
    const old = legacy[keyOf(roomId, studentId)]
    if (typeof old !== 'string') return null
    if (!this.save(roomId, studentId, old)) {
      // keyring ใช้ไม่ได้และไม่อนุญาต plaintext → ลบ legacy ทิ้ง (fail-closed)
      this.purgeLegacy()
      return null
    }
    return old
  }

  /** คืน false เมื่อไม่สามารถเก็บ token ได้อย่างปลอดภัย (ไม่ได้เขียนอะไรลงดิสก์) */
  save(roomId: string, studentId: string, token: string): boolean {
    if (!token) return false
    const encoded = this.encode(token)
    if (encoded === null) return false
    const map = this.read()
    map[keyOf(roomId, studentId)] = encoded
    this.write(map)
    return true
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

  private encode(token: string): string | null {
    try {
      const encrypted = this.opts.vault.encrypt(token)
      if (encrypted) return `${ENC_PREFIX}${encrypted}`
    } catch {
      // keyring ล็อก/ยังไม่พร้อม
    }
    if (this.opts.allowPlaintextFallback === true) {
      return `${PLAIN_PREFIX}${Buffer.from(token, 'utf8').toString('base64')}`
    }
    return null
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
      // plaintext รุ่นเก่า: ใช้ต่อเฉพาะเมื่อครู/ผู้ดูแลเปิด fallback ไว้
      if (this.opts.allowPlaintextFallback !== true) return null
      try {
        return Buffer.from(value.slice(PLAIN_PREFIX.length), 'base64').toString('utf8') || null
      } catch {
        return null
      }
    }
    // ค่าเก่าที่เป็น token ตรง ๆ (ก่อนมี prefix) — ต้อง migrate ผ่าน vault เท่านั้น
    if (this.opts.allowPlaintextFallback === true) return value.length > 0 ? value : null
    return null
  }

  private purgeLegacy(): void {
    const file = this.opts.legacyFilePath
    if (!file) return
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // ลบไม่ได้ — อย่างน้อยก็ไม่คืน token ให้ผู้เรียก
    }
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

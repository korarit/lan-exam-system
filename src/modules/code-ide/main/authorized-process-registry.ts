/* Phase 9 (9.5) — AuthorizedChildProcessRegistry
 * ทะเบียน pid ชั่วคราวของโปรเซสลูกที่ Runtime Sandbox สั่งรันเอง
 * (CLI test run, Backend server, compiler) — ให้ guard ฝั่ง 3a ข้ามการฟ้อง
 * โปรเซสเหล่านี้ (เช่น ห้ามฟ้อง SUSPICIOUS_COMPUTE_SPIKE ใส่ python.exe
 * ที่กำลังรันโค้ดนักเรียน) แต่ถ้ามันยิงเน็ตออกนอก loopback จะฟ้องด้วย
 * รหัสเฉพาะ STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL แทน
 */

export interface AuthorizedProcessEntry {
  pid: number
  reason: string
  expiresAtMs: number
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class AuthorizedChildProcessRegistry {
  private readonly entries = new Map<number, AuthorizedProcessEntry>()

  /** ลงทะเบียน pid ชั่วคราว (ttl เกินจริงได้ — isAuthorized ตรวจวันหมดอายุ + ตัด pid ที่ตายแล้ว) */
  register(pid: number, reason: string, ttlMs = 120_000): void {
    if (!Number.isInteger(pid) || pid <= 0) return
    this.entries.set(pid, { pid, reason, expiresAtMs: Date.now() + Math.max(0, ttlMs) })
  }

  unregister(pid: number): void {
    this.entries.delete(pid)
  }

  clear(): void {
    this.entries.clear()
  }

  size(): number {
    return this.entries.size
  }

  /** pid นี้เป็นลูกที่ sandbox สั่งรันเองและยังไม่หมดอายุหรือไม่ */
  isAuthorized(pid: number): boolean {
    const entry = this.entries.get(pid)
    if (!entry) return false
    if (Date.now() >= entry.expiresAtMs || !isAlive(pid)) {
      this.entries.delete(pid)
      return false
    }
    return true
  }
}

/** singleton ต่อ main process (เครื่องนักเรียน + เครื่องแม่ใช้คนละอินสแตนซ์ของตัวเอง) */
export const authorizedChildProcesses = new AuthorizedChildProcessRegistry()

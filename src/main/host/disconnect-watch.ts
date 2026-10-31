/* ============================================================
 * DisconnectWatch — ติดตามช่วงที่นักเรียนหลุดการเชื่อมต่อระหว่างสอบ
 * - หลุดต่อเนื่องเกิน freezeAfterMs → แจ้ง onExpired (host ตัดสิน freeze)
 * - กลับมา → คืนระยะเวลาที่หายไป (ใช้ log/audit)
 * แยก scheduler ออกเพื่อทดสอบได้โดยไม่ต้องรอเวลาจริง
 * ============================================================ */

export type DisconnectTimer = ReturnType<typeof setTimeout>

export interface DisconnectScheduler {
  setTimeout: (fn: () => void, ms: number) => DisconnectTimer
  clearTimeout: (handle: DisconnectTimer) => void
}

const realScheduler: DisconnectScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle)
}

export interface DisconnectWatchOptions {
  /** ระยะหลุดที่ถือว่าเกินกำหนด (null = ไม่ freeze แต่ยังวัด duration) */
  freezeAfterMs: number | null
  onExpired: (info: { studentId: string; offlineForMs: number }) => void
  now?: () => number
  scheduler?: DisconnectScheduler
}

export class DisconnectWatch {
  private readonly offlineSince = new Map<string, number>()
  private readonly timers = new Map<string, DisconnectTimer>()
  private readonly now: () => number
  private readonly scheduler: DisconnectScheduler

  constructor(private readonly opts: DisconnectWatchOptions) {
    this.now = opts.now ?? Date.now
    this.scheduler = opts.scheduler ?? realScheduler
  }

  markOffline(studentId: string): void {
    if (this.offlineSince.has(studentId)) return
    this.offlineSince.set(studentId, this.now())
    const freezeAfterMs = this.opts.freezeAfterMs
    if (freezeAfterMs === null || freezeAfterMs <= 0) return
    const handle = this.scheduler.setTimeout(() => {
      this.timers.delete(studentId)
      const since = this.offlineSince.get(studentId)
      if (since === undefined) return
      this.opts.onExpired({ studentId, offlineForMs: this.now() - since })
    }, freezeAfterMs)
    this.timers.set(studentId, handle)
  }

  /** คืนระยะเวลาที่หลุดไป (null = ไม่ได้หลุดมาก่อน) */
  markOnline(studentId: string): { offlineForMs: number } | null {
    const since = this.offlineSince.get(studentId)
    const timer = this.timers.get(studentId)
    if (timer !== undefined) this.scheduler.clearTimeout(timer)
    this.timers.delete(studentId)
    this.offlineSince.delete(studentId)
    if (since === undefined) return null
    return { offlineForMs: Math.max(0, this.now() - since) }
  }

  isOffline(studentId: string): boolean {
    return this.offlineSince.has(studentId)
  }

  clear(): void {
    for (const timer of this.timers.values()) this.scheduler.clearTimeout(timer)
    this.timers.clear()
    this.offlineSince.clear()
  }
}

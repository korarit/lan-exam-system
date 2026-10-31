/* ============================================================
 * TypingMonitor — วัดจังหวะพิมพ์จาก main process (ไม่เชื่อ renderer)
 * ใช้ webContents 'before-input-event' ที่ทำงานได้ทั้ง Windows/macOS/Linux
 * - เก็บ inter-key interval (IKI) ของปุ่มที่พิมพ์ได้
 * - flush เมื่อผู้สอบหยุดพิมพ์ หรือเมื่อครบจำนวนตัวอย่าง
 * ============================================================ */

export interface TypingCollectorOptions {
  /** หยุดนานเกิน ms → ตัดชุดตัวอย่าง (default 2000) */
  idleResetMs?: number
  /** จำนวน interval ขั้นต่ำก่อนส่งวิเคราะห์ (default 20) */
  minSamples?: number
  /** ครบจำนวนนี้ส่งทันที (default 80) */
  maxSamples?: number
}

export class TypingIntervalCollector {
  private intervals: number[] = []
  private lastKeyAtMs: number | null = null
  private readonly idleResetMs: number
  private readonly minSamples: number
  private readonly maxSamples: number

  constructor(opts: TypingCollectorOptions = {}) {
    this.idleResetMs = opts.idleResetMs ?? 2_000
    this.minSamples = opts.minSamples ?? 20
    this.maxSamples = opts.maxSamples ?? 80
  }

  /** บันทึกการกดปุ่มที่พิมพ์ได้ — คืนชุด interval เมื่อครบกำหนด */
  record(atMs: number, printable: boolean): number[] | null {
    if (!printable) return null
    if (this.lastKeyAtMs !== null) {
      const delta = atMs - this.lastKeyAtMs
      if (delta >= 0 && delta <= this.idleResetMs) {
        this.intervals.push(delta)
      } else {
        // หยุดนาน/เวลาผิดปกติ → เริ่มชุดใหม่
        this.intervals = []
      }
    }
    this.lastKeyAtMs = atMs
    if (this.intervals.length >= this.maxSamples) return this.take()
    return null
  }

  /** เรียกเป็นระยะ: ถ้าหยุดพิมพ์นานพอและมีตัวอย่างครบ → คืนชุดที่จบแล้ว */
  tick(atMs: number): number[] | null {
    if (this.lastKeyAtMs === null) return null
    if (atMs - this.lastKeyAtMs < this.idleResetMs) return null
    this.lastKeyAtMs = null
    if (this.intervals.length < this.minSamples) {
      this.intervals = []
      return null
    }
    return this.take()
  }

  reset(): void {
    this.intervals = []
    this.lastKeyAtMs = null
  }

  private take(): number[] {
    const out = this.intervals
    this.intervals = []
    return out
  }
}

export interface TypingMonitorOptions {
  onSample: (intervalsMs: number[]) => void
  idleResetMs?: number
  minSamples?: number
  maxSamples?: number
  now?: () => number
  /** ค่าเริ่มต้น 250ms — ใช้ timer เดียว ไม่ผูกกับ platform */
  tickIntervalMs?: number
}

export class TypingMonitor {
  private readonly collector: TypingIntervalCollector
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly opts: TypingMonitorOptions) {
    this.now = opts.now ?? Date.now
    this.collector = new TypingIntervalCollector({
      ...(opts.idleResetMs !== undefined ? { idleResetMs: opts.idleResetMs } : {}),
      ...(opts.minSamples !== undefined ? { minSamples: opts.minSamples } : {}),
      ...(opts.maxSamples !== undefined ? { maxSamples: opts.maxSamples } : {})
    })
  }

  start(): void {
    if (this.timer) return
    const interval = this.opts.tickIntervalMs ?? 250
    this.timer = setInterval(() => this.flushIfIdle(), interval)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.collector.reset()
  }

  /** เรียกจาก before-input-event (main process) */
  handleKeyDown(key: string): void {
    if (key.length !== 1) return
    const sample = this.collector.record(this.now(), true)
    if (sample) this.opts.onSample(sample)
  }

  private flushIfIdle(): void {
    const sample = this.collector.tick(this.now())
    if (sample) this.opts.onSample(sample)
  }
}

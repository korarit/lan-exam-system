import { randomInt } from 'node:crypto'

/* ============================================================
 * JitteredScheduler — ตารางสแกนที่สุ่มช่วงหน่วงทุกรอบ
 * กันผู้สอบที่อ่านซอร์สแล้วกะจังหวะทำงาน "หลบระหว่างรอบตรวจ"
 * ============================================================ */

export interface JitteredSchedulerOptions {
  minIntervalMs: number
  maxIntervalMs: number
  task: () => void | Promise<void>
  /** inject ได้เพื่อทดสอบ (ค่าตั้งต้นคือ CSPRNG ของ OS) */
  randomInt?: (min: number, max: number) => number
}

export class JitteredScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private lastRunAtMs = 0
  private readonly randomInt: (min: number, max: number) => number

  constructor(private readonly opts: JitteredSchedulerOptions) {
    this.randomInt = opts.randomInt ?? ((min, max) => randomInt(min, max + 1))
    if (this.opts.maxIntervalMs < this.opts.minIntervalMs) {
      throw new Error('SCHEDULER_INTERVAL_INVALID')
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  get lastRunAt(): number {
    return this.lastRunAtMs
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.scheduleNext()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** หน่วงสุ่มระหว่าง [minIntervalMs, maxIntervalMs] ทุกครั้งก่อนรัน task */
  private scheduleNext(): void {
    if (!this.running) return
    const delay = this.randomInt(this.opts.minIntervalMs, this.opts.maxIntervalMs)
    this.timer = setTimeout(() => {
      void this.runOnce()
    }, delay)
  }

  async runOnce(): Promise<void> {
    if (!this.running) return
    this.lastRunAtMs = Date.now()
    try {
      await this.opts.task()
    } catch {
      // task พังไม่ควรหยุดตารางทั้งระบบ — watchdog จะเป็นตัวจับความผิดปกติของ detector
    }
    if (this.running) this.scheduleNext()
  }
}

/* ============================================================
 * CrossDetectorWatchdog — เช็กว่าทุก detector ยัง tick อยู่
 * Detector ที่ค้าง/ถูกระงับเกิน stallThresholdMs ต้องถูกฟ้องทันที
 * (มิฉะนั้นผู้โกงแค่ "ระงับ thread ตัวตรวจ" ก็ปิดตาเครื่องแม่ได้)
 * ============================================================ */

export interface WatchedDetector {
  readonly detectorId: string
  /** timestamp ครั้งล่าสุดที่ detector ทำงานจริง (เรียก tick() บ่อย ๆ) */
  getLastTickAtMs(): number
}

export interface CrossDetectorWatchdogOptions {
  stallThresholdMs?: number
  checkIntervalMs?: number
  onStalled: (detectorId: string, idleMs: number) => void
  now?: () => number
}

export class CrossDetectorWatchdog {
  private readonly detectors = new Map<string, WatchedDetector>()
  private readonly stallThresholdMs: number
  private readonly checkIntervalMs: number
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  /** ป้องกันยิง event ซ้ำรัวเดียวกันต่อ detector เดิม */
  private readonly reportedStalled = new Set<string>()

  constructor(private readonly opts: CrossDetectorWatchdogOptions) {
    this.stallThresholdMs = opts.stallThresholdMs ?? 10_000
    this.checkIntervalMs = opts.checkIntervalMs ?? 1_000
    this.now = opts.now ?? Date.now
  }

  register(detector: WatchedDetector): void {
    this.detectors.set(detector.detectorId, detector)
    this.reportedStalled.delete(detector.detectorId)
  }

  unregister(detectorId: string): void {
    this.detectors.delete(detectorId)
    this.reportedStalled.delete(detectorId)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.checkAll(), this.checkIntervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  checkAll(): void {
    const now = this.now()
    for (const detector of this.detectors.values()) {
      const idle = now - detector.getLastTickAtMs()
      if (idle > this.stallThresholdMs && !this.reportedStalled.has(detector.detectorId)) {
        this.reportedStalled.add(detector.detectorId)
        this.opts.onStalled(detector.detectorId, idle)
      }
    }
  }
}

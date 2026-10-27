import { EventEmitter } from 'node:events'

export const HEARTBEAT_INTERVAL_MS = 3000
export const HEARTBEAT_TIMEOUT_MS = 8000
export const RECONNECT_BASE_MS = 1000
export const RECONNECT_MAX_MS = 5000

/**
 * Heartbeat Monitor (ใช้ได้ทั้งสองฝั่ง)
 * - ส่ง ping ตาม interval
 * - ถ้าไม่มีข้อมูลเข้าใด ๆ เกิน timeout → emit 'timeout' (fail-closed)
 * - ทุกข้อความเข้าต้องเรียก recordActivity() เพื่อรีเซ็ตนาฬิกา
 */
export class HeartbeatMonitor extends EventEmitter {
  private pingTimer: NodeJS.Timeout | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private lastActivityMs = Date.now()

  constructor(
    private readonly opts: {
      intervalMs?: number
      timeoutMs?: number
      sendPing: () => void
      onTimeout: () => void
    }
  ) {
    super()
  }

  start(): void {
    if (this.pingTimer) return
    this.lastActivityMs = Date.now()
    this.pingTimer = setInterval(
      () => this.opts.sendPing(),
      this.opts.intervalMs ?? HEARTBEAT_INTERVAL_MS
    )
    this.checkTimer = setInterval(() => {
      const timeoutMs = this.opts.timeoutMs ?? HEARTBEAT_TIMEOUT_MS
      if (Date.now() - this.lastActivityMs > timeoutMs) {
        this.stop()
        this.opts.onTimeout()
      }
    }, 500)
  }

  recordActivity(): void {
    this.lastActivityMs = Date.now()
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.checkTimer) clearInterval(this.checkTimer)
    this.pingTimer = null
    this.checkTimer = null
  }
}

/** ลำดับ delay ของ auto-reconnect: 1s, 2s, 4s, 5s, 5s, ... */
export function nextReconnectDelayMs(attempt: number): number {
  const delay = RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1)
  return Math.min(delay, RECONNECT_MAX_MS)
}

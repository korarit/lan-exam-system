import fs from 'node:fs'
import type { DetectionEvent } from '@shared/policy-schema'
import { makeDetectionEvent } from './process-inspector'
import { runCommand } from './system-probes'
import { resolveTrustedExecutable } from './trusted-binary'

/* ============================================================
 * SessionSwitchGuard (VULN-48)
 * - Linux: VT switch (/sys/class/tty/tty0/active)
 * - macOS: console user เปลี่ยน (fast user switching)
 * - Windows: ใช้ powerMonitor lock/unlock ใน main (แยก)
 * เฝ้าเฉพาะระหว่างสอบ — เปลี่ยน session = event
 * ============================================================ */

export interface SessionSnapshot {
  activeTty?: string | null
  consoleUser?: string | null
}

/** คืนเหตุผลเมื่อ snapshot เปลี่ยน (pure — ทดสอบได้) */
export function detectSessionChange(
  previous: SessionSnapshot | null,
  current: SessionSnapshot
): 'vt-switch' | 'console-user-switch' | null {
  if (!previous) return null
  if (
    previous.activeTty !== undefined &&
    current.activeTty !== undefined &&
    previous.activeTty !== current.activeTty
  ) {
    return 'vt-switch'
  }
  if (
    previous.consoleUser !== undefined &&
    current.consoleUser !== undefined &&
    previous.consoleUser !== current.consoleUser
  ) {
    return 'console-user-switch'
  }
  return null
}

export interface SessionSwitchGuardOptions {
  emit: (event: DetectionEvent) => void
  platform?: NodeJS.Platform
  readSnapshot?: () => Promise<SessionSnapshot | null>
  intervalMs?: number
  now?: () => number
}

export class SessionSwitchGuard {
  readonly detectorId = 'session-switch-guard'
  private readonly platform: NodeJS.Platform
  private readonly readSnapshot: () => Promise<SessionSnapshot | null>
  private readonly intervalMs: number
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private baseline: SessionSnapshot | null = null
  private lastTickAtMs = 0

  constructor(private readonly opts: SessionSwitchGuardOptions) {
    this.platform = opts.platform ?? process.platform
    this.readSnapshot = opts.readSnapshot ?? (() => defaultReadSnapshot(this.platform))
    this.intervalMs = opts.intervalMs ?? 5_000
    this.now = opts.now ?? Date.now
  }

  getLastTickAtMs(): number {
    return this.lastTickAtMs
  }

  start(): void {
    if (this.timer) return
    this.baseline = null
    void this.checkNow()
    this.timer = setInterval(() => {
      void this.checkNow()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.baseline = null
  }

  async checkNow(): Promise<SessionSnapshot | null> {
    this.lastTickAtMs = this.now()
    let snapshot: SessionSnapshot | null
    try {
      snapshot = await this.readSnapshot()
    } catch {
      return null
    }
    if (!snapshot) return null
    // snapshot แรก = baseline (ไม่รายงาน)
    if (this.baseline === null) {
      this.baseline = snapshot
      return snapshot
    }
    const reason = detectSessionChange(this.baseline, snapshot)
    if (reason) {
      this.opts.emit(
        makeDetectionEvent('SESSION_SWITCH_DETECTED', this.detectorId, {
          reason,
          ...(snapshot.activeTty ? { activeTty: snapshot.activeTty } : {}),
          ...(snapshot.consoleUser ? { consoleUser: snapshot.consoleUser } : {})
        }, undefined, this.now)
      )
      // อัปเดต baseline หลังรายงาน เพื่อไม่ให้ยิงซ้ำทุก tick
      this.baseline = snapshot
    }
    return snapshot
  }
}

async function defaultReadSnapshot(platform: NodeJS.Platform): Promise<SessionSnapshot | null> {
  if (platform === 'linux') {
    try {
      const activeTty = fs.readFileSync('/sys/class/tty/tty0/active', 'utf8').trim()
      return { activeTty }
    } catch {
      return null
    }
  }
  if (platform === 'darwin') {
    const stat = resolveTrustedExecutable('stat', platform)
    const output = await runCommand(stat, ['-f%Su', '/dev/console'], 3_000)
    const consoleUser = output.trim()
    return consoleUser.length > 0 ? { consoleUser } : null
  }
  return null
}

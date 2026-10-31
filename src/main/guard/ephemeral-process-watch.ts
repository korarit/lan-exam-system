import fs from 'node:fs'
import path from 'node:path'
import { runCommand } from './system-probes'

/* ============================================================
 * Portable short-lived process watcher (Phase 3a — non-Windows)
 * - Windows ใช้ Win32_ProcessStartTrace (event-based) อยู่แล้ว
 * - Linux/macOS ใช้ snapshot ถี่ (ไม่มี kernel event โดยไม่ต้อง root)
 * - เก็บ firstSeen ต่อ pid แล้วรายงานเมื่อโปรเซสหายไปภายใน maxVisibleMs
 * - ไม่ต้องใช้สิทธิ์ kernel/admin (อ่าน /proc ของ user ตัวเอง / เรียก ps)
 * ============================================================ */

export interface ShortLivedProcess {
  pid: number
  name: string
  ppid: number
  /** true = ยืนยันว่าโปรเซสอยู่สั้นกว่า maxVisibleMs (ต่างจาก Windows trace ที่เป็น start event) */
  shortLived: true
}

export interface TrackedProcess {
  name: string
  firstSeenAtMs: number
  baseline: boolean
}

export interface StepResult {
  next: Map<number, TrackedProcess>
  shortLived: Array<{ pid: number; name: string }>
}

/**
 * เดินตารางโปรเซสหนึ่งก้าว (pure): เพิ่ม pid ใหม่, ลบ pid ที่หาย
 * - รอบแรก (baseline) ไม่รายงานอะไร เพื่อไม่ให้โปรเซสที่รันอยู่ก่อนสอบกลายเป็น false positive
 */
export function stepProcessTable(
  tracked: Map<number, TrackedProcess>,
  current: ReadonlyMap<number, string>,
  nowMs: number,
  maxVisibleMs: number,
  isBaseline: boolean
): StepResult {
  const next = new Map<number, TrackedProcess>()
  const shortLived: Array<{ pid: number; name: string }> = []

  for (const [pid, name] of current) {
    const existing = tracked.get(pid)
    if (existing) {
      next.set(pid, existing)
    } else {
      next.set(pid, { name, firstSeenAtMs: nowMs, baseline: isBaseline })
    }
  }

  if (!isBaseline) {
    for (const [pid, entry] of tracked) {
      if (current.has(pid)) continue
      if (!entry.baseline && nowMs - entry.firstSeenAtMs <= maxVisibleMs) {
        shortLived.push({ pid, name: entry.name || 'unknown' })
      }
    }
  }

  return { next, shortLived }
}

export interface PortableTraceOptions {
  pollIntervalMs?: number
  maxVisibleMs?: number
  now?: () => number
  /** snapshot ของ pid → ชื่อโปรเซส (inject สำหรับทดสอบ) */
  snapshot?: () => Promise<Map<number, string>>
  /** เมื่อ snapshot ล้มติดกันเกินจำนวนนี้ ให้ผู้เรียกตัดสินใจ (ค่าเริ่มต้น: ข้ามเงียบ) */
  onProbeFailure?: (reason: string) => void
}

const linuxNameCache = new Map<number, string>()

async function linuxSnapshot(): Promise<Map<number, string>> {
  const result = new Map<number, string>()
  const seen = new Set<number>()
  const entries = await fs.promises.readdir('/proc')
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    seen.add(pid)
    const cached = linuxNameCache.get(pid)
    if (cached !== undefined) {
      result.set(pid, cached)
      continue
    }
    try {
      const name = (await fs.promises.readFile(`/proc/${entry}/comm`, 'utf8')).trim().toLowerCase()
      if (name !== '') {
        linuxNameCache.set(pid, name)
        result.set(pid, name)
      }
    } catch {
      // โปรเซสปิดไปแล้ว — ข้าม
    }
  }
  // ล้าง cache ของ pid ที่หายไป (กัน map โตและกันชื่อค้างเมื่อ pid ถูกใช้ซ้ำ)
  for (const pid of linuxNameCache.keys()) {
    if (!seen.has(pid)) linuxNameCache.delete(pid)
  }
  return result
}

async function macSnapshot(): Promise<Map<number, string>> {
  const result = new Map<number, string>()
  const output = await runCommand('ps', ['-axo', 'pid=,comm='], 3_000)
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const name = path.basename((match[2] ?? '').trim()).toLowerCase()
    if (Number.isInteger(pid) && pid > 0 && name !== '') result.set(pid, name)
  }
  return result
}

function defaultSnapshot(): (() => Promise<Map<number, string>>) | null {
  if (process.platform === 'linux') return linuxSnapshot
  if (process.platform === 'darwin') return macSnapshot
  return null
}

/** เริ่ม watcher ของ Linux/macOS — คืน null เมื่อแพลตฟอร์มไม่รองรับ (Windows ใช้ trace เดิม) */
export function startPortableProcessTrace(
  onProcess: (p: ShortLivedProcess) => void,
  opts: PortableTraceOptions = {}
): (() => void) | null {
  const snapshot = opts.snapshot ?? defaultSnapshot()
  if (!snapshot) return null
  const pollIntervalMs = opts.pollIntervalMs ?? (process.platform === 'darwin' ? 500 : 200)
  const maxVisibleMs = opts.maxVisibleMs ?? 2_000
  const now = opts.now ?? Date.now

  let tracked = new Map<number, TrackedProcess>()
  let first = true
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let consecutiveFailures = 0

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void tick()
    }, pollIntervalMs)
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    let current: Map<number, string>
    try {
      current = await snapshot()
      consecutiveFailures = 0
    } catch (error) {
      consecutiveFailures += 1
      if (consecutiveFailures === 2) {
        opts.onProbeFailure?.(error instanceof Error ? error.message : 'snapshot-failed')
      }
      schedule()
      return
    }
    // snapshot ว่างผิดปกติ (คำสั่งล้มแต่ไม่ throw) — อย่าตีความว่าโปรเซสทั้งหมดหาย
    // และอย่าปิด baseline flag จาก snapshot ที่ใช้ไม่ได้
    if (current.size === 0) {
      schedule()
      return
    }
    const result = stepProcessTable(tracked, current, now(), maxVisibleMs, first)
    tracked = result.next
    first = false
    for (const p of result.shortLived) {
      if (p.pid === process.pid) continue
      onProcess({ pid: p.pid, name: p.name, ppid: 0, shortLived: true })
    }
    schedule()
  }

  void tick()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }
}

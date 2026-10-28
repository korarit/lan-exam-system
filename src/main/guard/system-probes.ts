import { execFile } from 'node:child_process'

/* ============================================================
 * System probes — ชั้น adapter ที่คุยกับ OS (PowerShell / /proc)
 * ทุก probe ต้องมี timeout และ fail เงียบ ๆ (คืนค่าว่าง) เสมอ
 * ============================================================ */

export const PROBE_TIMEOUT_MS = 6_000

/** รันคำสั่งแบบมี timeout — คืน stdout หรือ '' เมื่อล้มเหลว */
export function runCommand(
  file: string,
  args: string[],
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve('')
          return
        }
        resolve(stdout)
      }
    )
  })
}

/** รัน PowerShell (Windows เท่านั้น) แบบ -NoProfile -NonInteractive */
export function runPowerShell(script: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string> {
  return runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    timeoutMs
  )
}

/** parse บรรทัดละ JSON (ผลลัพธ์จาก ForEach-Object | ConvertTo-Json -Compress) */
export function parseJsonLines<T>(output: string): T[] {
  const results: T[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      results.push(JSON.parse(trimmed) as T)
    } catch {
      // ข้ามบรรทัดเสีย
    }
  }
  return results
}

/** quote อาร์กิวเมนต์สำหรับฝังใน single-quoted PowerShell string */
export function psQuote(value: string): string {
  return value.replace(/'/g, "''")
}

import fs from 'node:fs'
import path from 'node:path'

/* ============================================================
 * Trusted OS helper resolution (VULN-45)
 * - ห้ามเรียก helper ด้วยชื่อล้วน (PATH/cwd hijack)
 * - ใช้ absolute path ที่ผู้ใช้ทั่วไปเขียนไม่ได้
 * ============================================================ */

type Platform = NodeJS.Platform

const TRUSTED_PATHS: Record<string, Partial<Record<Platform, string[]>>> = {
  ps: {
    darwin: ['/bin/ps'],
    linux: ['/bin/ps', '/usr/bin/ps']
  },
  who: {
    darwin: ['/usr/bin/who'],
    linux: ['/usr/bin/who', '/bin/who']
  },
  loginctl: {
    linux: ['/usr/bin/loginctl', '/bin/loginctl']
  },
  'systemd-detect-virt': {
    linux: ['/usr/bin/systemd-detect-virt', '/bin/systemd-detect-virt']
  },
  sysctl: {
    darwin: ['/usr/sbin/sysctl', '/usr/bin/sysctl'],
    linux: ['/usr/sbin/sysctl', '/sbin/sysctl', '/usr/bin/sysctl']
  },
  stat: {
    darwin: ['/usr/bin/stat', '/bin/stat'],
    linux: ['/usr/bin/stat', '/bin/stat']
  },
  xprop: {
    linux: ['/usr/bin/xprop']
  },
  codesign: {
    darwin: ['/usr/bin/codesign']
  },
  vmmap: {
    darwin: ['/usr/bin/vmmap']
  },
  defaults: {
    darwin: ['/usr/bin/defaults']
  },
  pgrep: {
    darwin: ['/usr/bin/pgrep'],
    linux: ['/usr/bin/pgrep', '/bin/pgrep']
  },
  gsettings: {
    linux: ['/usr/bin/gsettings', '/bin/gsettings']
  }
}

/** คืน absolute path ที่มีอยู่จริง — ถ้าไม่มีเลยให้คืนชื่อเดิมเพื่อให้ probe ล้มอย่างชัดเจน */
export function resolveTrustedExecutable(
  name: string,
  platform: Platform = process.platform,
  exists: (filePath: string) => boolean = fs.existsSync
): string {
  const candidates = TRUSTED_PATHS[name]?.[platform] ?? []
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return name
}

/** Windows PowerShell ต้องมาจาก System32 เท่านั้น (กัน powershell.exe ปลอมใน cwd/PATH) */
export function powershellExecutable(
  platform: Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform !== 'win32') return 'powershell.exe'
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

import path from 'node:path'
import type { RuntimeBinding } from '@shared/attestation-schema'
import {
  findDangerousRuntimeFlags,
  isPathInside,
  parseCommandLineArgs
} from '../guard/runtime-integrity-guard'

/* ============================================================
 * Runtime binding validation (VULN-05/62)
 * - host ตรวจว่า client ที่ขอ attestation ไม่ได้รันจาก wrapper/ที่อื่น
 * - ใช้ร่วมกับ native runtime guard ฝั่งเครื่องนักเรียน
 * ============================================================ */

function normalize(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

function isAbsoluteLikePath(value: string): boolean {
  if (!value || value.startsWith('-')) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\') || value.includes('\\')
}

/** คืน reason แรกที่พบ หรือ null เมื่อ binding ดูปกติ */
export function findRuntimeBindingViolation(binding: RuntimeBinding): string | null {
  if (binding.defaultApp) return 'runtime-default-app'
  if (!binding.packaged) return 'runtime-unpackaged'

  const resourcesPath = binding.resourcesPath.trim()
  if (resourcesPath === '') return 'runtime-resources-missing'
  const resourcesName = path.basename(resourcesPath).toLowerCase()
  if (resourcesName !== 'resources') return 'runtime-resources-path'

  if (binding.addonPath && binding.addonPath.trim() !== '') {
    if (!isPathInside(binding.addonPath, resourcesPath)) return 'runtime-addon-outside-resources'
  }

  for (const flag of findDangerousRuntimeFlags(binding.commandLine)) {
    return `runtime-command-line-flag:${flag}`
  }

  for (const rawArg of parseCommandLineArgs(binding.commandLine)) {
    let candidate = rawArg
    if (candidate.startsWith('--')) {
      const eq = candidate.indexOf('=')
      if (eq < 0) continue
      candidate = candidate.slice(eq + 1).replace(/^["']|["']$/g, '')
    }
    if (!isAbsoluteLikePath(candidate)) continue
    if (!/\.(asar|js|mjs|cjs|ts)$/i.test(candidate)) continue
    if (normalize(candidate) === normalize(binding.executablePath)) continue
    if (isPathInside(candidate, resourcesPath)) continue
    if (isPathInside(candidate, path.dirname(binding.executablePath))) continue
    return 'runtime-external-app-path'
  }
  return null
}

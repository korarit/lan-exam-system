import { createRequire } from 'node:module'
import { resolveNativeAddonPath } from './native-bridge'

/* ============================================================
 * Process mitigation hardening (VULN-01 / VULN-05 / VULN-16)
 * - ใช้ Windows process mitigation policies ระดับ OS เพื่อ "กัน" injection
 *   ไม่ใช่แค่ detect: extension points, image load จาก network/low-IL,
 *   strict handles และ CFG (ถ้าไบนารีรองรับ)
 * - ต้องเรียกก่อนโหลดพื้นผิวที่รับข้อมูลภายนอก (ทำใน index.ts ตอนบูต)
 * ============================================================ */

export interface MitigationResult {
  ok: boolean
  applied: string[]
  failed: string[]
  /** policy ที่ระบบ/ไบนารีไม่รองรับ — ไม่ถือว่าแอปพัง */
  skipped: string[]
  platform?: string
}

interface MitigationAddon {
  applyProcessMitigations(): string
}

export type MitigationLoader = () => MitigationAddon | null

function defaultLoader(): MitigationAddon | null {
  const resolved = resolveNativeAddonPath(process.env.NODE_ENV === 'development')
  if (!resolved) return null
  try {
    const requireNative = createRequire(__filename)
    const loaded = requireNative(resolved) as Partial<MitigationAddon>
    if (typeof loaded.applyProcessMitigations === 'function') {
      return loaded as MitigationAddon
    }
  } catch {
    // addon โหลดไม่ได้/ABI ไม่ตรง — ไม่ขวางการเปิดแอป
  }
  return null
}

/** parse ผลจาก native แบบ strict (กันข้อมูลเพี้ยน) */
export function parseMitigationResult(json: string): MitigationResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.ok !== 'boolean') return null
  const toList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return {
    ok: record.ok,
    applied: toList(record.applied),
    failed: toList(record.failed),
    skipped: toList(record.skipped),
    ...(typeof record.platform === 'string' ? { platform: record.platform } : {})
  }
}

/**
 * ใช้ mitigation policies กับ process ปัจจุบัน
 * คืน null เมื่อไม่มี native addon (dev/แพลตฟอร์มอื่น) — ไม่ throw
 */
export function applyProcessMitigations(loader: MitigationLoader = defaultLoader): MitigationResult | null {
  const addon = loader()
  if (!addon) return null
  try {
    return parseMitigationResult(addon.applyProcessMitigations())
  } catch {
    return null
  }
}

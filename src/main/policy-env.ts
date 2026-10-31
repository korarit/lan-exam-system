/* ============================================================
 * Policy resolution helpers (VULN-42)
 * - Production builds ต้องเชื่อเฉพาะ signed deployment config
 * - env fallback (`ZTEXAM_*`) ใช้ได้เฉพาะ dev/unpackaged เท่านั้น
 * ============================================================ */

/** env policy fallback อนุญาตเฉพาะ build ที่ไม่ใช่ production */
export function envOverridesAllowed(production: boolean): boolean {
  return !production
}

/**
 * ค่าที่ signed config ระบุชนะเสมอ
 * - production: ถ้า signed ไม่มี → ไม่ใช้ env (คืน undefined)
 * - dev: ใช้ env ได้
 */
export function signedOrDevEnv<T>(
  production: boolean,
  signed: T | undefined,
  envValue: T | undefined
): T | undefined {
  if (signed !== undefined) return signed
  return production ? undefined : envValue
}

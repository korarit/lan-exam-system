/* ============================================================
 * CSV/Excel formula safety
 * - ค่าที่ขึ้นต้นด้วย = + - @ หรือ tab/CR อาจถูก Excel ตีความเป็นสูตร
 * - เติม ' ข้างหน้าเพื่อบังคับให้เป็น text (OWASP CSV injection)
 * - ตัวเลขล้วน (รวมค่าลบ) ไม่แตะ เพื่อไม่ทำให้คอลัมน์คะแนนเสีย
 * ============================================================ */

const PURE_NUMBER_RE = /^-?\d+(?:\.\d+)?%?$/

/** เติม ' เมื่อค่าเริ่มต้นด้วยอักขระที่ Excel/Sheets ตีความเป็นสูตร */
export function neutralizeCsvFormula(value: string): string {
  const rawFirst = value[0]
  if (rawFirst === '\t' || rawFirst === '\r') return `'${value}`
  const trimmed = value.replace(/^[ \u00A0\uFEFF]+/, '')
  if (trimmed === '') return value
  const first = trimmed[0]
  if (first === '=' || first === '+' || first === '@') {
    return `'${value}`
  }
  if (first === '-' && !PURE_NUMBER_RE.test(trimmed)) {
    return `'${value}`
  }
  return value
}

/** escape ตาม RFC 4180 หลัง neutralize สูตรแล้ว */
export function escapeCsvCell(value: string): string {
  const safe = neutralizeCsvFormula(value)
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

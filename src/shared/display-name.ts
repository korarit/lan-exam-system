/* ============================================================
 * Display-name sanitizer
 * - ชื่อที่นักเรียนประกาศเองไหลเข้า dashboard / audit / CSV
 * - ลบ bidi override + zero-width + control chars เพื่อกัน spoof/ซ่อนข้อความ
 * ============================================================ */

const BIDI_AND_ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g

export const MAX_DISPLAY_NAME_LENGTH = 80

export function sanitizeDisplayName(raw: unknown, fallback = 'ไม่ระบุชื่อ'): string {
  const text = typeof raw === 'string' ? raw : ''
  const cleaned = text
    .replace(BIDI_AND_ZERO_WIDTH, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
    .trim()
  return cleaned.length > 0 ? cleaned : fallback
}

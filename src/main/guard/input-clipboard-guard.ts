import type { DetectionEvent, DetectionPolicyBody } from '@shared/policy-schema'
import { makeDetectionEvent } from './process-inspector'
import { sha256Hex } from '../crypto/primitives'
import { clipboard } from 'electron'

/* ============================================================
 * InputClipboardGuard — Phase 3a.5
 * 1) Clipboard guard: ข้อความในคลิปบอร์ดที่ไม่ได้มาจากการคัดลอก
 *    ภายในแอป = ถูกฉีดจากอุปกรณ์อื่น (Phone Link / Universal Clipboard)
 * 2) Typing pattern analyzer: จังหวะพิมพ์แบบเครื่องจักร
 *    (ความเร็วเกินมนุษย์ / ความแปรปรวนต่ำผิดธรรมชาติ)
 * ============================================================ */

export interface TypingPatternReport {
  sampleCount: number
  cps: number
  stdDevMs: number
}

export const TYPING_ABNORMAL_MIN_CHARS = 40
export const TYPING_ABNORMAL_MAX_CPS = 20
export const TYPING_ABNORMAL_MIN_STDDEV_MS = 2

/**
 * วิเคราะห์จังหวะการพิมพ์จากช่วงห่างระหว่างการกดปุ่ม (IKI, ms) — pure
 * - cps คำนวณจากค่ากลางของ interval (1000 / median) เพื่อกัน outlier ช่วงหยุดคิด
 * - stdDev ต่ำ (< 2ms) ที่ตัวอักษรยาว ๆ = มนุษย์พิมพ์ไม่ได้ = auto-typer
 */
export function analyzeTypingPattern(intervalsMs: number[]): TypingPatternReport {
  if (intervalsMs.length === 0) {
    return { sampleCount: 0, cps: 0, stdDevMs: 0 }
  }
  const sorted = [...intervalsMs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
  const cps = median > 0 ? 1000 / median : 0
  const mean = intervalsMs.reduce((sum, v) => sum + v, 0) / intervalsMs.length
  const variance =
    intervalsMs.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / intervalsMs.length
  return {
    sampleCount: intervalsMs.length + 1,
    cps: Math.round(cps * 100) / 100,
    stdDevMs: Math.round(Math.sqrt(variance) * 100) / 100
  }
}

/** เกณฑ์ผิดปกติ: พิมพ์ยาว >= 40 ตัวอักษร ด้วยความเร็ว > 20 ตัวอักษร/วิ หรือจังหวะคงที่ผิดธรรมชาติ */
export function isAbnormalTypingPattern(report: TypingPatternReport): boolean {
  if (report.sampleCount < TYPING_ABNORMAL_MIN_CHARS) return false
  if (report.cps > TYPING_ABNORMAL_MAX_CPS) return true
  return report.stdDevMs < TYPING_ABNORMAL_MIN_STDDEV_MS
}

/* ---------- Clipboard state tracker (pure — ทดสอบได้) ---------- */

export interface ClipboardCheckResult {
  injected: boolean
  event: DetectionEvent | null
}

export class ClipboardStateTracker {
  private lastInternalHash = ''

  /** renderer แจ้งว่าผู้สอบคัดลอกภายในแอปเอง — อัปเดต hash อ้างอิง */
  markInternalCopy(text: string): void {
    this.lastInternalHash = sha256Hex(text)
  }

  /** เนื้อหานี้มาจากการคัดลอกภายในแอปหรือไม่ */
  isInternalText(text: string): boolean {
    return text.length > 0 && sha256Hex(text) === this.lastInternalHash
  }

  /** hash ของเนื้อหาปัจจุบันในคลิปบอร์ด (main เรียกทุก 1.5 วิ) */
  checkExternalInjection(clipboardText: string): ClipboardCheckResult {
    if (!clipboardText) return { injected: false, event: null }
    if (this.isInternalText(clipboardText)) {
      return { injected: false, event: null }
    }
    // เนื้อหาแปลกปลอม → บันทึกหลักฐานแล้วให้ผู้เรียกล้างคลิปบอร์ดทันที
    const event = makeDetectionEvent('EXTERNAL_CLIPBOARD_INJECTION', 'input-clipboard-guard', {
      length: String(clipboardText.length),
      preview: clipboardText.slice(0, 100)
    })
    return { injected: true, event }
  }
}

/* ---------- Guard ---------- */

export interface InputClipboardGuardOptions {
  getPolicy: () => DetectionPolicyBody | null
  emit: (event: DetectionEvent) => void
  /** อ่านข้อความคลิปบอร์ด (default: electron clipboard — async ใน Electron ใหม่) */
  readClipboardText?: () => string | Promise<string>
  /** รูปแบบเนื้อหาในคลิปบอร์ด (default: clipboard.read() ของ Electron) */
  getClipboardFormats?: () => string[] | Promise<string[]>
  /** ล้างคลิปบอร์ดทันทีเมื่อเจอการฉีดจากภายนอก */
  clearClipboard?: () => void
  now?: () => number
}

/**
 * รูปแบบที่ถือว่า "ไม่ใช่ข้อความธรรมดา" — paste รูป/ไฟล์/URI ต้องถูกบล็อก
 * (Electron คืน MIME-ish เช่น image/png, text/uri-list, Files)
 */
export function hasNonTextClipboardContent(formats: readonly string[]): boolean {
  return formats.some((format) => {
    const lower = format.toLowerCase()
    return (
      lower.startsWith('image/') ||
      lower.startsWith('application/') ||
      lower === 'files' ||
      lower === 'text/uri-list'
    )
  })
}

const CLIPBOARD_POLL_INTERVAL_MS = 1_500

export class InputClipboardGuard {
  readonly detectorId = 'input-clipboard-guard'
  private readonly tracker: ClipboardStateTracker
  private readonly now: () => number
  private readonly readClipboardText: () => Promise<string>
  private readonly getClipboardFormats: () => Promise<string[]>
  private readonly clearClipboard: () => void
  private lastTickAtMs = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly opts: InputClipboardGuardOptions) {
    this.now = opts.now ?? Date.now
    this.readClipboardText = async () => {
      if (opts.readClipboardText) return await opts.readClipboardText()
      try {
        const text: unknown = await clipboard.readText()
        return typeof text === 'string' ? text : ''
      } catch {
        return ''
      }
    }
    this.clearClipboard =
      opts.clearClipboard ??
      (() => {
        try {
          clipboard.clear()
        } catch {
          // ไม่มี clipboard (สภาพแวดล้อมทดสอบ) — ปล่อยผ่าน
        }
      })
    this.getClipboardFormats = async () => {
      if (opts.getClipboardFormats) return await opts.getClipboardFormats()
      try {
        const items = await clipboard.read()
        return [...new Set(items.flatMap((item) => item.types ?? []))]
      } catch {
        return []
      }
    }
    this.tracker = new ClipboardStateTracker()
  }

  getLastTickAtMs(): number {
    return this.lastTickAtMs
  }

  start(): void {
    this.lastTickAtMs = this.now()
    if (this.timer) return
    // เริ่มสอบ: ล้างคลิปบอร์ดเดิมทิ้ง (Mode 1 / Mode 2)
    const policy = this.opts.getPolicy()
    if (policy && policy.examMode !== 'external-tools') {
      this.clearClipboard()
    }
    this.timer = setInterval(() => {
      void this.pollOnce()
    }, CLIPBOARD_POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** renderer แจ้งการคัดลอกภายใน (กัน false positive) */
  markInternalCopy(text: string): void {
    this.tracker.markInternalCopy(text)
  }

  /** renderer/main ส่งสถิติการพิมพ์มาวิเคราะห์ (IKI ms ต่อช่วงการพิมพ์หนึ่ง) */
  ingestTypingSamples(
    intervalsMs: number[],
    source: 'main' | 'renderer' = 'renderer'
  ): DetectionEvent | null {
    const report = analyzeTypingPattern(intervalsMs)
    if (!isAbnormalTypingPattern(report)) return null
    const event = makeDetectionEvent(
      'ABNORMAL_TYPING_PATTERN',
      this.detectorId,
      {
        chars: String(report.sampleCount),
        cps: String(report.cps),
        stdDevMs: String(report.stdDevMs),
        source
      },
      report.cps > TYPING_ABNORMAL_MAX_CPS * 3 ? undefined : 15,
      this.now
    )
    this.opts.emit(event)
    return event
  }

  /** ตรวจก่อนวางเนื้อหาจากคลิปบอร์ด — false = ไม่ควรอนุญาตให้วาง */
  async interceptPaste(): Promise<boolean> {
    // บล็อกรูป/ไฟล์/URI ก่อน — ตรวจเฉพาะ text ไม่พอ
    const formats = await this.getClipboardFormats()
    if (hasNonTextClipboardContent(formats)) {
      this.clearClipboard()
      this.opts.emit(
        makeDetectionEvent(
          'EXTERNAL_CLIPBOARD_INJECTION',
          this.detectorId,
          {
            format: formats.join(',').slice(0, 200),
            source: 'paste-non-text'
          },
          undefined,
          this.now
        )
      )
      return false
    }
    const text = await this.readClipboardText()
    if (!text) return true
    if (this.tracker.isInternalText(text)) return true
    this.clearClipboard()
    this.opts.emit(
      makeDetectionEvent(
        'EXTERNAL_CLIPBOARD_INJECTION',
        this.detectorId,
        {
          length: String(text.length),
          preview: text.slice(0, 100),
          source: 'paste'
        },
        undefined,
        this.now
      )
    )
    return false
  }

  private async pollOnce(): Promise<void> {
    this.lastTickAtMs = this.now()
    const text = await this.readClipboardText()
    const result = this.tracker.checkExternalInjection(text)
    if (result.injected && result.event) {
      this.clearClipboard()
      this.opts.emit(result.event)
    }
  }
}

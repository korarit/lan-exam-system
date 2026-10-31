import { describe, expect, it } from 'vitest'
import {
  analyzeTypingPattern,
  isAbnormalTypingPattern,
  ClipboardStateTracker,
  InputClipboardGuard
} from './input-clipboard-guard'
import type { DetectionEvent, DetectionPolicyBody } from '@shared/policy-schema'
import { buildDefaultPolicy, DetectionPolicyBodySchema } from '@shared/policy-schema'

const policy: DetectionPolicyBody = DetectionPolicyBodySchema.parse(buildDefaultPolicy('closed'))

describe('analyzeTypingPattern + isAbnormalTypingPattern', () => {
  it('พิมพ์ 100 ตัวอักษร ช่วงห่าง 1ms คงที่ → ABNORMAL_TYPING_PATTERN (มนุษย์พิมพ์ไม่ได้)', () => {
    const report = analyzeTypingPattern(Array.from({ length: 99 }, () => 1))
    expect(report.sampleCount).toBe(100)
    expect(report.cps).toBeGreaterThan(20)
    expect(report.stdDevMs).toBeLessThan(2)
    expect(isAbnormalTypingPattern(report)).toBe(true)
  })

  it('จังหวะคงที่ 30ms (33 ตัวอักษร/วินาที ต่อเนื่องผิดธรรมชาติ) ก็ติดเกณฑ์ stdDev', () => {
    const report = analyzeTypingPattern(Array.from({ length: 60 }, () => 30))
    expect(report.cps).toBeGreaterThan(20)
    expect(isAbnormalTypingPattern(report)).toBe(true)
  })

  it('การพิมพ์ของมนุษย์ (เร็ว-ช้าสลับกัน) ต้องไม่ติด', () => {
    const human = [90, 130, 210, 95, 150, 180, 88, 240, 105, 160, 200, 99, 140, 175, 82, 310, 120, 155]
    const report = analyzeTypingPattern(human)
    expect(isAbnormalTypingPattern(report)).toBe(false)
  })

  it('ตัวอักษรน้อยกว่า 40 ตัว ไม่ตัดสิน (กัน false positive จากคำสั้น)', () => {
    const fast = analyzeTypingPattern(Array.from({ length: 20 }, () => 1))
    expect(isAbnormalTypingPattern(fast)).toBe(false)
  })
})

describe('ClipboardStateTracker — EXTERNAL_CLIPBOARD_INJECTION', () => {
  it('ข้อความแปลกปลอมในคลิปบอร์ด (ไม่ได้คัดลอกภายในแอป) → injected + ล้าง', () => {
    const tracker = new ClipboardStateTracker()
    const result = tracker.checkExternalInjection('คำตอบที่ส่งจากมือถือผ่าน Phone Link')
    expect(result.injected).toBe(true)
    expect(result.event?.code).toBe('EXTERNAL_CLIPBOARD_INJECTION')
    expect(result.event?.detail.preview?.length ?? 0).toBeLessThanOrEqual(100)
  })

  it('การคัดลอกภายในแอป (markInternalCopy แล้ว hash ตรง) ต้องไม่ถูกฟ้อง', () => {
    const tracker = new ClipboardStateTracker()
    tracker.markInternalCopy('ข้อความที่ผู้สอบคัดลอกเองภายในช่องตอบ')
    const result = tracker.checkExternalInjection('ข้อความที่ผู้สอบคัดลอกเองภายในช่องตอบ')
    expect(result.injected).toBe(false)
  })

  it('คลิปบอร์ดว่างไม่ฟ้อง', () => {
    const tracker = new ClipboardStateTracker()
    expect(tracker.checkExternalInjection('').injected).toBe(false)
  })
})

describe('InputClipboardGuard — end-to-end (injected probes)', () => {
  function makeGuard(
    clipboardText: () => string,
    cleared: { value: boolean }
  ): { guard: InputClipboardGuard; events: DetectionEvent[] } {
    const events: DetectionEvent[] = []
    const guard = new InputClipboardGuard({
      getPolicy: () => policy,
      emit: (e) => events.push(e),
      readClipboardText: clipboardText,
      clearClipboard: () => {
        cleared.value = true
      },
      now: () => 1_000_000
    })
    return { guard, events }
  }

  it('guard ต้องรายงาน detector id และล้างคลิปบอร์ดผ่าน adapter ที่ inject เข้ามา', () => {
    const cleared = { value: false }
    const { guard } = makeGuard(() => '', cleared)
    expect(guard.detectorId).toBe('input-clipboard-guard')
    guard.markInternalCopy('คัดลอกภายในแอป')
    expect(cleared.value).toBe(false)
  })

  it('ingestTypingSamples ด้วยจังหวะเครื่องจักร → ฟ้อง ABNORMAL_TYPING_PATTERN', () => {
    const cleared = { value: false }
    const { guard, events } = makeGuard(() => '', cleared)
    const event = guard.ingestTypingSamples(Array.from({ length: 80 }, () => 2))
    expect(event).not.toBeNull()
    expect(event!.code).toBe('ABNORMAL_TYPING_PATTERN')
    expect(events).toHaveLength(1)
  })

  it('interceptPaste ปล่อยผ่านเมื่อเป็นข้อความที่คัดลอกภายในแอป', () => {
    const cleared = { value: false }
    const text = 'ข้อความที่คัดลอกเอง'
    const { guard, events } = makeGuard(() => text, cleared)
    guard.markInternalCopy(text)
    expect(guard.interceptPaste()).toBe(true)
    expect(cleared.value).toBe(false)
    expect(events).toHaveLength(0)
  })

  it('interceptPaste บล็อกและล้างเมื่อเป็นข้อความจากภายนอก', () => {
    const cleared = { value: false }
    const { guard, events } = makeGuard(() => 'ข้อความจากภายนอก', cleared)
    expect(guard.interceptPaste()).toBe(false)
    expect(cleared.value).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]!.code).toBe('EXTERNAL_CLIPBOARD_INJECTION')
    expect(events[0]!.detail.source).toBe('paste')
  })
})

import { describe, expect, it } from 'vitest'
import { applyProcessMitigations, parseMitigationResult } from './process-mitigations'

describe('process mitigations', () => {
  it('parse ผลปกติ', () => {
    expect(
      parseMitigationResult(
        '{"ok":true,"applied":["image-load-policy"],"failed":[],"skipped":["control-flow-guard"],"platform":"win32"}'
      )
    ).toEqual({
      ok: true,
      applied: ['image-load-policy'],
      failed: [],
      skipped: ['control-flow-guard'],
      platform: 'win32'
    })
  })

  it('ข้อมูลเพี้ยน → null', () => {
    expect(parseMitigationResult('not-json')).toBeNull()
    expect(parseMitigationResult('{"ok":"yes"}')).toBeNull()
  })

  it('apply ผ่าน loader ที่ฉีดเข้ามา (ไม่ต้องมี addon จริง)', () => {
    const result = applyProcessMitigations(() => ({
      applyProcessMitigations: () =>
        '{"ok":true,"applied":["extension-point-disable","image-load-policy"],"failed":[]}'
    }))
    expect(result?.ok).toBe(true)
    expect(result?.applied).toContain('extension-point-disable')
  })

  it('loader คืน null (dev/ไม่มี addon) → null', () => {
    expect(applyProcessMitigations(() => null)).toBeNull()
  })
})

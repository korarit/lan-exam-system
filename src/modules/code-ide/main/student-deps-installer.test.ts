import { describe, expect, it } from 'vitest'
import { installStudentPackages } from './student-deps-installer'

/* ============================================================
 * F-3b — เครื่องนักเรียน pip/npm install เอง (ครู opt-in)
 * เทสต์เฉพาะชั้น validation (ไม่ยิงเน็ตจริง):
 * - ปฏิเสธ spec อันตราย/ว่าง/เกินจำนวน ก่อนแตะ registry
 * ============================================================ */

const PKG = 'a23e4567-e89b-12d3-a456-426614174011'

describe('F-3b — installStudentPackages validation', () => {
  it('ไม่มีแพ็กเกจ → NO_PACKAGES (ไม่ spawn)', async () => {
    const r = await installStudentPackages({ packageId: PKG, packages: [] })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('NO_PACKAGES')
  })

  it('เกิน 50 ชุด → TOO_MANY_PACKAGES (ไม่ spawn)', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ ecosystem: 'npm' as const, name: `p${i}`, version: '1.0.0' }))
    const r = await installStudentPackages({ packageId: PKG, packages: many })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('TOO_MANY_PACKAGES')
  })

  it.each([
    ['https://evil.example/x.tgz', '1.0.0'],
    ['git+https://evil.example/x.git', '1.0.0'],
    ['../escape', '1.0.0'],
    ['pkg;rm -rf', '1.0.0'],
    ['pkg', 'https://evil.example/x.tgz'],
    ['pkg', '']
  ])('ปฏิเสธ spec อันตราย name=%s version=%s', async (name, version) => {
    const r = await installStudentPackages({
      packageId: PKG,
      packages: [{ ecosystem: 'npm', name, version }]
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/^PACKAGE_REJECTED/)
  })

  it('ปฏิเสธ shell metachars ในชื่อ pip', async () => {
    const r = await installStudentPackages({
      packageId: PKG,
      packages: [{ ecosystem: 'pip', name: 'req$(whoami)', version: '2.31.0' }]
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/^PACKAGE_REJECTED/)
  })
})

import { describe, expect, it } from 'vitest'
import { envOverridesAllowed, signedOrDevEnv } from './policy-env'

describe('policy-env', () => {
  it('production ไม่อนุญาต env fallback', () => {
    expect(envOverridesAllowed(true)).toBe(false)
    expect(signedOrDevEnv(true, undefined, 'env-value')).toBeUndefined()
  })

  it('production เชื่อ signed config ถ้ามี', () => {
    expect(signedOrDevEnv(true, 'signed-value', 'env-value')).toBe('signed-value')
  })

  it('dev ใช้ env fallback ได้', () => {
    expect(envOverridesAllowed(false)).toBe(true)
    expect(signedOrDevEnv(false, undefined, 'env-value')).toBe('env-value')
  })
})

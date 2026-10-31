import { describe, expect, it } from 'vitest'
import { sanitizeDisplayName, MAX_DISPLAY_NAME_LENGTH } from './display-name'

describe('sanitizeDisplayName', () => {
  it('keeps normal Thai/Latin names and collapses whitespace', () => {
    expect(sanitizeDisplayName('  สมชาย   ใจดี ')).toBe('สมชาย ใจดี')
    expect(sanitizeDisplayName('Somchai Jaidee')).toBe('Somchai Jaidee')
  })

  it('removes bidi override and zero-width characters used for spoofing', () => {
    expect(sanitizeDisplayName('สมชาย\u202E\u0000')).toBe('สมชาย')
    expect(sanitizeDisplayName('A\u200BB\u200FC')).toBe('ABC')
  })

  it('replaces control chars with spaces and trims', () => {
    expect(sanitizeDisplayName('a\n\tb')).toBe('a b')
  })

  it('falls back when empty and caps length', () => {
    expect(sanitizeDisplayName('   ', 'student-1')).toBe('student-1')
    expect(sanitizeDisplayName('x'.repeat(200)).length).toBe(MAX_DISPLAY_NAME_LENGTH)
  })
})

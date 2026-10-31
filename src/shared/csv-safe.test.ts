import { describe, expect, it } from 'vitest'
import { escapeCsvCell, neutralizeCsvFormula } from './csv-safe'

describe('csv-safe — Excel formula injection', () => {
  it('neutralizes formula-leading characters', () => {
    expect(neutralizeCsvFormula('=HYPERLINK("http://evil")')).toBe('\'=HYPERLINK("http://evil")')
    expect(neutralizeCsvFormula('+1+1')).toBe("'+1+1")
    expect(neutralizeCsvFormula('@SUM(A1:A2)')).toBe("'@SUM(A1:A2)")
    expect(neutralizeCsvFormula('\tcmd')).toBe("'\tcmd")
  })

  it('keeps plain numbers (including negatives) untouched', () => {
    expect(neutralizeCsvFormula('-5')).toBe('-5')
    expect(neutralizeCsvFormula('-5.25')).toBe('-5.25')
    expect(neutralizeCsvFormula('-10%')).toBe('-10%')
  })

  it('neutralizes a negative that is not a pure number', () => {
    expect(neutralizeCsvFormula('-1+2')).toBe("'-1+2")
  })

  it('still quotes commas/quotes/newlines after neutralizing', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"')
    expect(escapeCsvCell('=a,"b"')).toBe('"\'=a,""b"""')
  })
})

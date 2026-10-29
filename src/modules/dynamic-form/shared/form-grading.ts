import type { AnswerKey, FormQuestion } from './form-schema'

/* ============================================================
 * Phase 6 — ตัวคิดคะแนนรายข้อแบบทันที (ใช้ใน Preview และ Phase 7 ฝั่ง Host)
 * คืนคะแนนในหน่วย "สัดส่วนของข้อ (0..1)" — คูณ points ที่ผู้เรียก
 * เป็นขั้นสุดท้ายเพื่อให้ compatible กับคะแนนรายแถวของ grid
 * ============================================================ */

export interface ItemGradeResult {
  /** 0..1 ของคะแนนเต็มข้อ (หรือของแถว ตามสัญญาของฟังก์ชัน) */
  ratio: number
  auto: boolean
  /** เฉลยไม่ถูกกำหนด → รอครูตรวจ (manual_rubric) หรือไม่คิดคะแนน */
  manual: boolean
}

export interface NormalizedItemAnswer {
  choiceId?: string
  choiceIds?: string[]
  text?: string
  numeric?: number
  rowAnswers?: Record<string, string | string[]>
  scaleValue?: number
  dateTime?: string
  codeText?: string
  fileNames: string[]
}

/** ตรวจข้อเดียวด้วยเฉลยของข้อนั้น — answer: คำตอบที่ normalize แล้วจาก form-validate */
export function gradeAnsweredRatio(
  answerKey: AnswerKey,
  answer: NormalizedItemAnswer,
  resolvedParameters?: Record<string, number>
): ItemGradeResult {
  switch (answerKey.gradingType) {
    case 'ungraded':
      return { ratio: 0, auto: false, manual: false }
    case 'manual_rubric':
      return { ratio: 0, auto: false, manual: true }
    case 'exact_choice':
      return gradeExactChoice(answerKey, answer)
    case 'multi_choice':
      return gradeMultiChoice(answerKey, answer)
    case 'short_text_match':
      return gradeShortText(answerKey, answer)
    case 'numeric_formula': {
      const numeric = answer.numeric ?? answer.scaleValue
      if (numeric === undefined || !Number.isFinite(numeric)) {
        return { ratio: 0, auto: true, manual: false }
      }
      return { ratio: gradeNumericFormula(answerKey, numeric, resolvedParameters), auto: true, manual: false }
    }
    case 'grid_match':
      return { ratio: gradeGridMatch(answerKey, answer), auto: true, manual: false }
  }
}

function gradeExactChoice(
  key: Extract<AnswerKey, { gradingType: 'exact_choice' }>,
  answer: NormalizedItemAnswer
): ItemGradeResult {
  if (answer.choiceId === undefined) return { ratio: 0, auto: true, manual: false }
  if (answer.choiceId !== key.correctChoiceId) {
    return { ratio: 0, auto: true, manual: false }
  }
  if (key.choiceWeights !== undefined) {
    const weight = key.choiceWeights[answer.choiceId]
    return { ratio: weight === undefined ? 0 : Math.max(0, Math.min(1, weight)), auto: true, manual: false }
  }
  return { ratio: 1, auto: true, manual: false }
}

function gradeMultiChoice(
  key: Extract<AnswerKey, { gradingType: 'multi_choice' }>,
  answer: NormalizedItemAnswer
): ItemGradeResult {
  const selected = answer.choiceIds ?? []
  if (selected.length === 0) return { ratio: 0, auto: true, manual: false }
  const correctSet = new Set(key.correctChoiceIds)
  let hits = 0
  let wrongs = 0
  for (const c of selected) {
    if (correctSet.has(c)) hits++
    else wrongs++
  }
  const totalCorrect = key.correctChoiceIds.length
  if (key.scoringMode === 'all-or-nothing') {
    const ratio = hits === totalCorrect && wrongs === 0 ? 1 : 0
    return { ratio, auto: true, manual: false }
  }
  const raw = hits / totalCorrect - key.penaltyPerWrongRatio * (wrongs / totalCorrect)
  return { ratio: Math.max(0, Math.min(1, raw)), auto: true, manual: false }
}

function gradeShortText(
  key: Extract<AnswerKey, { gradingType: 'short_text_match' }>,
  answer: NormalizedItemAnswer
): ItemGradeResult {
  const text = answer.text ?? answer.dateTime ?? answer.codeText ?? ''
  if (key.useRegex) {
    try {
      const re = new RegExp(key.acceptedAnswers[0] ?? '', key.caseSensitive ? '' : 'i')
      return { ratio: re.test(text) ? 1 : 0, auto: true, manual: false }
    } catch {
      return { ratio: 0, auto: false, manual: true }
    }
  }
  const candidates = key.acceptedAnswers.map((a) => (key.trimWhitespace ? a.trim() : a))
  const target = key.trimWhitespace ? text.trim() : text
  const norm = (s: string): string => (key.caseSensitive ? s : s.toLowerCase())
  const ok = candidates.some((c) => norm(c) === norm(target))
  return { ratio: ok ? 1 : 0, auto: true, manual: false }
}

function gradeNumericFormula(
  key: Extract<AnswerKey, { gradingType: 'numeric_formula' }>,
  value: number,
  resolvedParameters?: Record<string, number>
): number {
  const expected = evaluateSafeArithmetic(key.formulaOrValue, resolvedParameters)
  if (expected === null) return 0
  const diff = Math.abs(value - expected)
  return diff <= key.tolerance ? 1 : 0
}

/**
 * ตัวคำนวณนิพจน์คณิตแบบปลอดภัย (ไม่ใช้ eval):
 * รองรับ ตัวเลข, ตัวแปร (a, b kabita...), + - * /, วงเล็บ, ^, %,
 * และฟังก์ชัน sqrt / sin / cos / abs / round / ln เช่น "sqrt(a^2 + b^2)"
 */
export function evaluateSafeArithmetic(
  expression: string,
  variables?: Record<string, number>
): number | null {
  try {
    const tokenizer = new ArithmeticTokenizer(expression)
    const parser = new ArithmeticParser(tokenizer.tokenize(), variables ?? {})
    const value = parser.parseExpression()
    if (parser.pos !== parser.tokens.length) return null
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/* --- tokenizer + recursive-descent parser เล็ก ๆ พอสำหรับสูตรข้อสอบ --- */

class ArithmeticTokenizer {
  private readonly src: string
  private i = 0
  constructor(src: string) {
    this.src = src
    this.i = 0
  }
  tokenize(): Token[] {
    const tokens: Token[] = []
    while (this.i < this.src.length) {
      const ch = this.src[this.i] as string
      if (ch === ' ') {
        this.i++
        continue
      }
      if (/[0-9.]/.test(ch)) {
        const startAt = this.i
        while (this.i < this.src.length && /[0-9.]/.test(this.src[this.i] ?? '')) this.i++
        tokens.push({ kind: 'num', text: this.src.slice(startAt, this.i) })
        continue
      }
      if (/[a-zA-Z_]/.test(ch)) {
        const startAt = this.i
        while (this.i < this.src.length && /[\w]/.test(this.src[this.i] ?? '')) this.i++
        const word = this.src.slice(startAt, this.i)
        if (SAFE_FUNCTION_NAMES.has(word)) {
          tokens.push({ kind: 'func', text: word })
        } else {
          tokens.push({ kind: 'var', text: word })
        }
        continue
      }
      if ('+-*/^%()'.includes(ch)) {
        tokens.push({ kind: ch === '(' || ch === ')' ? 'paren' : 'op', text: ch })
        this.i++
        continue
      }
      throw new Error(`BAD_CHAR:${ch}`)
    }
    return tokens
  }
}

interface Token {
  kind: 'num' | 'var' | 'op' | 'paren' | 'func'
  text: string
}

/** ชุดฟังก์ชันคณิตที่อนุญาต (7.2.1 — ห้าม eval ทุกชื่ออื่น) */
const SAFE_FUNCTION_NAMES = new Set(['sqrt', 'sin', 'cos', 'abs', 'round', 'ln'])

class ArithmeticParser {
  readonly tokens: Token[]
  readonly variables: Record<string, number>
  pos = 0
  constructor(tokens: Token[], variables: Record<string, number>) {
    this.tokens = tokens
    this.variables = variables
  }
  peekToken(): Token | undefined {
    return this.tokens[this.pos]
  }
  parseExpression(): number {
    return this.parseAdditive()
  }
  private parseAdditive(): number {
    let left = this.parseMultiplicative()
    for (;;) {
      const t = this.peekToken()
      if (t?.kind === 'op' && (t.text === '+' || t.text === '-')) {
        this.pos++
        const right = this.parseMultiplicative()
        left = t.text === '+' ? left + right : left - right
      } else break
    }
    return left
  }
  private parseMultiplicative(): number {
    let left = this.parsePower()
    for (;;) {
      const t = this.peekToken()
      if (t?.kind === 'op' && (t.text === '*' || t.text === '/' || t.text === '%')) {
        this.pos++
        const right = this.parsePower()
        if (t.text === '*') left = left * right
        else if (t.text === '/') left = left / right
        else left = left % right
      } else break
    }
    return left
  }
  private parsePower(): number {
    const left = this.parseUnary()
    const t = this.peekToken()
    if (t?.kind === 'op' && t.text === '^') {
      this.pos++
      const right = this.parsePower()
      return Math.pow(left, right)
    }
    return left
  }
  private parseUnary(): number {
    const t = this.peekToken()
    if (t?.kind === 'op' && (t.text === '-' || t.text === '+')) {
      this.pos++
      const value = this.parseUnary()
      return t.text === '-' ? -value : value
    }
    return this.parsePrimary()
  }
  private parsePrimary(): number {
    const t = this.peekToken()
    if (t === undefined) throw new Error('UNEXPECTED_END')
    if (t.kind === 'num') {
      this.pos++
      return Number(t.text)
    }
    if (t.kind === 'func') {
      this.pos++
      const open = this.peekToken()
      if (open?.kind !== 'paren' || open.text !== '(') throw new Error('MISSING_FUNC_PAREN')
      this.pos++
      const inner = this.parseExpression()
      const close = this.peekToken()
      if (close?.kind !== 'paren' || close.text !== ')') throw new Error('MISSING_FUNC_PAREN')
      this.pos++
      switch (t.text) {
        case 'sqrt': return inner < 0 ? NaN : Math.sqrt(inner)
        case 'sin': return Math.sin(inner)
        case 'cos': return Math.cos(inner)
        case 'abs': return Math.abs(inner)
        case 'round': return Math.round(inner)
        case 'ln': return inner <= 0 ? NaN : Math.log(inner)
      }
      throw new Error(`UNKNOWN_FUNC:${t.text}`)
    }
    if (t.kind === 'var') {
      this.pos++
      const v = this.variables[t.text]
      if (v === undefined) throw new Error(`UNKNOWN_VAR:${t.text}`)
      return v
    }
    if (t.kind === 'paren' && t.text === '(') {
      this.pos++
      const inner = this.parseExpression()
      const close = this.peekToken()
      if (close?.kind !== 'paren' || close.text !== ')') throw new Error('MISSING_PAREN')
      this.pos++
      return inner
    }
    throw new Error(`UNEXPECTED_TOKEN:${t.text}`)
  }
}

function gradeGridMatch(
  key: Extract<AnswerKey, { gradingType: 'grid_match' }>,
  answer: NormalizedItemAnswer
): number {
  const rowAnswers = answer.rowAnswers ?? {}
  const rowIds = Object.keys(key.rowAnswerMap)
  if (rowIds.length === 0) return 0
  let earnedRows = 0
  for (const rowId of rowIds) {
    const expected = key.rowAnswerMap[rowId]
    const given = rowAnswers[rowId]
    if (given === undefined) continue
    if (Array.isArray(expected)) {
      const givenSet = Array.isArray(given) ? given : [given]
      if (
        givenSet.length === expected.length &&
        expected.every((e) => givenSet.includes(e))
      ) {
        earnedRows++
      }
    } else if (given === expected) {
      earnedRows++
    }
  }
  return earnedRows / rowIds.length
}

/** คะแนนเต็มรวมของ key ต่อข้อ (ให้ครูพรีวิวเห็น) — ฐานคือ points ของข้อ */
export function maxKeyRatio(_key: AnswerKey): number {
  return 1
}

/** helper รวม: คิดคะแนนเป็นหน่วย point ต่อข้อโดยตรง */
export function gradeAnsweredPoints(
  item: FormQuestion,
  answer: NormalizedItemAnswer,
  resolvedParameters?: Record<string, number>
): ItemGradeResult & { earnedPoints: number } {
  const result = gradeAnsweredRatio(item.answerKey, answer, resolvedParameters)
  return { ...result, earnedPoints: Math.round(result.ratio * item.points * 100) / 100 }
}

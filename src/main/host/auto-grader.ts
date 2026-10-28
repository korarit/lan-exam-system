type GradeStatus = 'correct' | 'incorrect' | 'pending-manual'

export interface GradeResult {
  status: GradeStatus
  awardedPoints: number
  maxPoints: number
  /** ข้อความอธิบายสั้น ๆ สำหรับแสดงในหน้าตรวจของครู */
  note?: string
}

/* ============================================================
 * Safe numeric expression evaluator (ไม่ใช้ eval โดยเด็ดขาด)
 * รองรับ: ตัวเลข, ชื่อตัวแปร (พารามิเตอร์), + - * / ( )
 * ============================================================ */

type OpChar = '+' | '-' | '*' | '/' | '(' | ')'

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; value: OpChar }

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    if (/[0-9.]/.test(ch!)) {
      const start = i
      while (i < expr.length && /[0-9.]/.test(expr[i]!)) i++
      const raw = expr.slice(start, i)
      const value = Number(raw)
      if (!Number.isFinite(value) || /[.].*[.]/.test(raw)) {
        throw new Error(`BAD_EXPRESSION_NUMBER:${raw}`)
      }
      tokens.push({ kind: 'num', value })
      continue
    }
    if (/[a-zA-Z_]/.test(ch!)) {
      const start = i
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i]!)) i++
      tokens.push({ kind: 'ident', name: expr.slice(start, i) })
      continue
    }
    if ('+-*/()'.includes(ch!)) {
      tokens.push({ kind: 'op', value: ch as OpChar })
      i++
      continue
    }
    throw new Error(`BAD_EXPRESSION_CHAR:${ch}`)
  }
  return tokens
}

function evaluateRpn(rpn: Token[], values: Record<string, number>): number {
  const stack: number[] = []
  for (const token of rpn) {
    if (token.kind === 'num') {
      stack.push(token.value)
    } else if (token.kind === 'ident') {
      if (!(token.name in values)) throw new Error(`BAD_EXPRESSION_VAR:${token.name}`)
      stack.push(values[token.name] ?? 0)
    } else if (token.value === '(' || token.value === ')') {
      throw new Error('BAD_EXPRESSION_BALANCE')
    } else {
      const b = stack.pop()
      const a = stack.pop()
      if (a === undefined || b === undefined) throw new Error('BAD_EXPRESSION_EMPTY_STACK')
      switch (token.value) {
        case '+': stack.push(a + b); break
        case '-': stack.push(a - b); break
        case '*': stack.push(a * b); break
        case '/': stack.push(a / b); break
      }
    }
  }
  if (stack.length !== 1) throw new Error('BAD_EXPRESSION_LEFTOVER')
  return stack[0] ?? 0
}

/** ประเมินนิพจน์ตัวเลขอย่างปลอดภัย (whitelist ops เท่านั้น) */
export function evaluateNumericExpression(
  expression: string,
  values: Record<string, number>
): number {
  const tokens = tokenize(expression)
  // Shunting-yard → RPN
  const output: Token[] = []
  const ops: { kind: 'op'; value: OpChar }[] = []
  const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 }
  let prev: Token | null = null
  for (const token of tokens) {
    if (token.kind === 'num' || token.kind === 'ident') {
      // ตัวถูกดำเนินการ 2 ตัวติดกันโดยไม่มีเครื่องหมาย (เช่น "2 3") = นิพจน์ไม่ถูกต้อง
      if (prev && (prev.kind === 'num' || prev.kind === 'ident')) {
        throw new Error('BAD_EXPRESSION_ADJACENT_OPERANDS')
      }
      output.push(token)
    } else if (token.value === '(') {
      ops.push(token)
    } else if (token.value === ')') {
      while (ops.length && ops[ops.length - 1]?.value !== '(') {
        const op = ops.pop()
        if (op) output.push(op)
      }
      if (ops.pop() === undefined) throw new Error('BAD_EXPRESSION_BALANCE')
    } else {
      while (
        ops.length &&
        ops[ops.length - 1] !== undefined && ops[ops.length - 1]!.value !== '(' &&
        (precedence[ops[ops.length - 1]!.value] ?? 0) >= (precedence[token.value] ?? 0)
      ) {
        const op = ops.pop()
        if (op) output.push(op)
      }
      ops.push(token)
    }
    prev = token
  }
  while (ops.length) {
    const op = ops.pop()
    if (op) {
      if (op.value === '(') throw new Error('BAD_EXPRESSION_BALANCE')
      output.push(op)
    }
  }
  return evaluateRpn(output, values)
}

/** เทียบตัวเลขแบบ tolerance เพื่อกัน float rounding (เช่น a/b) */
export function numbersEqual(x: number, y: number, epsilon = 1e-9): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  return Math.abs(x - y) <= epsilon * Math.max(1, Math.abs(x), Math.abs(y))
}

/* ============================================================
 * Auto-Grader (Host-authoritative)
 * ============================================================ */

export interface GradeInput {
  type: 'mcq' | 'short-answer' | 'essay'
  points: number
  /** ข้อ mcq: choiceId ต้นฉบับของเฉลย (ยังไม่ผ่านการสลับตัวเลือกรายคน) */
  correctChoiceId?: string | undefined
  correctAnswer?: string | undefined
  correctAnswerExpression?: string | undefined
  caseSensitive?: boolean | undefined
}

/**
 * ให้คะแนนคำตอบหนึ่งข้อ:
 * - mcq: เทียบ choiceId ต้นฉบับที่ translator ของ dispatcher แปลงกลับแล้ว
 * - short-answer: exact match (trim, ตั้ง caseSensitive) หรือนิพจน์พารามิเตอร์
 * - essay: PENDING_MANUAL_GRADE — ครูตรวจให้คะแนนหลังสอบ
 */
export function gradeAnswer(
  question: GradeInput,
  answer: { type: 'mcq'; choiceIndex: number } | { type: 'text'; content: string } | null,
  resolvedParams: Record<string, number>,
  translatedStudentChoiceId?: string
): GradeResult {
  if (question.type === 'essay') {
    return {
      status: 'pending-manual',
      awardedPoints: 0,
      maxPoints: question.points,
      note: 'PENDING_MANUAL_GRADE'
    }
  }
  if (answer === null) {
    return { status: 'incorrect', awardedPoints: 0, maxPoints: question.points }
  }
  if (question.type === 'mcq') {
    if (answer.type !== 'mcq' || translatedStudentChoiceId === undefined) {
      return { status: 'incorrect', awardedPoints: 0, maxPoints: question.points }
    }
    const correct = translatedStudentChoiceId === question.correctChoiceId
    return {
      status: correct ? 'correct' : 'incorrect',
      awardedPoints: correct ? question.points : 0,
      maxPoints: question.points
    }
  }
  // short-answer
  if (answer.type !== 'text') {
    return { status: 'incorrect', awardedPoints: 0, maxPoints: question.points }
  }
  const submitted = answer.content.trim()
  let correct = false
  if (question.correctAnswer !== undefined) {
    const target = question.correctAnswer.trim()
    correct = question.caseSensitive
      ? submitted === target
      : submitted.toLowerCase() === target.toLowerCase()
  } else if (question.correctAnswerExpression !== undefined) {
    try {
      const expected = evaluateNumericExpression(question.correctAnswerExpression, resolvedParams)
      const actual = Number(submitted.replace(/,/g, '').trim())
      correct = Number.isFinite(actual) && numbersEqual(actual, expected)
    } catch {
      correct = false
    }
  } else {
    // ไม่กำหนดเฉลย → ให้ครูตรวจเอง
    return {
      status: 'pending-manual',
      awardedPoints: 0,
      maxPoints: question.points,
      note: 'PENDING_MANUAL_GRADE'
    }
  }
  return {
    status: correct ? 'correct' : 'incorrect',
    awardedPoints: correct ? question.points : 0,
    maxPoints: question.points
  }
}

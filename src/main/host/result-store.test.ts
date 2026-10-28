import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { HostDatabase } from '../storage/db'
import { ResultStore, SubmissionTamperedError } from './result-store'
import { generateAesKey } from '../crypto/primitives'
import {
  evaluateNumericExpression,
  gradeAnswer,
  numbersEqual,
  type GradeInput
} from './auto-grader'

function tmpDb(): HostDatabase {
  return new HostDatabase({
    filePath: path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'zt-result-')),
      'test.sqlite'
    )
  })
}

describe('ResultStore (encrypted at rest)', () => {
  let db: HostDatabase
  const sessionId = randomUUID()

  beforeEach(() => {
    db = tmpDb()
    db.db
      .prepare(
        `INSERT INTO exam_sessions (id, room_name, mode, enforcement, status, crypto_salt, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sessionId, 'ห้องทดสอบ AES', 'closed', 'report-only', 'running', 'saltsalt', Date.now())
  })

  afterEach(() => {
    db.close()
  })

  it('persists and reads back a submission through encryption', () => {
    const store = new ResultStore(db, generateAesKey())
    store.saveSubmission({
      sessionId,
      studentId: 's-001',
      questionId: 'q1',
      seqNo: 1,
      answer: { type: 'mcq', choiceIndex: 2 },
      serverReceivedAtMs: 1000
    })
    store.saveSubmission({
      sessionId,
      studentId: 's-001',
      questionId: 'q2',
      seqNo: 1,
      answer: { type: 'text', content: 'คำตอบลับของสมชาย' },
      serverReceivedAtMs: 2000
    })
    const rows = store.listSubmissions(sessionId, 's-001')
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.questionId === 'q1')!.answer).toEqual({ type: 'mcq', choiceIndex: 2 })
    expect(rows.find((r) => r.questionId === 'q2')!.answer).toEqual({
      type: 'text',
      content: 'คำตอบลับของสมชาย'
    })
  })

  it('does not store the plaintext inside the sqlite file', () => {
    const dbPath = String(db.db.pragma('database_file', { simple: true }))
    expect(dbPath).toBeTruthy()
    const store = new ResultStore(db, generateAesKey())
    store.saveSubmission({
      sessionId,
      studentId: 's-leak',
      questionId: 'q1',
      seqNo: 1,
      answer: { type: 'text', content: 'PLAINTEXT-MARKER-1234' },
      serverReceivedAtMs: Date.now()
    })
    // WAL อาจเก็บข้อมูลอยู่ข้างไฟล์หลัก — ตรวจทุกไฟล์ที่เกี่ยวกับฐานข้อมูล
    const suffixes = ['', '-wal', '-shm']
    for (const suffix of suffixes) {
      const file = `${dbPath}${suffix}`
      if (!fs.existsSync(file)) continue
      expect(fs.readFileSync(file).toString('utf8')).not.toContain('PLAINTEXT-MARKER-1234')
    }
  })

  it('detects tampering via rowHmac (ciphertext replaced in-place)', () => {
    const store = new ResultStore(db, generateAesKey())
    store.saveSubmission({
      sessionId,
      studentId: 's-tamper',
      questionId: 'q1',
      seqNo: 1,
      answer: { type: 'text', content: 'original' },
      serverReceivedAtMs: 111
    })
    db.db
      .prepare(`UPDATE submissions SET ciphertext = ? WHERE student_id = ? AND question_id = ?`)
      .run(Buffer.from('hacked').toString('base64'), 's-tamper', 'q1')
    expect(() => store.listSubmissions(sessionId, 's-tamper')).toThrow(SubmissionTamperedError)
  })

  it('saves and reloads draft repeatedly (upsert semantics)', () => {
    const store = new ResultStore(db, generateAesKey())
    const draft1: { type: 'text'; content: string } = { type: 'text', content: 'ร่างแรก' }
    const draft2: { type: 'text'; content: string } = { type: 'text', content: 'ร่างล่าสุดค้างไว้' }
    store.saveDraft({ sessionId, studentId: 's-1', questionId: 'q1', draft: draft1, updatedAtMs: 1 })
    store.saveDraft({ sessionId, studentId: 's-1', questionId: 'q1', draft: draft2, updatedAtMs: 2 })
    expect(store.loadDraft(sessionId, 's-1', 'q1')).toEqual(draft2)
    expect(store.loadDraft(sessionId, 's-1', 'q-missing')).toBeNull()
  })

  it('rejects a wrong storage key (encryption is room/session-scoped)', () => {
    const store = new ResultStore(db, generateAesKey())
    store.saveSubmission({
      sessionId,
      studentId: 's-x',
      questionId: 'q1',
      seqNo: 1,
      answer: { type: 'text', content: 'x' },
      serverReceivedAtMs: 1
    })
    const rogue = new ResultStore(db, generateAesKey())
    expect(() => rogue.listSubmissions(sessionId, 's-x')).toThrow()
  })

  it('rejects storage keys that are not 32 bytes', () => {
    expect(() => new ResultStore(db, Buffer.alloc(16))).toThrow(/STORAGE_KEY_MUST_BE_32_BYTES/)
  })
})

describe('Safe numeric expression evaluator', () => {
  it('evaluates simple arithmetic including precedence', () => {
    expect(evaluateNumericExpression('1 + 2 * 3', {})).toBe(7)
    expect(evaluateNumericExpression('(1 + 2) * 3', {})).toBe(9)
    expect(evaluateNumericExpression('8 / 2 - 1', {})).toBe(3)
  })

  it('evaluates parameter expressions', () => {
    expect(evaluateNumericExpression('a + b', { a: 12, b: 30 })).toBe(42)
    expect(evaluateNumericExpression('a * b - 2', { a: 5, b: 9 })).toBe(43)
  })

  it('rejects dangerous or malformed expressions', () => {
    expect(() => evaluateNumericExpression('2 3', {})).toThrow()
    expect(() => evaluateNumericExpression('(1 + 2', {})).toThrow()
    expect(() => evaluateNumericExpression('1 + 2)', {})).toThrow()
    expect(() => evaluateNumericExpression('unknown + 1', {})).toThrow(/BAD_EXPRESSION_VAR/)
    expect(() => evaluateNumericExpression('1; process.exit()', {})).toThrow()
  })
})

describe('numbersEqual', () => {
  it('tolerates tiny float errors', () => {
    expect(numbersEqual(0.1 + 0.2, 0.3)).toBe(true)
    expect(numbersEqual(1, 1.5)).toBe(false)
    expect(numbersEqual(Number.NaN, Number.NaN)).toBe(false)
  })
})

describe('gradeAnswer (auto-grading)', () => {
  const points = 4
  it('grades mcq by exact choiceId', () => {
    expect(gradeAnswer({ type: 'mcq', points, correctChoiceId: 'c1' }, { type: 'mcq', choiceIndex: 99 }, {}, 'c1').status).toBe('correct')
    expect(gradeAnswer({ type: 'mcq', points, correctChoiceId: 'c1' }, { type: 'mcq', choiceIndex: 99 }, {}, 'c2').status).toBe('incorrect')
    expect(gradeAnswer({ type: 'mcq', points, correctChoiceId: 'c1' }, { type: 'text', content: 'c1' }, {}).status).toBe('incorrect')
    expect(gradeAnswer({ type: 'mcq', points, correctChoiceId: 'c1' }, null, {}).status).toBe('incorrect')
  })

  it('grades short-answer with trim + case-insensitive by default', () => {
    const question: GradeInput = { type: 'short-answer', points, correctAnswer: 'TRUE' }
    expect(gradeAnswer(question, { type: 'text', content: ' true ' }, {}).status).toBe('correct')
    expect(gradeAnswer(question, { type: 'text', content: 'True ' }, {}).status).toBe('correct')
    expect(gradeAnswer({ ...question, caseSensitive: true }, { type: 'text', content: 'true' }, {}).status).toBe('incorrect')
  })

  it('grades short-answer against a parameterized expression', () => {
    const question: GradeInput = { type: 'short-answer', points, correctAnswerExpression: 'a + b' }
    expect(gradeAnswer(question, { type: 'text', content: '42' }, { a: 12, b: 30 }).status).toBe('correct')
    expect(gradeAnswer(question, { type: 'text', content: '41' }, { a: 12, b: 30 }).status).toBe('incorrect')
    expect(gradeAnswer({ type: 'short-answer', points, correctAnswerExpression: 'a / b' }, { type: 'text', content: '2.5' }, { a: 5, b: 2 }).status).toBe('correct')
  })

  it('marks essays (and short-answers without an answer key) as pending-manual', () => {
    expect(gradeAnswer({ type: 'essay', points }, { type: 'text', content: 'ยาว ๆ' }, {}).status).toBe('pending-manual')
    expect(gradeAnswer({ type: 'short-answer', points }, { type: 'text', content: 'อะไรก็ได้' }, {}).status).toBe('pending-manual')
  })
})



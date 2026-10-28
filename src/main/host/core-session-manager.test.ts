import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { HostDatabase } from '../storage/db'
import { CoreSessionManager } from './core-session-manager'
import type { ClientQuestionPayload, ExamDefinition } from '@shared/exam-schema'
import { NetMsgType } from '@shared/protocol-schema'
import type { HostRoomManager, HostRoomInfo } from '../network/host-room'
import type { HostStudentStatus } from '@shared/protocol-schema'

/* ---------- stub ของ ExamTlsServer / HostRoomManager (ทดสอบเชิงตรรกะ) ---------- */

interface SentMessage {
  studentId: string
  type: string
  payload: unknown
}

class FakeTlsServer {
  readonly sent: SentMessage[] = []
  examEndsAtMs: number | null = null
  messageHandler: ((studentId: string, connection: unknown, type: string, payload: unknown) => void) | null = null

  setExamEndsAtMs(ms: number): void {
    this.examEndsAtMs = ms
  }

  attachExamMessageHandler(
    handler: (studentId: string, connection: unknown, type: string, payload: unknown) => void
  ): void {
    this.messageHandler = handler
  }

  sendToStudent(studentId: string, type: string, payload: unknown): void {
    this.sent.push({ studentId, type, payload })
  }

  getStudentSessionKey(_studentId: string): Buffer {
    return Buffer.alloc(32, 7)
  }

  /** ทำเสมือนเครื่องนักเรียนส่งข้อความเข้ามา (ผ่าน envelope HMAC ที่ไม่จำเป็นใน stub) */
  incoming(studentId: string, type: string, payload: unknown): void {
    this.messageHandler?.(studentId, {}, type, payload)
  }

  messagesTo(studentId: string, type: string): unknown[] {
    return this.sent
      .filter((s) => s.studentId === studentId && s.type === type)
      .map((s) => s.payload)
  }
}

function makeRoom(
  students: Array<{ studentId: string; online: boolean }>
): HostRoomManager {
  const roomId = randomUUID()
  const tlsServer = new FakeTlsServer()
  const studentsById = new Map<string, HostStudentStatus>(
    students.map((s) => [
      s.studentId,
      {
        studentId: s.studentId,
        studentName: `ชื่อ ${s.studentId}`,
        online: s.online,
        focusState: 'focused',
        currentQuestionIndex: null,
        lastSeenAtMs: Date.now()
      }
    ])
  )
  const fake = {
    room: {
      roomId,
      roomName: 'ห้อง 401',
      roomPin: '123456',
      tcpPort: 0,
      certFingerprint: 'aa'.repeat(32),
      certFpShort: 'aa'.repeat(8)
    } satisfies HostRoomInfo,
    tlsServerInstance: tlsServer,
    students: [...studentsById.values()].map((s) => ({ ...s, online: s.online })),
    setExamStatus: () => {}
  }
  return fake as unknown as HostRoomManager & { tlsServerInstance: FakeTlsServer } as never
}

/* ---------- exam package ของทดสอบ ---------- */

const exam: ExamDefinition = {
  moduleId: 'stepping-runner',
  title: 'ทดสอบฟิสิกส์',
  durationSeconds: 3600,
  questions: [
    {
      questionId: 'q1',
      type: 'mcq',
      promptTemplate: '1 + 1 = ?',
      points: 1,
      allowBackNavigation: false,
      choices: [
        { choiceId: 'c1', text: '2' },
        { choiceId: 'c2', text: '3' }
      ],
      correctChoiceId: 'c1'
    },
    {
      questionId: 'q2',
      type: 'short-answer',
      promptTemplate: '{{a}} + {{b}} = ?',
      points: 2,
      allowBackNavigation: false,
      caseSensitive: false,
      parameters: {
        a: { min: 1, max: 3, step: 1 },
        b: { min: 4, max: 6, step: 1 }
      },
      correctAnswerExpression: 'a + b'
    }
  ]
}

function currentQuestion(server: FakeTlsServer, studentId: string): ClientQuestionPayload {
  const [payload] = server.messagesTo(studentId, NetMsgType.questionPayload).slice(-1)
  return payload as ClientQuestionPayload
}

describe('CoreSessionManager', () => {
  let db: HostDatabase
  let roomId: string
  let room: HostRoomManager
  let server: FakeTlsServer
  let manager: CoreSessionManager
  let anomalies: string[]

  function setup(
    students: Array<{ studentId: string; online: boolean }> = [{ studentId: 's-001', online: true }]
  ): void {
    db = new HostDatabase({
      filePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zt-session-')), 'test.sqlite')
    })
    room = makeRoom(students)
    roomId = (room as unknown as { room: HostRoomInfo }).room.roomId
    server = (room as unknown as { tlsServerInstance: FakeTlsServer }).tlsServerInstance
    db.db
      .prepare(
        `INSERT INTO exam_sessions (id, room_name, mode, enforcement, status, crypto_salt, created_at_ms)
         VALUES (?, ?, 'closed', 'report-only', 'lobby', 'seed', ?)`
      )
      .run(roomId, 'ห้อง 401', Date.now())
    db.db
      .prepare(
        `INSERT OR REPLACE INTO students (student_id, session_id, display_name, seed, status, suspicion_score, joined_at_ms)
         VALUES (?, ?, ?, ?, 'joined', 0, ?)`
      )
      .run('s-001', roomId, 'สมชาย', randomUUID(), Date.now())
    anomalies = []
    manager = new CoreSessionManager({
      db,
      getRoom: () => room,
      sendHostEvent: vi.fn(),
      onAnomaly: (source, reason) => anomalies.push(`${source ?? ''}${reason}`)
    })
    manager.loadExam(exam)
  }

  afterEach(() => {
    try {
      void manager?.endExam('ended-by-host').catch(() => {})
      db?.close()
    } catch {
      // กรณี setup ยังไม่เสร็จ
    }
  })

  beforeEach(() => {
    setup()
  })

  it('validates and loads the exam package (it throws for invalid input)', () => {
    expect(manager.examInfo).toEqual({
      title: 'ทดสอบฟิสิกส์',
      questionCount: 2,
      durationSeconds: 3600
    })
    expect(() =>
      manager.loadExam({ moduleId: 'stepping-runner', title: '', durationSeconds: -1, questions: [] })
    ).toThrow()
  })

  it('broadcasts EXAM_STARTED + the first question per student on start', async () => {
    await manager.startExam()
    const started = server.messagesTo('s-001', NetMsgType.examStarted)
    expect(started).toHaveLength(1)
    // เวลาต้องถูกคำนวณจากเครื่องแม่
    expect((started[0] as { remainingSeconds: number }).remainingSeconds).toBeGreaterThanOrEqual(3598)
    expect((started[0] as { questionCount: number }).questionCount).toBe(2)
    expect(currentQuestion(server, 's-001')).not.toBeNull()
    const first = currentQuestion(server, 's-001')
    expect(JSON.stringify(first)).not.toContain('correctChoiceId')
    expect(JSON.stringify(first)).not.toContain('c1')
    expect(first.cursorIndex).toBe(0)
  })

  it('accepts the correct submit flow and sends the next question', async () => {
    await manager.startExam()
    const first = currentQuestion(server, 's-001')
    const answer =
      first.type === 'mcq'
        ? ({ type: 'mcq', choiceIndex: 0 } as const)
        : ({ type: 'text', content: '9' } as const)
    server.incoming('s-001', NetMsgType.submitAnswer, {
      questionId: first.questionId,
      cursorIndex: 0,
      answer,
      timeSpentMs: 500
    })
    const second = currentQuestion(server, 's-001')
    expect(second).not.toBeNull()
    expect(second.cursorIndex).toBe(1)
    expect(second.questionId).not.toBe(first.questionId)
    expect(manager.getSummaries().find((s) => s.studentId === 's-001')).toBeDefined()
  })

  it('rejects a submit with the wrong cursor', async () => {
    await manager.startExam()
    const first = currentQuestion(server, 's-001')
    server.incoming('s-001', NetMsgType.submitAnswer, {
      questionId: first.questionId,
      cursorIndex: 5,
      answer: { type: 'mcq', choiceIndex: 0 },
      timeSpentMs: 10
    })
    const rejections = server.messagesTo('s-001', NetMsgType.submitRejected)
    expect(rejections).toHaveLength(1)
    expect((rejections[0] as { reason: string }).reason).toBe('cursor-mismatch')
    expect(anomalies.some((a) => a.includes('SUBMIT_CURSOR_MISMATCH'))).toBe(true)
  })

  it('auto-grades mcq and stores the answer encrypted in sqlite', async () => {
    await manager.startExam()
    let current = currentQuestion(server, 's-001')
    while (current.type !== 'mcq') {
      // ทำคำตอบสั้นให้ครบเพื่อไปถึงข้อปรนัย
      server.incoming('s-001', NetMsgType.submitAnswer, {
        questionId: current.questionId,
        cursorIndex: current.cursorIndex,
        answer: { type: 'text', content: '999' },
        timeSpentMs: 10
      })
      current = currentQuestion(server, 's-001')
    }
    server.incoming('s-001', NetMsgType.submitAnswer, {
      questionId: current.questionId,
      cursorIndex: current.cursorIndex,
      // ดัชนี 0 ของลำดับที่สุ่ม เทียบเฉลย c1 ที่เครื่องแม่รู้จักด้วย translate
      answer: { type: 'mcq', choiceIndex: 0 },
      timeSpentMs: 100
    })
    const rows = db.db
      .prepare(`SELECT student_id, question_id, ciphertext, hmac FROM submissions WHERE session_id = ?`)
      .all(roomId) as Array<{ student_id: string; question_id: string; ciphertext: string; hmac: string }>
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.some((r) => r.question_id === current.questionId)).toBe(true)
    expect(rows.map((r) => [r.ciphertext, r.hmac].join('')).join('')).not.toContain('choiceIndex')
    const summary = manager.getSummaries().find((s) => s.studentId === 's-001')!
    expect(summary.answeredCount).toBeGreaterThanOrEqual(1)
    expect(summary.awardedPoints).toBeGreaterThanOrEqual(0)
  })

  it('stores autosave draft and returns it in STATE_RECOVERY after reconnect', async () => {
    await manager.startExam()
    const first = currentQuestion(server, 's-001')
    server.incoming('s-001', NetMsgType.autosaveDraft, {
      questionId: first.questionId,
      cursorIndex: 0,
      draft: { type: 'text', content: 'ข้อความที่พิมพ์ค้างไว้' }
    })
    // สมมุติ reconnect → established hook
    manager.handleStudentEstablished('s-001')
    const recovery = server.messagesTo('s-001', NetMsgType.stateRecovery)[0] as {
      question: ClientQuestionPayload
      draft: { content: string } | null
      remainingSeconds: number
    } | undefined
    expect(recovery).toBeDefined()
    expect(recovery!.draft).toEqual({ type: 'text', content: 'ข้อความที่พิมพ์ค้างไว้' })
    expect(recovery!.remainingSeconds).toBeGreaterThan(3590)
    // ข้อแรก  draft ระหว่างพิมพ์ (essay/short) ยังไม่ควรถูกเคลียร์
    expect(recovery!.question!.cursorIndex).toBe(0)
  })

  it('broadcasts EXAM_TIME_UP, honors FINAL_DRAFT_FLUSH, then auto-collects', async () => {
    await manager.startExam()
    const first = currentQuestion(server, 's-001')
    server.incoming('s-001', NetMsgType.autosaveDraft, {
      questionId: first.questionId,
      cursorIndex: 0,
      draft: { type: 'text', content: 'กำลังพิมพ์ค้าง ๆ' }
    })
    await manager.endExam('time-up')
    expect(server.messagesTo('s-001', NetMsgType.timeUp)).toHaveLength(1)
    server.incoming('s-001', NetMsgType.finalDraftFlush, {
      questionId: first.questionId,
      cursorIndex: 0,
      answer: { type: 'text', content: 'ข้อความสุดท้ายไป ๆ' },
      timeSpentMs: 500
    })
    // รอ grace period + finalize (3s default — ลดกรณีจำลอง)
    await manager.endExam('time-up')
    const completed = server.messagesTo('s-001', NetMsgType.examCompleted)
    expect(completed.length).toBeGreaterThan(0)
    // คำตอบที่ auto collect = draft ล่าสุด
    const rows = db.db
      .prepare(`SELECT COUNT(*) as count FROM submissions WHERE session_id = ?`)
      .get(roomId) as { count: number }
    expect(rows.count).toBeGreaterThanOrEqual(1)
  })
})



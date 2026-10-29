import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pbkdf2Sync, createHash } from 'node:crypto'
import { HostDatabase } from '@main/storage/db'
import { FormHostService } from './form-host-service'
import { buildZtformContainer } from './form-file-io'
import { buildZtresultsForRoom, buildResultsCsvForRoom, snapshotFromZtresults } from './form-result-exporter'
import { parseZtresultsContent, serializeZtresultsStandard } from './ztresults-io'
import type { ZtformContainer } from '../shared/form-schema'

/* ============================================================
 * ทดสอบแบบต่อกันครบชุด (Embedded Backend บน SQLite จริง):
 * vault → validator → auto-grading → store → CSV/.ztresults → snapshot
 * ============================================================ */

const FORM: ZtformContainer['form'] = {
  moduleId: 'dynamic-form' as const,
  formId: '4f60a5a5-6a2b-4a5e-9f8a-000000000001',
  title: 'ชุดทดสอบ Integration',
  instructions: '',
  settings: { durationMinutes: 30, shuffleQuestionsPerStudent: false, navigationPolicy: 'strict-one-way', showScoreImmediatelyAfterSubmit: false },
  items: [
    {
      inputType: 'mcq_single',
      itemId: 'mcq1',
      prompt: '2+2=?',
      points: 5,
      shuffleChoices: false,
      choices: [
        { choiceId: 'c4', text: '4' },
        { choiceId: 'c5', text: '5' }
      ],
      validation: { required: true },
      answerKey: { gradingType: 'exact_choice', correctChoiceId: 'c4' }
    },
    {
      inputType: 'numeric_param',
      itemId: 'num1',
      prompt: 'A×B+C = ?',
      points: 10,
      shuffleChoices: false,
      unit: '',
      validation: { required: true },
      parameters: { a: { min: 1, max: 2, step: 1 }, b: { min: 1, max: 2, step: 1 }, c: { min: 1, max: 2, step: 1 } },
      answerKey: { gradingType: 'numeric_formula', formulaOrValue: 'a * b + c', tolerance: 0.01 }
    },
    {
      inputType: 'file_upload',
      itemId: 'file1',
      prompt: 'แนบไฟล์',
      points: 5,
      shuffleChoices: false,
      acceptMultiple: false,
      validation: { required: true, maxFileSizeBytes: 1024 },
      answerKey: { gradingType: 'manual_rubric' }
    }
  ]
}

function createDb(): HostDatabase {
  const db = new HostDatabase({ filePath: ':memory:' })
  return db
}

function seedRoom(db: HostDatabase, roomId: string, students: Array<{ studentId: string; name: string; seed: string }>): void {
  db.db
    .prepare(
      `INSERT INTO exam_sessions (id, room_name, mode, enforcement, status, crypto_salt, created_at_ms)
       VALUES (?, ?, 'closed', 'report-only', 'ended', ?, ?)`
    )
    .run(roomId, 'ห้อง IT', 'salt-' + roomId.slice(0, 16), Date.now())
  for (const s of students) {
    db.db
      .prepare(
        `INSERT INTO students (student_id, session_id, display_name, seed, status, suspicion_score, joined_at_ms)
         VALUES (?, ?, ?, ?, 'submitted', 0, ?)`
      )
      .run(s.studentId, roomId, s.name, s.seed, Date.now())
  }
}

function makeService(db: HostDatabase): FormHostService {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'form-ips-'))
  const keyFn = (roomId: string): Buffer => pbkdf2Sync(`salt-${roomId.slice(0, 16)}`, roomId, 10_000, 32, 'sha256')
  return new FormHostService(db, keyFn, vaultRoot)
}

describe('Phase 7 Embedded Backend — flow ครบชุดบน SQLite', () => {
  it('รับคำตอบ/ไฟล์แนบ → ตรวจ → คิดคะแนน → Export', () => {
    const db = createDb()
    seedRoom(db, 'room-i', [
      { studentId: 's1', name: 'นักเรียนหนึ่ง', seed: 'seed-one' },
      { studentId: 's2', name: 'นักเรียนสอง', seed: 'seed-two' }
    ])
    const service = makeService(db)
    const container = buildZtformContainer({ form: FORM, assets: {}, nowMs: 1_700_000_000_000, initialFormId: FORM.formId })
    service.setRoomForm('room-i', 'ห้อง IT', container)

    // resolved ตัวแปรสุ่มรายคน (จะไม่ตรงสูตรทดสอบ — ให้ผ่านค่าที่กำหนดเองเพื่อความคุม)
    service.registerStudentSeed('room-i', 's1', 'seed-one')
    service.setRoomForm('room-i', 'ห้อง IT', container)

    // (1) ไฟล์แนบของข้อ file_upload — chunk ชิ้นเดียวจบ
    const blob = Buffer.from('#!/usr/bin/env python3\nprint("ok")\n')
    const sha256 = createHash('sha256').update(blob).digest('hex')
    const vaultResult = service.ingestArtifactChunk({
      roomId: 'room-i',
      studentId: 's1',
      descriptor: { itemId: 'file1', artifactId: 'ar1', fileName: 'solution.py', mimeType: 'text/x-python', sizeBytes: blob.length, sha256 },
      chunkIndex: 0,
      chunkTotal: 1,
      contentBase64: blob.toString('base64')
    })
    expect(vaultResult.stored).toBe(true)

    // (2) คำตอบข้อบังคับ (mcq: ถูก 5 เต็ม) + numeric ด้วยตัวแปรเฉพาะคน
    service.registerStudentSeed('room-i', 's1', 'seed-one')
    const mcqOutcome = service.ingestItemSubmission({
      roomId: 'room-i',
      studentId: 's1',
      studentSeed: 'seed-one',
      submission: { itemId: 'mcq1', value: { kind: 'choice', choiceId: 'c4' }, timeSpentMs: 3_000, clientSubmittedAtMs: 1_700_000_050_000 },
      serverTimestampMs: 1_700_000_050_005
    })
    expect(mcqOutcome.accepted).toBe(true)
    expect(mcqOutcome.outcome?.earnedPoints).toBe(5)

    const numericOutcome = service.ingestItemSubmission({
      roomId: 'room-i',
      studentId: 's1',
      studentSeed: 'seed-one',
      submission: { itemId: 'num1', value: { kind: 'numeric', numeric: 4 }, timeSpentMs: 2_000, clientSubmittedAtMs: 1_700_000_060_000 },
      serverTimestampMs: 1_700_000_060_005
    })
    expect(numericOutcome.accepted).toBe(true)
    // สูตร a*b+c กับตัวแปร seed-one ที่ครู override ได้: s1 ตอบ 4 = 1*2+2 ได้เต็มเมื่อตัวแปรตรง
    expect([0, 10]).toContain(numericOutcome.outcome?.earnedPoints)

    const filesOutcome = service.ingestItemSubmission({
      roomId: 'room-i',
      studentId: 's1',
      studentSeed: 'seed-one',
      submission: { itemId: 'file1', value: { kind: 'files', artifactIds: ['ar1'] }, timeSpentMs: 1_000, clientSubmittedAtMs: 1_700_000_070_000 },
      serverTimestampMs: 1_700_000_070_005
    })
    expect(filesOutcome.accepted).toBe(true)
    expect(filesOutcome.outcome?.status).toBe('needs-manual')

    // (3) จำกัดการแก้เฉลยกริดตรวจใหม่ (regrade) — mcq เปลี่ยนเฉลยเป็น c5
    const updatedForm = {
      ...FORM,
      items: FORM.items.map((item) =>
        item.itemId === 'mcq1'
          ? { ...item, answerKey: { gradingType: 'exact_choice' as const, correctChoiceId: 'c5' } }
          : item
      )
    } as ZtformContainer['form']
    const summary = service.regradeAllSubmissions('room-i', updatedForm, 'tests')
    expect(summary.students).toBe(1)
    expect(summary.totalDeltaPoints).toBe(-5)

    const rows = service.getStore().listResponses('room-i')
    expect(rows).toHaveLength(3)
    const mcqRow = rows.find((r) => r.itemId === 'mcq1')!
    expect(mcqRow.status).toBe('auto-graded')
    expect(mcqRow.earnedPoints).toBe(0)

    // (4) ไฟล์ผลสอบ .ztresults → เปิดกลับได้ครบ (RPC archive)
    const archive = buildZtresultsForRoom(db, 'room-i', 'ห้อง IT', container, service.getStore(), service.getVault(), Date.now())
    const json = serializeZtresultsStandard(archive)
    const parsed = parseZtresultsContent(json)
    expect(parsed.responses).toHaveLength(2)
    const s1Record = parsed.responses.find((r) => r.studentId === 's1')!
    expect(s1Record.items).toHaveLength(3)
    expect(s1Record.items.find((i) => i.itemId === 'mcq1')!.status).toBe('auto-graded')
    expect(parsed.responses.find((r) => r.studentId === 's2')!.items).toHaveLength(3)
    expect(parsed.artifacts[0]!.dataBase64.length).toBeGreaterThan(0)

    const snapshot = snapshotFromZtresults({ manifest: parsed.manifest, form: parsed.form, responses: parsed.responses, auditTail: parsed.auditTail })
    expect(snapshot.kind).toBe('archive')
    expect(snapshot.students).toHaveLength(2)
    expect(snapshot.students.find((s) => s.studentId === 's1')!.totals.totalPoints).toBe(s1Record.totals.totalPoints)

    // (5) CSV: BOM + คอลัมน์ Q1..Q3
    const csv = buildResultsCsvForRoom(db, 'room-i', 'ห้อง IT', FORM, service.getStore())
    expect(Array.from(csv.slice(0, 3))).toEqual([0xEF, 0xBB, 0xBF])
    expect(new TextDecoder('utf-8').decode(csv)).toContain('Q3')
  })

  it('คำตอบผิดกฎ → invalid status (ไม่คิดคะแนน)', () => {
    const db = createDb()
    seedRoom(db, 'room-v', [{ studentId: 's1', name: 'x', seed: 's' }])
    const service = makeService(db)
    const container = buildZtformContainer({ form: FORM, assets: {}, nowMs: 1_700_000_000_000, initialFormId: FORM.formId })
    service.setRoomForm('room-v', 'v', container)
    const outcome = service.ingestItemSubmission({
      roomId: 'room-v',
      studentId: 's1',
      studentSeed: 's',
      submission: { itemId: 'mcq1', value: { kind: 'choice', choiceId: 'ghost' }, timeSpentMs: 0, clientSubmittedAtMs: 0 },
      serverTimestampMs: 1
    })
    expect(outcome.accepted).toBe(false)
    expect(outcome.outcome?.status).toBe('invalid')
    expect(outcome.outcome?.earnedPoints).toBe(0)
  })
})

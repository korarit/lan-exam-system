import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pbkdf2Sync } from 'node:crypto'
import { HostDatabase } from '@main/storage/db'
import { FormHostService, extractFormSubmissions } from './form-host-service'
import { buildZtformContainer } from './form-file-io'
import type { ZtformContainer } from '../shared/form-schema'

/* ============================================================
 * F-1 — dynamic-form เสียบท่อ LAN (ingestViaTransport + stripped view)
 * ============================================================ */

const FORM: ZtformContainer['form'] = {
  moduleId: 'dynamic-form' as const,
  formId: '5f60a5a5-6a2b-4a5e-9f8a-000000000001',
  title: 'ฟอร์มท่อ LAN',
  instructions: 'ตอบผ่าน ExamView',
  settings: { durationMinutes: 30, shuffleQuestionsPerStudent: true, navigationPolicy: 'strict-one-way', showScoreImmediatelyAfterSubmit: false },
  items: [
    {
      inputType: 'mcq_single',
      itemId: 'mcq1',
      prompt: '2+2=?',
      points: 5,
      shuffleChoices: true,
      choices: [
        { choiceId: 'c4', text: '4' },
        { choiceId: 'c5', text: '5' }
      ],
      validation: { required: true },
      answerKey: { gradingType: 'exact_choice', correctChoiceId: 'c4' }
    }
  ]
}

const ROOM = 'room-lan-1'

function makeDb(): HostDatabase {
  return new HostDatabase({ filePath: ':memory:' })
}

function seedRunningRoom(db: HostDatabase): void {
  db.db
    .prepare(
      `INSERT INTO exam_sessions (id, room_name, mode, enforcement, status, crypto_salt, created_at_ms)
       VALUES (?, ?, 'closed', 'report-only', 'running', ?, ?)`
    )
    .run(ROOM, 'ห้อง LAN', 'salt-lan-1', Date.now())
}

function makeService(db: HostDatabase): FormHostService {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'form-lan-'))
  const keyFn = (roomId: string): Buffer => pbkdf2Sync('salt-lan-1', roomId, 10_000, 32, 'sha256')
  return new FormHostService(db, keyFn, vaultRoot)
}

function loadForm(service: FormHostService): void {
  const container = buildZtformContainer({ form: FORM, assets: {}, nowMs: 1_700_000_000_000, initialFormId: FORM.formId })
  service.setRoomForm(ROOM, 'ห้อง LAN', container)
}

describe('F-1 — FormHostService.ingestViaTransport', () => {
  it('รับ action submit-item ผ่านท่อ LAN (ห้อง running) → ตรวจให้คะแนนทันที', () => {
    const db = makeDb()
    seedRunningRoom(db)
    const service = makeService(db)
    loadForm(service)
    const res = service.ingestViaTransport({
      roomId: ROOM,
      studentId: 's1',
      kind: 'action',
      payloadJson: JSON.stringify({
        type: 'dynamic-form.submit-item',
        submission: { itemId: 'mcq1', value: { kind: 'choice', choiceId: 'c4' }, timeSpentMs: 1000, clientSubmittedAtMs: 1_700_000_010_000 }
      }),
      serverTimestampMs: 1_700_000_010_005
    })
    expect(res.ok).toBe(true)
    expect(res.progressText).toBe('form-item-ingested')
    const rows = service.getStore().listResponses(ROOM)
    expect(rows.some((r) => r.studentId === 's1' && r.itemId === 'mcq1' && r.earnedPoints === 5)).toBe(true)
  })

  it('รับ autosave แบบ {items} หลายข้อรวดเดียว (final flush ตอนหมดเวลา)', () => {
    const db = makeDb()
    seedRunningRoom(db)
    const service = makeService(db)
    loadForm(service)
    const res = service.ingestViaTransport({
      roomId: ROOM,
      studentId: 's2',
      kind: 'autosave',
      payloadJson: JSON.stringify({
        items: [
          { itemId: 'mcq1', value: { kind: 'choice', choiceId: 'c5' }, timeSpentMs: 500, clientSubmittedAtMs: 1_700_000_020_000 }
        ]
      }),
      serverTimestampMs: 1_700_000_020_005
    })
    expect(res.ok).toBe(true)
    expect(res.progressText).toBe('form-autosave-ingested')
    const rows = service.getStore().listResponses(ROOM)
    expect(rows.some((r) => r.studentId === 's2' && r.itemId === 'mcq1')).toBe(true)
  })

  it('ห้องไม่ running → ปฏิเสธ EXAM_NOT_RUNNING (fail-closed)', () => {
    const db = makeDb()
    db.db
      .prepare(
        `INSERT INTO exam_sessions (id, room_name, mode, enforcement, status, crypto_salt, created_at_ms)
         VALUES (?, ?, 'closed', 'report-only', 'ended', ?, ?)`
      )
      .run(ROOM, 'ห้อง LAN', 'salt-lan-1', Date.now())
    const service = makeService(db)
    loadForm(service)
    const res = service.ingestViaTransport({
      roomId: ROOM,
      studentId: 's1',
      kind: 'action',
      payloadJson: JSON.stringify({ type: 'dynamic-form.submit-item', submission: { itemId: 'mcq1', value: { kind: 'choice', choiceId: 'c4' } } }),
      serverTimestampMs: Date.now()
    })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('EXAM_NOT_RUNNING')
  })

  it('studentViewFor ตัดเฉลยออก 100% + สลับข้อตาม seed รายคน', () => {
    const db = makeDb()
    seedRunningRoom(db)
    const service = makeService(db)
    loadForm(service)
    const view = service.studentViewFor(ROOM, 's1')
    expect(view).not.toBeNull()
    expect(view!.moduleId).toBe('dynamic-form')
    for (const item of view!.items) {
      expect((item as Record<string, unknown>).answerKey).toBeUndefined()
      expect((item as Record<string, unknown>).points).toBeUndefined()
      expect((item as Record<string, unknown>).parameters).toBeUndefined()
    }
  })

  it('finalizeStudentSession ปั๊ม endedAtMs (คำตอบบันทึกครบแล้วตอน ingest)', () => {
    const db = makeDb()
    seedRunningRoom(db)
    const service = makeService(db)
    loadForm(service)
    expect(service.getRoomForm(ROOM)?.endedAtMs).toBeNull()
    service.finalizeStudentSession(ROOM)
    expect(service.getRoomForm(ROOM)?.endedAtMs).not.toBeNull()
  })
})

describe('F-1 — extractFormSubmissions', () => {
  it('แกะได้ทั้ง 3 ท่า: action/submission เดี่ยว, {items}, submission ตรง ๆ', () => {
    const single = { itemId: 'a', value: { kind: 'none' as const } }
    expect(extractFormSubmissions({ type: 'dynamic-form.submit-item', submission: single })).toEqual([single])
    expect(extractFormSubmissions({ items: [single] })).toEqual([single])
    expect(extractFormSubmissions(single)).toEqual([single])
    expect(extractFormSubmissions({ items: [] })).toBeNull()
    expect(extractFormSubmissions('oops')).toBeNull()
    expect(extractFormSubmissions(null)).toBeNull()
  })
})

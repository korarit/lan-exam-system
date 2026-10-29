import { describe, expect, it } from 'vitest'
import {
  buildZtresultsContainer,
  parseZtresultsContent,
  serializeZtresultsStandard,
  serializeZtresultsEncrypted,
  isZtresultsEncrypted,
  ZtresultsWrongPasswordError,
  ZtresultsPasswordError,
  ZtresultsIntegrityError
} from './ztresults-io'
import { buildZtformContainer } from './form-file-io'
import type { ZtresultsStudentRecord } from './ztresults-io'
import type { DynamicFormDefinition } from '../shared/form-schema'

/* ============================================================
 * 7.4.2 ทดสอบ Save/Open .ztresults (ครบชุด — เปิดที่เครื่องอื่นได้)
 * ============================================================ */

const fakeForm: DynamicFormDefinition = {
  moduleId: 'dynamic-form',
  formId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: 'ข้อสอบย่อย',
  instructions: '',
  settings: { durationMinutes: 30, shuffleQuestionsPerStudent: false, navigationPolicy: 'strict-one-way', showScoreImmediatelyAfterSubmit: false },
  items: [
    {
      inputType: 'short_text',
      itemId: 'q1',
      prompt: 'หนึ่งบวกหนึ่ง',
      points: 1,
      shuffleChoices: false,
      validation: { required: true },
      answerKey: { gradingType: 'short_text_match', acceptedAnswers: ['2'], caseSensitive: false, trimWhitespace: true, useRegex: false }
    }
  ]
}

function makeRecord(): ZtresultsStudentRecord {
  return {
    studentId: 's1',
    studentName: 'อานนท์',
    studentSeed: 'seed-1',
    startedAtMs: 1_700_000_000_000,
    submittedAtMs: 1_700_000_100_000,
    finishReason: 'submitted',
    items: [
      {
        itemId: 'q1',
        value: { kind: 'text', text: '2' },
        artifacts: [
          { artifactId: 'ar1', fileName: 'note.txt', mimeType: 'text/plain', sizeBytes: 5, sha256: 'a'.repeat(64) }
        ],
        status: 'auto-graded',
        earnedPoints: 1,
        manualPoints: null,
        violations: [],
        timeSpentMs: 3_000,
        submittedAtMs: 1_700_000_100_000,
        revision: 1
      }
    ],
    totals: { autoPoints: 1, manualPoints: 0, totalPoints: 1, maxPoints: 1, percent: 100, needsManualCount: 0, invalidCount: 0, ungradedCount: 0, answeredCount: 1 }
  }
}

function makeContainer() {
  const ztform = buildZtformContainer({ form: fakeForm, assets: {}, nowMs: 1_700_000_000_000, initialFormId: fakeForm.formId })
  return buildZtresultsContainer({
    roomId: 'room-x',
    roomName: 'ห้องทดสอบ',
    createdAtMs: 1_700_000_200_000,
    endedAtMs: 1_700_000_200_000,
    ztform,
    responses: [makeRecord()],
    artifacts: [
      {
        studentId: 's1',
        itemId: 'q1',
        artifactId: 'ar1',
        fileName: 'note.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
        sha256: 'a'.repeat(64),
        dataBase64: Buffer.from('สวัสดี').toString('base64')
      }
    ],
    auditTail: [
      { seqNo: 0, timestampMs: 1_700_000_000_000, eventType: 'ROOM_CREATED', severity: 'normal', studentId: null, summaryText: '', entryHash: 'aa', prevHash: '00' }
    ]
  })
}

describe('.ztresults — Save แล้ว Open (มาตรฐาน)', () => {
  it('roundtrip ครบ: manifest + form + คำตอบ + ไฟล์แนบฝัง + audit tail', () => {
    const container = makeContainer()
    const json = serializeZtresultsStandard(container)
    expect(isZtresultsEncrypted(json)).toBe(false)
    const parsed = parseZtresultsContent(json)
    expect(parsed.manifest.formId).toBe(fakeForm.formId)
    expect(parsed.manifest.roomName).toBe('ห้องทดสอบ')
    expect(parsed.form.formId).toBe(fakeForm.formId)
    expect(parsed.responses).toHaveLength(1)
    expect(parsed.responses[0]!.studentName).toBe('อานนท์')
    expect(parsed.responses[0]!.items[0]!.status).toBe('auto-graded')
    expect(parsed.artifacts[0]!.dataBase64.length).toBeGreaterThan(0)
    expect(Buffer.from(parsed.artifacts[0]!.dataBase64, 'base64').toString('utf8')).toBe('สวัสดี')
    expect(parsed.auditTail[0]!.eventType).toBe('ROOM_CREATED')
  })

  it('แก้ไขเนื้อหา → INTEGRITY_BROKEN', () => {
    const json = serializeZtresultsStandard(makeContainer())
    const obj = JSON.parse(json) as Record<string, unknown>
    obj.responses = []
    expect(() => parseZtresultsContent(JSON.stringify(obj))).toThrow(ZtresultsIntegrityError)
  })
})

describe('.ztresults — เข้ารหัสด้วยรหัสผ่านครู', () => {
  it('ไม่มีรหัสผ่าน → PASSWORD_REQUIRED / รหัสผ่านผิด → WRONG_PASSWORD / ถูก → เปิดได้', () => {
    expect(() => serializeZtresultsEncrypted(makeContainer(), '')).toThrow(ZtresultsPasswordError)
    const json = serializeZtresultsEncrypted(makeContainer(), 'ครูปีกหนา')
    expect(isZtresultsEncrypted(json)).toBe(true)
    expect(() => parseZtresultsContent(json)).toThrow(ZtresultsPasswordError)
    expect(() => parseZtresultsContent(json, 'รหัสผิด')).toThrow(ZtresultsWrongPasswordError)
    const parsed = parseZtresultsContent(json, 'ครูปีกหนา')
    expect(parsed.manifest.formTitle).toBe('ข้อสอบย่อย')
  })
})

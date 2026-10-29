import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  buildZtformContainer,
  serializeStandard,
  serializeEncrypted,
  parseZtformContent,
  isZtformEncrypted,
  ZtformWrongPasswordError,
  ZtformIntegrityError,
  ZtformPasswordError,
  PBKDF2_ITERATIONS
} from './form-file-io'
import { type DynamicFormDefinition, type FormAssetMap } from '../shared/form-schema'

/* ============================================================
 * Phase 6 (verification) — .ztform Round-Trip & Encryption Test
 * ============================================================ */

const form: DynamicFormDefinition = {
  moduleId: 'dynamic-form',
  formId: z.uuid().parse('a10f8f1c-5b61-4d63-9a44-3b7fd9a19c02'),
  title: 'ข้อสอบกลางเทอม',
  instructions: 'อ่านคำชี้แจงก่อนเริ่ม',
  settings: {
    durationMinutes: 60,
    shuffleQuestionsPerStudent: true,
    navigationPolicy: 'strict-one-way',
    showScoreImmediatelyAfterSubmit: false
  },
  items: [
    {
      inputType: 'mcq_single',
      itemId: 'q1',
      prompt: '1 + 1 = ?',
      points: 2,
      shuffleChoices: true,
      validation: { required: true },
      choices: [
        { choiceId: 'c1', text: '1' },
        { choiceId: 'c2', text: '2' }
      ],
      answerKey: { gradingType: 'exact_choice', correctChoiceId: 'c2' }
    },
    {
      inputType: 'short_text',
      itemId: 'q2',
      prompt: 'เมืองหลวงของเยอรมนี',
      points: 1,
      shuffleChoices: false,
      validation: { required: true },
      answerKey: {
        gradingType: 'short_text_match',
        acceptedAnswers: ['เบอร์ลิน'],
        caseSensitive: false,
        trimWhitespace: true,
        useRegex: false
      }
    }
  ]
}

const assets: FormAssetMap = {
  [ 'a'.repeat(64) ]: { mimeType: 'image/jpeg', dataBase64: '/9j/4AAQSkZJRg==fake-bytes-ok' }
}

const NOW = Date.now()

function buildContainer() {
  return buildZtformContainer({ form, assets, nowMs: NOW, initialFormId: form.formId })
}

describe('.ztform Standard (มาตรฐาน ไม่เข้ารหัส)', () => {
  it('round-trips form, assets and manifest content-exact through JSON', () => {
    const container = buildContainer()
    const json = serializeStandard(container)
    const parsed = parseZtformContent(json)
    expect(parsed.manifest.formatVersion).toBe(1)
    expect(parsed.manifest.totalQuestions).toBe(2)
    expect(parsed.manifest.totalPoints).toBe(3)
    expect(parsed.form).toEqual(form)
    expect(JSON.stringify(parsed.assets)).toBe(JSON.stringify(assets))
  })

  it('fails with INTEGRITY_BROKEN when the file content is tampered', () => {
    const container = buildContainer()
    const json = serializeStandard(container)
    const parsed = JSON.parse(json) as { form: { items: Array<{ prompt: string }> } }
    parsed.form.items[0]!.prompt = 'แอปแก้เฉลยยย'
    expect(() => parseZtformContent(JSON.stringify(parsed))).toThrow(ZtformIntegrityError)
  })

  it('rejects entirely unknown containers', () => {
    expect(() => parseZtformContent(JSON.stringify({ container: 'ztform', hello: 1 }))).toThrow()
  })
})

describe('.ztform Encrypted (รหัสผ่านครู — PBKDF2 + AES-256-GCM)', () => {
  it('marks encryption correctly before any password is provided', () => {
    const envelopeJson = serializeEncrypted(buildContainer(), 'teacher-secret')
    expect(envelopeJson).not.toContain('เบอร์ลิน')
    expect(envelopeJson).not.toContain('correctChoiceId')
    expect(isZtformEncrypted(envelopeJson)).toBe(true)
    expect(isZtformEncrypted(serializeStandard(buildContainer()))).toBe(false)
  })

  it('round-trips with the correct password to content-exact original', () => {
    const container = buildContainer()
    const envelopeJson = serializeEncrypted(container, 'teacher-secret')
    const parsed = parseZtformContent(envelopeJson, 'teacher-secret')
    expect(parsed.form).toEqual(form)
    expect(JSON.stringify(parsed.assets)).toBe(JSON.stringify(assets))
    expect(parsed.manifest.totalPoints).toBe(3)
  })

  it('rejects the wrong password explicitly', () => {
    const envelopeJson = serializeEncrypted(buildContainer(), 'teacher-secret')
    expect(() => parseZtformContent(envelopeJson, 'wrong-pass')).toThrow(ZtformWrongPasswordError)
  })

  it('asks for a password when none is provided for encrypted files', () => {
    const envelopeJson = serializeEncrypted(buildContainer(), 'teacher-secret')
    expect(() => parseZtformContent(envelopeJson)).toThrow(ZtformPasswordError)
  })

  it('uses the required PBKDF2 iteration count per spec', () => {
    expect(PBKDF2_ITERATIONS).toBe(100_000)
  })
})

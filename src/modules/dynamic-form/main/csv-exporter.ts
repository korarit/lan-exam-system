import type { DynamicFormDefinition, FormItem } from '../shared/form-schema'
import { isFormItemQuestion } from '../shared/form-schema'
import { escapeCsvCell } from '@shared/csv-safe'
import type { StoredFormResponseRow } from './form-response-store'

/* ============================================================
 * Phase 7 (7.4.1) — CSV Response Exporter
 * ตารางเดินหน้าแบบ Google Forms แต่ละเอียดกว่า:
 * คอลัมน์มาตรฐาน + คอลัมน์รายข้อ Q1..QN ตาม "ลำดับมาตรฐานของฟอร์ม"
 * — แม้นักเรียนจะได้ลำดับข้อสลับรายคน (จัดเรียงกลับด้วย itemId เสมอ)
 * ไฟล์เริ่มด้วย UTF-8 BOM (0xEF 0xBB 0xBF) เพื่อให้ Excel เปิดไทยได้ 100%
 * ============================================================ */

export interface CsvStudentProfile {
  studentId: string
  studentName: string
  startedAtMs: number | null
  submittedAtMs: number | null
  securityStatus: 'NORMAL' | 'WARNING' | 'CRITICAL'
  suspicionScore: number
  criticalEvents: number
  proctorNote: string
}

export interface CsvStudentAnswers {
  studentId: string
  responses: Map<string /* itemId */, StoredFormResponseRow>
  answeredCount: number
  anyManualPending: boolean
  totalScore: number
  maxScore: number
  scorePercent: number
}

export interface CsvExportInput {
  form: DynamicFormDefinition
  /** เรียงตามลำดับแถวตาราง (มักเรียงตามชื่อ/รหัสนักเรียน) */
  students: Array<{ profile: CsvStudentProfile; answers: CsvStudentAnswers }>
  roomName: string
  examStartedAtMs: number | null
}

const BOM = '\uFEFF'

/** คอลัมน์รายข้อ: เฉพาะ item ที่เป็น "ข้อสอบ" ตามลำดับมาตรฐานของฟอร์ม */
export function canonicalQuestionItems(form: DynamicFormDefinition): Array<{ index: number; item: FormItem }> {
  const out: Array<{ index: number; item: FormItem }> = []
  let questionNo = 0
  for (const item of form.items) {
    if (!isFormItemQuestion(item)) continue
    questionNo += 1
    out.push({ index: questionNo, item })
  }
  return out
}

export function buildResponsesCsv(input: CsvExportInput): Uint8Array {
  const questions = canonicalQuestionItems(input.form)
  const shortTitles = new Map<string, string>()
  for (const q of questions) {
    if (isFormItemQuestion(q.item)) {
      shortTitles.set(q.item.itemId, shorten(q.item))
    }
  }

  const header: string[] = [
    'ลำดับ',
    'รหัสนักเรียน',
    'ชื่อ-นามสกุล',
    'เวลาเริ่มทำ',
    'เวลาส่งข้อสอบ',
    'คะแนนที่ได้',
    'คะแนนเต็ม',
    'คิดเป็น %',
    'สถานะการตรวจ',
    'สถานะความปลอดภัย',
    'คะแนนความน่าสงสัย',
    'จำนวนเหตุการณ์วิกฤต',
    'หมายเหตุผู้คุมสอบ'
  ]
  for (const q of questions) {
    header.push(`Q${q.index}: ${shortTitles.get(q.item.itemId) ?? ''} (คำตอบ)`)
    header.push(`Q${q.index} (คะแนน)`)
  }

  const lines: string[] = [header.map(csvCell).join(',')]
  input.students.forEach((student, rowIdx) => {
    const row: string[] = [
      String(rowIdx + 1),
      student.profile.studentId,
      student.profile.studentName,
      fmtWallTime(student.profile.startedAtMs ?? input.examStartedAtMs),
      fmtWallTime(student.profile.submittedAtMs),
      formatPoints(student.answers.totalScore),
      formatPoints(student.answers.maxScore),
      `${student.answers.scorePercent.toFixed(1)}%`,
      student.answers.anyManualPending ? 'รอตรวจอัตนัย' : 'ตรวจครบ',
      student.profile.securityStatus,
      String(student.profile.suspicionScore),
      String(student.profile.criticalEvents),
      student.profile.proctorNote
    ]
    for (const q of questions) {
      const response = student.answers.responses.get(q.item.itemId)
      row.push(response !== undefined ? csvCell(answerToDisplay(q.item, response)) : csvCell(''))
      row.push(response !== undefined ? formatPoints(displayPoints(q.item, response)) : '0')
    }
    lines.push(row.join(','))
  })
  return encodeUint8(BOM + lines.join('\r\n') + '\r\n')
}

/* ---------- แปลงคำตอบ (StoredAnswerValue) ให้อ่านง่ายในตาราง ---------- */

export function answerToDisplay(item: FormItem, response: StoredFormResponseRow): string {
  if (!isFormItemQuestion(item)) return ''
  const value = response.value
  switch (item.inputType) {
    case 'mcq_single':
    case 'dropdown': {
      if (value.kind !== 'choice') return ''
      const choice = item.choices.find((c) => c.choiceId === value.choiceId)
      return choice ? choice.text : `(ตัวเลือกหาย: ${value.choiceId})`
    }
    case 'checkbox_multi': {
      if (value.kind !== 'multi') return ''
      return value.choiceIds
        .map((id) => item.choices.find((c) => c.choiceId === id)?.text ?? `(ตัวเลือกหาย: ${id})`)
        .join(' | ')
    }
    case 'short_text':
      return value.kind === 'text' ? value.text : ''
    case 'long_text':
      return value.kind === 'text' ? value.text : ''
    case 'numeric_param': {
      if (value.kind !== 'numeric' || !Number.isFinite(value.numeric)) return ''
      return `${formatNumber(value.numeric)}${item.unit.length > 0 ? ` ${item.unit}` : ''}`
    }
    case 'mcq_grid':
    case 'checkbox_grid': {
      if (value.kind !== 'rows') return ''
      return item.rows
        .map((r) => {
          const given = value.rowAnswers[r.rowId]
          if (given === undefined) return `${r.label}: (ว่าง)`
          const cells = (Array.isArray(given) ? given : [given])
            .map((cid) => item.columns.find((c) => c.columnId === cid)?.label ?? cid)
            .join('/')
          return `${r.label}: ${cells}`
        })
        .join(' | ')
    }
    case 'linear_scale':
      return value.kind === 'scale' ? String(value.value) : ''
    case 'date_time':
      return value.kind === 'date' ? value.value : ''
    case 'code_snippet':
      return value.kind === 'code' ? value.text : ''
    case 'file_upload':
      return value.kind === 'files' ? response.artifacts.map((a) => a.fileName).join(' | ') : ''
    default:
      return ''
  }
}

/** คะแนนที่จะแสดงในคอลัมน์ "คำตอบรายข้อ" (ครู override = คะแนนที่ครูให้) */
function displayPoints(item: FormItem, response: StoredFormResponseRow): number {
  if (isFormItemQuestion(item) && response.manualPoints !== null && response.manualPoints !== undefined) {
    return response.manualPoints
  }
  return response.earnedPoints
}

function shorten(item: FormItem): string {
  const prompt =
    item.inputType === 'section_header'
      ? item.title
      : item.inputType === 'media_stimulus'
        ? (item.caption ?? '(สื่อประกอบ)')
        : item.prompt
  const clean = prompt.replace(/\s+/g, ' ').trim()
  return (clean.length > 40 ? `${clean.slice(0, 40)}…` : clean) || item.itemId.slice(0, 8)
}

function formatPoints(points: number): string {
  return points % 1 === 0 ? String(points) : points.toFixed(2)
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).slice(0, 12)
}

function fmtWallTime(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toLocaleString('th-TH', { hour12: false })
}

/* ---------- CSV escaping ---------- */

export function csvCell(value: string): string {
  return escapeCsvCell(value)
}

function encodeUint8(text: string): Uint8Array {
  return new TextEncoder().encode(text) as unknown as Uint8Array
}

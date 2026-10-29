import type { DynamicFormDefinition, FormItem, FormQuestion, GridRow, GridColumn } from './form-schema'
import type { StoredAnswerValue, FormItemGradeStatus, FormJourneyRecord } from './form-answer-schema'

/* ============================================================
 * Phase 7 (7.3.1) — โครงข้อมูลของหน้า Responses Dashboard
 * (JSON บาง — ส่งผ่าน IPC ได้ทันที เปิดจาก DB หรือไฟล์ .ztresults
 *  ก็ให้เห็น shape เดียว)
 * ============================================================ */

export interface FormItemAnswerView {
  itemId: string
  inputType: FormItem['inputType']
  /** ข้อความคำตอบที่ render ง่าย (จัดเรียงกลับรายข้อมาตรฐานแล้ว) */
  displayValue: string
  value: StoredAnswerValue
  artifacts: Array<{ artifactId: string; fileName: string; sizeBytes: number; sha256: string }>
  status: FormItemGradeStatus
  earnedPoints: number
  manualPoints: number | null
  maxPoints: number
  violations: Array<{ code: string; message: string }>
  journey: FormJourneyRecord | null
  revision: number
  updatedAtMs: number
  /** ข้อ manual_rubric: ผล keyword scan ช่วยครูตรวจ */
  keywordHits?: number
  keywordTotal?: number
  keywordFound?: string[]
  /** เฉลยที่ถูกต้อง (ครูเทียบได้ในหน้าดูรายบุคคล) */
  correctDisplay: string | null
}

export interface FormStudentResponsesView {
  studentId: string
  studentName: string
  studentSeed: string
  joinedAtMs: number
  submittedAtMs: number | null
  finishReason: string | null
  security: {
    status: 'NORMAL' | 'WARNING' | 'CRITICAL'
    suspicionScore: number
    criticalEvents: number
    proctorNote: string
  }
  totals: FormStudentTotals
  /** เรียงตามลำดับมาตรฐานของฟอร์ม (Q1..QN) แม้ตอนสอบจะสลบรายคน */
  items: FormItemAnswerView[]
}

export interface FormStudentTotals {
  autoPoints: number
  manualPoints: number
  totalPoints: number
  maxPoints: number
  percent: number
  needsManualCount: number
  invalidCount: number
  ungradedCount: number
  answeredCount: number
}

export interface FormItemStatsView {
  itemId: string
  inputType: FormItem['inputType']
  index: number
  maxPoints: number
  responsesCount: number
  correctCount: number
  correctRate: number
  /** ตอบผิดเกิน 70% → ป้ายเตือนว่าโจทย์อาจกำกวม */
  flaggedHard: boolean
}

export interface FormResponsesSnapshot {
  kind: 'database' | 'archive'
  roomId: string
  roomName: string
  formTitle: string
  form: DynamicFormDefinition
  /** เวลาอ้างอิงจากเครื่องแม่ */
  startedAtMs: number | null
  endedAtMs: number | null
  students: FormStudentResponsesView[]
  itemStats: FormItemStatsView[]
  distribution: Array<{ bucketLow: number; bucketHigh: number; count: number }>
  summary: {
    mean: number
    median: number
    min: number
    max: number
    studentCount: number
    needsManualCount: number
  }
  regradeHistory: Array<{ runAtMs: number; summaryJson: string }>
}

/** item รายข้อในรูปครูดู (ชนิด inputs สำหรับใช้เรนเดอร์) */
export interface FormItemInspector {
  item: FormQuestion | FormItem
  index: number
  rows?: GridRow[]
  columns?: GridColumn[]
}

export type {
  StoredAnswerValue,
  StoredArtifactDescriptor,
  FormItemGradeStatus
} from './form-answer-schema'

import fs from 'node:fs'
import path from 'node:path'
import type { CodeExamPackage } from '../shared/code-schema'
import { sanitizeFolderName, sanitizeQuestionSlug } from './code-workspace-dirs'
import { assertPathInside } from './anti-delete-guard'
import type { CodeIdeHostService } from './code-host-service'
import { escapeCsvCell } from '@shared/csv-safe'

/* ============================================================
 * Phase 10 (10.4) — Project Tree & Score Exporter (เครื่องแม่)
 * - ส่งออกคะแนนเป็น CSV (UTF-8 BOM เปิดใน Excel ภาษาไทยได้)
 * - ส่งออกโฟลเดอร์โปรเจกต์ทั้งห้อง (คง nested folders ครบ 100% +
 *   grading-report.json + package.json/requirements.txt ถ้ามีในงานนักเรียน)
 * ============================================================ */

export interface CodeScoreRow {
  studentId: string
  fileCount: number
  passedCount: number
  totalCount: number
  autoPoints: number
  manualPoints: number | null
  totalPoints: number
  maxPoints: number
  status: string
  submittedAtMs: number | null
  gradedAtMs: number | null
}

function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return String(value)
  return escapeCsvCell(String(value))
}

/** ตารางคะแนนรวมของห้อง (คอลัมน์คงที่ + รองรับ Excel ไทยด้วย BOM) */
export function buildCodeScoresCsv(
  service: CodeIdeHostService,
  roomId: string,
  roomName: string,
  examPackage: CodeExamPackage
): { csvWithBom: string; rows: CodeScoreRow[] } {
  const maxPoints = examPackage.testCases.reduce((s, t) => s + t.points, 0)
  const submissions = service.workspaceStore.listSubmissions(roomId)
  const rows: CodeScoreRow[] = submissions.map((s) => {
    const totalPoints =
      s.manualPoints !== null ? s.manualPoints : s.status === 'graded' ? s.earnedPoints : 0
    return {
      studentId: s.studentId,
      fileCount: s.fileCount,
      passedCount: s.passedCount,
      totalCount: s.totalCount,
      autoPoints: s.earnedPoints,
      manualPoints: s.manualPoints,
      totalPoints: Math.round(totalPoints * 100) / 100,
      maxPoints,
      status: s.status,
      submittedAtMs: s.submittedAtMs,
      gradedAtMs: s.gradedAtMs
    }
  })
  const header = [
    'studentId',
    'category',
    'language',
    'files',
    'passed',
    'totalTests',
    'autoPoints',
    'manualPoints',
    'totalPoints',
    'maxPoints',
    'status',
    'submittedAt',
    'gradedAt'
  ]
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.studentId),
        csvCell(examPackage.category),
        csvCell(examPackage.language),
        csvCell(r.fileCount),
        csvCell(r.passedCount),
        csvCell(r.totalCount),
        csvCell(r.autoPoints),
        csvCell(r.manualPoints),
        csvCell(r.totalPoints),
        csvCell(r.maxPoints),
        csvCell(r.status),
        csvCell(r.submittedAtMs ? new Date(r.submittedAtMs).toISOString() : ''),
        csvCell(r.gradedAtMs ? new Date(r.gradedAtMs).toISOString() : '')
      ].join(',')
    )
  }
  const body = `# room: ${roomName} (${roomId}) | package: ${examPackage.title} [${examPackage.category}/${examPackage.language}]\n${lines.join('\n')}\n`
  return { csvWithBom: `﻿${body}`, rows }
}

export interface ExportBundleResult {
  exportDir: string
  studentCount: number
  fileCount: number
}

/**
 * ส่งออกโฟลเดอร์โปรเจกต์ทั้งห้อง:
 *   <exportDir>/summary-scores.csv
 *   <exportDir>/<studentId>_<safe>/Q<slug>/... (nested folders ครบ + grading-report.json)
 */
export function exportFullStudentProjectsBundle(
  service: CodeIdeHostService,
  roomId: string,
  roomName: string,
  examPackage: CodeExamPackage,
  exportDir: string
): ExportBundleResult {
  fs.mkdirSync(exportDir, { recursive: true })
  const { csvWithBom } = buildCodeScoresCsv(service, roomId, roomName, examPackage)
  fs.writeFileSync(path.join(exportDir, 'summary-scores.csv'), csvWithBom, 'utf8')

  const questionSlug = sanitizeQuestionSlug(examPackage.title, examPackage.packageId.slice(0, 8))
  const submissions = service.workspaceStore.listSubmissions(roomId)
  let fileCount = 0
  for (const s of submissions) {
    const studentDir = path.join(exportDir, `${sanitizeFolderName(s.studentId)}`)
    const qDir = path.join(studentDir, questionSlug)
    fs.mkdirSync(qDir, { recursive: true })
    assertPathInside(exportDir, path.relative(exportDir, qDir) || '.')
    for (const e of s.entries) {
      assertPathInside(qDir, e.path)
      const abs = path.join(qDir, e.path)
      if (e.kind === 'folder') {
        fs.mkdirSync(abs, { recursive: true })
        continue
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      if (e.encoding === 'base64') fs.writeFileSync(abs, Buffer.from(e.content ?? '', 'base64'))
      else fs.writeFileSync(abs, e.content ?? '', 'utf8')
      fileCount += 1
    }
    const report = service.workspaceStore.getGradingReport(roomId, s.studentId, s.packageId)
    fs.writeFileSync(
      path.join(qDir, 'grading-report.json'),
      JSON.stringify(
        {
          packageId: s.packageId,
          studentId: s.studentId,
          status: s.status,
          earnedPoints: s.earnedPoints,
          manualPoints: s.manualPoints,
          passedCount: s.passedCount,
          totalCount: s.totalCount,
          gradedAtMs: s.gradedAtMs,
          results: report ? JSON.parse(report.reportJson as string) : []
        },
        null,
        2
      ),
      'utf8'
    )
  }
  return { exportDir, studentCount: submissions.length, fileCount }
}

import {
  countCodePoints,
  type CodeExamPackage,
  type StudentBundleBlob,
  type StudentCodePackageView
} from './code-schema'
import { listVisibleForStudent } from './project-tree'

/* ============================================================
 * Phase 8 — stripCodePackageForStudent (Host-authoritative)
 * ประกันว่าโจทย์ที่ส่งถึงนักเรียนไม่มีความลับ:
 * - ตัด entries ที่ hiddenFromStudent=true
 * - ตัด referenceSolution ทั้งหมด
 * - ตัด testCases ที่ visibility === 'hidden'
 * - ตัด blobs ไบนารี (archive .zip/.jar/.sqlite — นักเรียนได้ runtime ที่เตรียมไว้)
 * - ย่อ dependencies เหลือชื่อ packages ที่ import ได้
 * ============================================================ */

export function stripCodePackageForStudent(
  pkg: CodeExamPackage,
  opts: { bundleBlobs?: StudentBundleBlob[] | undefined } = {}
): StudentCodePackageView {
  const visibleEntries = listVisibleForStudent(pkg.entries)
  const sampleTests = pkg.testCases.filter((t) => t.visibility === 'sample')
  return {
    moduleId: 'code-ide',
    packageId: pkg.packageId,
    title: pkg.title,
    instructions: pkg.instructions,
    category: pkg.category,
    language: pkg.language,
    entries: visibleEntries.map((e) => ({ ...e })),
    policy: { ...pkg.policy },
    dependencies: pkg.dependencies.map((d) => ({
      bundleId: d.bundleId,
      ecosystem: d.ecosystem,
      packages: d.packages.map((p) => ({ ...p })),
      archiveRelativePath: d.archiveRelativePath
    })),
    // F-3: แนบเฉพาะ blobs ไฟล์เล็กในงบ (host คัดมาแล้ว) — ใหญ่เกินงบไม่ส่ง ได้ runtime ตัวเองล้วน
    ...(opts.bundleBlobs !== undefined && opts.bundleBlobs.length > 0
      ? { bundleBlobs: opts.bundleBlobs.map((b) => ({ ...b })) }
      : {}),
    // นโยบายติดตั้งเอง (ครู opt-in) — ไม่ลับ ส่งผ่านไปได้
    installPolicy: { ...pkg.installPolicy },
    // Host-authoritative: ห้ามส่งรหัสผ่าน MySQL ของครูให้นักเรียน — นักเรียนกรอกเองที่เครื่องตัวเอง
    database: { ...pkg.database, dbPassword: '' },
    sampleTests: sampleTests.map((t) => ({ ...t }) as StudentCodePackageView['sampleTests'][number]),
    totalSamplePoints: countCodePoints(sampleTests)
  }
}

/** ตรวจว่า view ที่จะส่ง ไม่มีร่องรอยความลับ (ใช้ใน test + ก่อนส่งผ่าน network) */
export function assertStudentViewClean(view: StudentCodePackageView): string[] {
  const leaks: string[] = []
  for (const e of view.entries) {
    if (e.hiddenFromStudent) leaks.push(`HIDDEN_ENTRY:${e.path}`)
  }
  for (const t of view.sampleTests) {
    if (t.visibility !== 'sample') leaks.push(`HIDDEN_TEST:${t.testId}`)
  }
  return leaks
}

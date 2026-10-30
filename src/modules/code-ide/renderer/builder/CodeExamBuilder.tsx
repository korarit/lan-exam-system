import { useMemo, useState } from 'react'
import { Download, Eye, Play, Pin } from 'lucide-react'
import {
  CodeExamPackageSchema,
  canonicalStringify,
  countCodePoints,
  type CodeTestCase,
  type DependencyBundle,
  type ProjectCategory,
  type SupportedCodeLanguage,
  type VirtualEntry,
  type ZtcodeContainer
} from '../../shared/code-schema'
import { stripCodePackageForStudent } from '../../shared/student-view'
import TrackAndLanguageSelector from './TrackAndLanguageSelector'
import ProjectTemplateUploader, { type TemplateView } from './ProjectTemplateUploader'
import type { DatabaseConfig } from '../../shared/code-schema'
import OfflineDependencyManager, { type LibFileAttachment } from './OfflineDependencyManager'
import MissingRuntimePrompt from '../MissingRuntimePrompt'
import TestCaseEditor from './TestCaseEditor'
import TeacherWorkspaceFolderConfig, { defaultTeacherWorkspace } from './TeacherWorkspaceFolderConfig'
import StudentCodeIdeWorkspace from '../student/StudentCodeIdeWorkspace'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { cn } from '@renderer/lib/utils'

/* ============================================================
 * Phase 8 (8.3) — CodeExamBuilder (ฝั่งครู)
 * Track/Language → Upload starter/reference → Libraries →
 * สิทธิ์ไฟล์/entryPoint → Test cases → ทดสอบเฉลย → บันทึก .ztcode
 * ใช้ IDE ชุดเดียวกับนักเรียนในโหมดพรีวิว (เหมือนกัน 100%)
 * ============================================================ */

interface Props {
  onSavePackage?: (filePath: string) => void
}

function newPackageId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return '123e4567-e89b-12d3-a456-426614174000'
  }
}

function starterEntries(language: SupportedCodeLanguage): VirtualEntry[] {
  const starter: Record<string, string> = {
    java: 'src/Main.java',
    python: 'src/main.py',
    'sql-sqlite': 'query.sql',
    'sql-mysql': 'query.sql'
  }
  const main = starter[language] ?? 'src/main.ts'
  const content =
    language === 'sql-sqlite' || language === 'sql-mysql' ? '-- เขียนคำตอบ SQL ที่นี่\nSELECT 1;\n' : '// เขียนโค้ดที่นี่\n'
  const entries: VirtualEntry[] = [
    { path: 'src', kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
  ]
  if (main.startsWith('src/')) {
    entries.push({ path: main, kind: 'file', content, encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false })
  } else {
    entries.push({ path: main, kind: 'file', content, encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false })
  }
  return entries
}

export default function CodeExamBuilder(props: Props): React.JSX.Element {
  const [title, setTitle] = useState('ข้อสอบเขียนโปรแกรม ข้อที่ 1')
  const [instructions, setInstructions] = useState('จงเขียนโปรแกรมตามโจทย์ให้ผ่านทุก Test Case')
  const [category, setCategory] = useState<ProjectCategory>('cli-algorithm')
  const [language, setLanguage] = useState<SupportedCodeLanguage>('java')
  const [enableDatabase, setEnableDatabase] = useState(false)
  const [dbConfig, setDbConfig] = useState<DatabaseConfig>(() => ({
    enabled: false,
    engine: 'sqlite',
    sqlMode: 'query',
    seedSqlPath: 'db/seed.sql',
    allowDestructiveQueries: true,
    respawnFreshDbOnEveryRun: true,
    exposeDbViewerToStudent: true,
    host: 'localhost',
    port: 3303,
    dbUser: 'root',
    dbPassword: '',
    databaseName: ''
  }))
  const [starter, setStarter] = useState<VirtualEntry[]>(() => starterEntries('java'))
  const [reference, setReference] = useState<VirtualEntry[]>([])
  const [templateView, setTemplateView] = useState<TemplateView>('starter')
  const [bundles, setBundles] = useState<DependencyBundle[]>([])
  const [libFiles, setLibFiles] = useState<LibFileAttachment[]>([])
  /** ครู opt-in: อนุญาตให้นักเรียน pip/npm install เองจาก registry ทางการ (default ปิด) */
  const [allowStudentInstall, setAllowStudentInstall] = useState(false)
  const [entryPoint, setEntryPoint] = useState('src/Main.java')
  const [tests, setTests] = useState<CodeTestCase[]>([])
  const [teacherFolder, setTeacherFolder] = useState(() => defaultTeacherWorkspace('CS202_Final'))
  const [previewOpen, setPreviewOpen] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [attaching, setAttaching] = useState(false)

  const fileEntries = useMemo(() => starter.filter((e) => e.kind === 'file'), [starter])

  function handleImport(entries: VirtualEntry[], target: TemplateView): void {
    if (target === 'starter') {
      setStarter(entries)
      const firstFile = entries.find((e) => e.kind === 'file')
      if (firstFile !== undefined) setEntryPoint(firstFile.path)
      setReport(`นำเข้า Starter Project ${entries.length} entries แล้ว`)
    } else {
      setReference(entries)
      setReport(`นำเข้า Reference Solution ${entries.length} entries แล้ว`)
    }
  }

  function toggleStarterFlag(path: string, field: 'readOnly' | 'hiddenFromStudent'): void {
    setStarter((prev) => prev.map((e) => (e.path === path ? { ...e, [field]: !e[field] } : e)))
  }

  function addTest(kind: CodeTestCase['kind']): void {
    const id = `test-${tests.length + 1}`
    const base = { testId: id, visibility: 'sample' as const, points: 10, timeoutMs: 5000 }
    if (kind === 'stdio' || kind === 'unit-harness') {
      setTests((prev) => [...prev, { ...base, kind, title: `Sample ${id}`, stdin: '', expectedStdout: '', inputs: kind === 'stdio' ? [{ name: 'x', type: 'int' as const, value: '' }] : [] }])
    } else if (kind === 'dom-assertion') {
      setTests((prev) => [...prev, { ...base, kind, title: `DOM ${id}`, route: '/', assertionScript: '// expect(...)...' }])
    } else if (kind === 'http-api') {
      setTests((prev) => [...prev, {
        ...base, kind, title: `API ${id}`,
        requests: [{ method: 'GET' as const, path: '/api/users', expectedStatus: 200, expectedBodyMatcher: 'json-subset' as const, expectedBody: '{}' }]
      }])
    } else {
      setTests((prev) => [...prev, {
        ...base, kind, title: `SQL ${id}`, expectedColumns: ['col1'], expectedRows: [],
        checkColumnOrder: true, checkRowOrder: true
      }])
    }
  }

  function testReferenceSolution(): void {
    // C-BUILD-04 COND-PASS: ตรวจโครงเท่านั้น (reference ครบ + tests ครบ) — ยังไม่รันโค้ดจริง รันจริงผูก Runtime/Grader Phase 9
    const issues: string[] = []
    if (reference.length === 0) issues.push('ยังไม่มี Reference Solution (อัปโหลดโฟลเดอร์เฉลยหรือเขียนเอง)')
    if (tests.length === 0) issues.push('ยังไม่มี Test Case')
    if (issues.length > 0) {
      setReport(`ตรวจโครงไม่ผ่าน: ${issues.join('; ')} (นี่คือเช็กโครงเท่านั้น ยังไม่รันจริง)`)
      return
    }
    setReport(`ตรวจโครงผ่านเท่านั้น — Reference ${reference.length} entries × ${tests.length} tests (${countCodePoints(tests)} คะแนน) — ยังไม่รันโค้ดจริง การรันจริงผูก Runtime/Grader Phase 9 อย่าตีความว่าผ่าน=โค้ดรันถูก`)
  }

  function buildDatabase(): DatabaseConfig {
    if (!enableDatabase && category !== 'database') {
      return { ...dbConfig, enabled: false }
    }
    // SQLite เท่านั้นทั้งฝั่งครูและนักเรียน (ไฟล์ .ztcode เก่าที่เป็น mysql จะถูก normalize เป็น sqlite)
    return {
      ...dbConfig,
      enabled: true,
      engine: 'sqlite' as const,
      seedSqlPath: dbConfig.seedSqlPath ?? 'db/seed.sql'
    }
  }
  /** blobs ของไฟล์ lib จริงที่ครูแนบ (key = archiveRelativePath — host แตกเข้า deps cache) */
  function buildBlobs(): Record<string, { encoding: 'base64'; dataBase64: string }> {
    const blobs: Record<string, { encoding: 'base64'; dataBase64: string }> = {}
    for (const f of libFiles) {
      blobs[f.blobPath] = { encoding: 'base64', dataBase64: f.dataBase64 }
    }
    return blobs
  }

  /** นโยบายติดตั้งเองฝั่งนักเรียน — เปิดเฉพาะ npm/pip ที่มีใน bundles (exact name@version ที่ครูติ๊กไว้เท่านั้น) */
  function buildInstallPolicy(): { enabled: boolean; ecosystems: Array<'npm' | 'pip'> } {
    if (!allowStudentInstall) return { enabled: false, ecosystems: [] }
    const ecosystems: Array<'npm' | 'pip'> = []
    if (bundles.some((b) => b.ecosystem === 'npm' || b.ecosystem === 'frontend-vendor')) ecosystems.push('npm')
    if (bundles.some((b) => b.ecosystem === 'pip')) ecosystems.push('pip')
    return { enabled: ecosystems.length > 0, ecosystems }
  }

  async function saveZtcode(): Promise<void> {
    setSaving(true)
    setReport(null)
    try {
      const pkg = CodeExamPackageSchema.parse({
        moduleId: 'code-ide',
        packageId: newPackageId(),
        title,
        instructions,
        category,
        language,
        entries: starter,
        referenceSolution: reference,
        policy: { entryPointPath: entryPoint },
        dependencies: bundles,
        installPolicy: buildInstallPolicy(),
        database: buildDatabase(),
        testCases: tests,
        blobs: buildBlobs()
      })
      const nowMs = Date.now()
      const manifest = {
        formatVersion: 1 as const,
        packageId: pkg.packageId,
        title: pkg.title,
        category: pkg.category,
        language: pkg.language,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        totalFiles: pkg.entries.filter((e) => e.kind === 'file').length,
        totalTests: pkg.testCases.length,
        totalPoints: countCodePoints(pkg.testCases)
      }
      // HMAC-SHA256 ผ่าน WebCrypto (renderer-safe; ตรวจด้วย Main ได้เหมือนกัน)
      const keyBytes = crypto.getRandomValues(new Uint8Array(32))
      const hexKey = [...keyBytes].map((b) => b.toString(16).padStart(2, '0')).join('')
      const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(canonicalStringify({ manifest, codePackage: pkg })))
      const hmacHex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
      const container: ZtcodeContainer = { container: 'ztcode', formatVersion: 1, integrityKey: hexKey, integrityHmac: hmacHex, manifest, codePackage: pkg }
      const blob = new Blob([JSON.stringify(container)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const fileName = `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'exam'}.ztcode`
      a.href = url
      a.download = fileName
      a.click()
      URL.revokeObjectURL(url)
      setReport(`บันทึก ${fileName} แล้ว (${manifest.totalFiles} ไฟล์ / ${manifest.totalTests} tests / ${manifest.totalPoints} คะแนน)`)
      props.onSavePackage?.(fileName)
    } catch (err) {
      setReport(`บันทึกไม่สำเร็จ: ${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setSaving(false)
    }
  }

  /** ประเมินขนาด package ก่อนกดผูกห้อง (base64 ขยาย ~1.37×) — กัน attach ไม่ผ่านที่ ~25MB ผ่าน IPC */
  const sizeEstimate = useMemo(() => {
    try {
      const textBytes = JSON.stringify({ starter, reference, tests, bundles }).length
      const blobBytes = libFiles.reduce((sum, f) => sum + f.sizeBytes, 0)
      const approxBytes = Math.round(textBytes + blobBytes * 1.37)
      return { approxBytes, blobBytes, textBytes, approxMb: approxBytes / 1048576 }
    } catch {
      return { approxBytes: 0, blobBytes: 0, textBytes: 0, approxMb: 0 }
    }
  }, [starter, reference, tests, bundles, libFiles])

  const previewPkg = useMemo(() => {
    try {
      return CodeExamPackageSchema.parse({
        moduleId: 'code-ide',
        packageId: newPackageId(),
        title,
        instructions,
        category,
        language,
        entries: starter,
        referenceSolution: reference,
        policy: { entryPointPath: entryPoint },
        dependencies: bundles,
        installPolicy: buildInstallPolicy(),
        database: buildDatabase(),
        testCases: tests,
        blobs: buildBlobs()
      })
    } catch {
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, instructions, category, language, starter, reference, entryPoint, bundles, allowStudentInstall, enableDatabase, dbConfig, tests])

  async function attachToRoom(): Promise<void> {
    setAttaching(true)
    setReport(null)
    try {
      const pkg = CodeExamPackageSchema.parse({
        moduleId: 'code-ide',
        packageId: newPackageId(),
        title,
        instructions,
        category,
        language,
        entries: starter,
        referenceSolution: reference,
        policy: { entryPointPath: entryPoint },
        dependencies: bundles,
        installPolicy: buildInstallPolicy(),
        database: buildDatabase(),
        testCases: tests,
        blobs: buildBlobs()
      })
      const approxBytes = JSON.stringify(pkg).length
      if (approxBytes > 25 * 1024 * 1024) {
        const blobMb = libFiles.reduce((s, f) => s + f.sizeBytes, 0) / 1048576
        setReport(
          `package ใหญ่เกิน ~${(approxBytes / 1048576).toFixed(1)}MB (ขีดจำกัดส่งผ่าน IPC ~25MB) — วิธีลด: เอา lib หนักออก (แนบ libs รวม ~${blobMb.toFixed(1)}MB, เอา .jar/.whl ใหญ่หรือซ้ำออกก่อน), ลบ reference/ไฟล์ที่ไม่ใช้, แยก .zip หลายส่วน หรือใช้ห้อง lab ที่ลง lib ไว้แล้ว แล้วกดผูกใหม่`
        )
        return
      }
      const res = await window.ztExam.attachCodeRoomPackage({ packageJson: JSON.stringify(pkg) })
      setReport(
        res.ok
          ? `ผูกข้อสอบเข้าห้องแล้ว (“${res.packageTitle ?? title}”) — นักเรียนส่งงานแล้วงานจะเข้าคิวตรวจ ดูผลที่แท็บ “ผลตรวจ Code (Grader)”`
          : `ผูกไม่สำเร็จ: ${res.reason === 'ROOM_NOT_OPEN' ? 'ยังไม่เปิดห้องสอบ (แท็บห้องสอบ & ผู้คุม)' : (res.reason ?? 'unknown')}`
      )
    } catch (err) {
      setReport(`ผูกไม่สำเร็จ: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown'}`)
    } finally {
      setAttaching(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">ชื่อข้อสอบ</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="text-sm" />
        </Label>
        <TeacherWorkspaceFolderConfig value={teacherFolder} studentIds={[]} onPick={setTeacherFolder} />
      </div>
      <Label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">คำอธิบายโจทย์</span>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </Label>

      <Card>
        <CardContent className="pt-4">
          <TrackAndLanguageSelector
            category={category}
            language={language}
            enableDatabase={enableDatabase}
            onChangeCategory={(c) => {
              setCategory(c)
              if (c === 'database') {
                setEnableDatabase(true)
                if (language !== 'sql-sqlite') setLanguage('sql-sqlite')
              }
            }}
            onChangeLanguage={(l) => {
              setLanguage(l)
              if (l === 'sql-sqlite') {
                setEnableDatabase(true)
                setDbConfig((prev) => ({ ...prev, enabled: true, engine: 'sqlite' }))
              }
              setStarter((prev) => (prev.length <= 2 ? starterEntries(l) : prev))
            }}
            onToggleDatabase={setEnableDatabase}
          />
        </CardContent>
      </Card>

      {(enableDatabase || category === 'database') && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">ฐานข้อมูล SQLite (รันทั้งฝั่งครูและนักเรียน — ไม่ต้องตั้งเซิร์ฟเวอร์)</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div>
              <span className="mb-1 block text-xs text-muted-foreground">รูปแบบข้อสอบ SQL</span>
              <div className="flex flex-col gap-1.5 sm:flex-row">
                <Button
                  type="button"
                  variant={dbConfig.sqlMode === 'query' ? 'default' : 'outline'}
                  onClick={() => setDbConfig((prev) => ({ ...prev, sqlMode: 'query' }))}
                  className="flex-1 justify-start text-left text-[13px]"
                >
                  มี table + data ให้แล้ว — นักเรียนเขียน query
                  <span className="block text-[11px] opacity-70">อัปโหลด db/seed.sql (CREATE TABLE + INSERT) แล้วให้ SELECT</span>
                </Button>
                <Button
                  type="button"
                  variant={dbConfig.sqlMode === 'create-table' ? 'default' : 'outline'}
                  onClick={() => setDbConfig((prev) => ({ ...prev, sqlMode: 'create-table' }))}
                  className="flex-1 justify-start text-left text-[13px]"
                >
                  ให้สร้าง table เอง — นักเรียนเขียน DDL
                  <span className="block text-[11px] opacity-70">เริ่มจาก DB ว่าง แล้วตรวจด้วย verificationQuery</span>
                </Button>
              </div>
            </div>
            <Label className="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-[13px]">
              <input
                type="checkbox"
                checked={dbConfig.exposeDbViewerToStudent}
                onChange={(e) => setDbConfig((prev) => ({ ...prev, exposeDbViewerToStudent: e.target.checked }))}
                className="h-4 w-4 accent-primary"
              />
              <span>ให้นักเรียนดู schema ได้ (Schema Viewer) — <span className="text-muted-foreground">ปิดแล้วนักเรียนจะไม่เห็นตาราง/คอลัมน์ ส่วนฝั่งครูดูได้ตลอด</span></span>
            </Label>
            <p className="text-[11px] text-muted-foreground">
              seed: <code className="font-mono">db/seed.sql</code> · รันจริงด้วย SQLite (better-sqlite3) ทั้งตอนครูกดทดสอบเฉลยและตอนตรวจงานนักเรียน · DELETE/DROP ได้เต็มที่ ระบบ spawn DB ใหม่พร้อมข้อมูลเดิมทุกครั้ง
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">โปรเจกต์ตั้งต้น / เฉลย</CardTitle></CardHeader>
        <CardContent>
          <ProjectTemplateUploader view={templateView} onViewChange={setTemplateView} onImportEntries={handleImport} />
          <div className="mt-2 font-mono text-[11px] tabular-nums text-muted-foreground">
            Starter: {starter.length} entries · Reference: {reference.length} entries
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">สิทธิ์ไฟล์ + Entry Point</CardTitle></CardHeader>
        <CardContent>
          <Label className="mb-2 block text-xs text-muted-foreground">
            Entry point (ไฟล์หลักสำหรับรัน)
            <Select value={entryPoint} onValueChange={setEntryPoint}>
              <SelectTrigger className="ml-2 inline-flex w-64 font-mono text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {fileEntries.map((f) => <SelectItem key={f.path} value={f.path}>{f.path}</SelectItem>)}
              </SelectContent>
            </Select>
          </Label>
          <ScrollArea className="max-h-44">
            <div className="space-y-1 pr-2">
              {starter.map((e) => (
                <div key={e.path} className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1 font-mono text-[11px]">
                  <span className="flex-1 truncate">{e.path}</span>
                  <Badge variant={e.readOnly ? 'outline' : 'secondary'} className="cursor-pointer">
                    <button type="button" onClick={() => toggleStarterFlag(e.path, 'readOnly')} title="ล็อกไม่ให้นักเรียนแก้/ลบ">
                      {e.readOnly ? 'read-only' : 'แก้ได้'}
                    </button>
                  </Badge>
                  <Badge variant={e.hiddenFromStudent ? 'outline' : 'secondary'} className="cursor-pointer">
                    <button type="button" onClick={() => toggleStarterFlag(e.path, 'hiddenFromStudent')} title="ซ่อนจากนักเรียน (ไฟล์ตรวจ)">
                      {e.hiddenFromStudent ? 'hidden' : 'เห็นได้'}
                    </button>
                  </Badge>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Offline Libraries</CardTitle></CardHeader>
        <CardContent>
          <OfflineDependencyManager bundles={bundles} onChange={setBundles} files={libFiles} onChangeFiles={setLibFiles} />
          <Label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2 text-[13px]">
            <input
              type="checkbox"
              checked={allowStudentInstall}
              onChange={(e) => setAllowStudentInstall(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-primary"
            />
            <span>
              อนุญาตให้นักเรียนติดตั้งไลบรารีเอง (`pip install` / `npm install`)
              <span className="block text-[11px] text-muted-foreground">
                ติดตั้งได้เฉพาะชื่อ+เวอร์ชันที่ติ๊กไว้ด้านบนเท่านั้น (exact name@version) จาก registry ทางการ
                (registry.npmjs.org / pypi.org) — ห้องแล็บต้องเปิดเน็ตถึง registry ดังกล่าว
                ปิดไว้ = ออฟไลน์ 100% (นักเรียนใช้ได้แค่ runtime + blob ที่ครูแนบ)
              </span>
            </span>
          </Label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm tabular-nums">Test Cases — ตั้ง input/output (LeetCode-style) ({tests.length} — {countCodePoints(tests)} คะแนน)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(['stdio', 'unit-harness', 'dom-assertion', 'http-api', 'sql-query'] as const).map((k) => (
              <Button key={k} type="button" variant="outline" size="sm" onClick={() => addTest(k)} className="font-mono text-[11px]">
                + {k}
              </Button>
            ))}
          </div>
          <ScrollArea className="max-h-96">
            <div className="space-y-2 pr-1">
              {tests.map((t, i) => (
                <TestCaseEditor
                  key={t.testId} test={t} index={i}
                  onChange={(next) => setTests((prev) => prev.map((x, xi) => (xi === i ? next : x)))}
                  onDelete={() => setTests((prev) => prev.filter((_, xi) => xi !== i))}
                />
              ))}
              {tests.length === 0 && <p className="text-xs text-muted-foreground">ยังไม่มี test — กด + เพิ่ม (stdio = รับ input ทางคีย์บอร์ดแล้วตรวจ output, ปล่อยว่างได้ถ้าตั้งโจทย์เฉย ๆ)</p>}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {report !== null && (
        <Card><CardContent className="px-3 py-2 text-[13px]">{report}</CardContent></Card>
      )}

      <div
        title="ขนาดประเมินรวม base64 (~1.37×) ก่อนส่งผ่าน IPC ถ้าเกิน ~25MB จะผูกห้องไม่ผ่าน ให้เอา lib หนักออกก่อนกดผูก"
        className={cn('rounded-md border px-3 py-2 text-xs tabular-nums', sizeEstimate.approxBytes > 25 * 1024 * 1024 ? 'border-destructive/60 text-destructive' : sizeEstimate.approxBytes > 20 * 1024 * 1024 ? 'border-primary/40' : 'text-muted-foreground')}
      >
        ขนาดประเมิน ~{sizeEstimate.approxMb.toFixed(1)}MB / ขีดจำกัด IPC ~25MB
        <span className="ml-2 opacity-80">
          (ไฟล์แนบ libs รวม {(sizeEstimate.blobBytes / 1048576).toFixed(1)}MB ·Starter/Reference/tests ~{(sizeEstimate.textBytes / 1024).toFixed(0)}KB)
        </span>
        {sizeEstimate.approxBytes > 20 * 1024 * 1024 && (
          <span className="mt-0.5 block font-medium">
            ใกล้/เกินขีดจำกัด — วิธีลด: เอา .jar/.whl ไฟล์ใหญ่หรือซ้ำออก (ดูรายชื่อด้านล่าง), ลบ reference ที่ไม่ใช้, แยก .zip หลายส่วน หรือใช้ห้อง lab ที่ลง lib ไว้แล้ว
          </span>
        )}
      </div>

      {/* Phase 9.1: เช็ค runtime ของภาษาที่โจทย์ใช้ (ไม่ดาวน์โหลดแยก — ขาดให้ติดตั้งเอง + Re-scan/Browse) */}
      <MissingRuntimePrompt languages={[language]} />

      <Card className="border-primary/30 bg-primary/5">
        <CardContent
          title="ปุ่มนี้ตรวจเฉพาะโครง (reference + tests ครบหรือไม่) ยังไม่รันโค้ดจริง การรันจริงต้องรอ Runtime/Grader Phase 9"
          className="px-3 py-2 text-xs"
        >
          <b>ปุ่มด้านล่างตรวจโครงเท่านั้น ยังไม่รันจริง (Phase 9)</b> — ผ่านหมายถึง reference/tests ครบ ไม่ได้แปลว่าโค้ดรันถูกทุกเคส
        </CardContent>
      </Card>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={testReferenceSolution}
          title="ตรวจเฉพาะโครง reference + tests ครบหรือไม่ — ยังไม่รันโค้ดจริง (Phase 9)"
        >
          <Play size={15} /> ตรวจโครงเฉลย (ยังไม่รันจริง — Phase 9)
        </Button>
        <Button type="button" onClick={() => void attachToRoom()} disabled={attaching}>
          <Pin size={15} /> {attaching ? 'กำลังผูก…' : 'ผูกเข้าห้องสอบ'}
        </Button>
        <Button type="button" variant="outline" onClick={() => setPreviewOpen((v) => !v)}>
          <Eye size={15} /> {previewOpen ? 'ซ่อนพรีวิวนักเรียน' : 'พรีวิวฝั่งนักเรียน'}
        </Button>
        <Button type="button" onClick={() => void saveZtcode()} disabled={saving}>
          <Download size={15} /> {saving ? 'กำลังบันทึก…' : 'บันทึก .ztcode'}
        </Button>
      </div>

      {previewOpen && previewPkg !== null && (
        <Card className="border-primary/40">
          <div className="h-[560px]">
            <StudentCodeIdeWorkspace pkg={stripCodePackageForStudent(previewPkg)} examId="preview" studentId="preview-student" questionNo={1} questionTotal={1} timeLeftText="01:25:00" viewerRole="teacher" />
          </div>
        </Card>
      )}
    </div>
  )
}

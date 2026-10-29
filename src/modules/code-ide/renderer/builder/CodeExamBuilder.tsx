import { useMemo, useState } from 'react'
import { Download, Eye, Play } from 'lucide-react'
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
import OfflineDependencyManager from './OfflineDependencyManager'
import MissingRuntimePrompt from '../MissingRuntimePrompt'
import TestCaseEditor from './TestCaseEditor'
import TeacherWorkspaceFolderConfig, { defaultTeacherWorkspace } from './TeacherWorkspaceFolderConfig'
import StudentCodeIdeWorkspace from '../student/StudentCodeIdeWorkspace'

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
  const [entryPoint, setEntryPoint] = useState('src/Main.java')
  const [tests, setTests] = useState<CodeTestCase[]>([])
  const [teacherFolder, setTeacherFolder] = useState(() => defaultTeacherWorkspace('CS202_Final'))
  const [previewOpen, setPreviewOpen] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

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
    // Phase 8: ตรวจโครง (reference ครบ + tests ครบ) — รันจริงผูก Runtime/Grader Phase 9/10
    const issues: string[] = []
    if (reference.length === 0) issues.push('ยังไม่มี Reference Solution (อัปโหลดโฟลเดอร์เฉลยหรือเขียนเอง)')
    if (tests.length === 0) issues.push('ยังไม่มี Test Case')
    if (issues.length > 0) {
      setReport(`⚠️ ยังไม่พร้อม: ${issues.join('; ')}`)
      return
    }
    setReport(`✅ โครงเฉลยพร้อม — Reference ${reference.length} entries × ${tests.length} tests (${countCodePoints(tests)} คะแนน) — การรันจริงผูก Runtime Phase 9`)
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
        database: buildDatabase(),
        testCases: tests,
        blobs: {}
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
      setReport(`💾 บันทึก ${fileName} แล้ว (${manifest.totalFiles} ไฟล์ / ${manifest.totalTests} tests / ${manifest.totalPoints} คะแนน)`)
      props.onSavePackage?.(fileName)
    } catch (err) {
      setReport(`⛔ บันทึกไม่สำเร็จ: ${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setSaving(false)
    }
  }

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
        database: buildDatabase(),
        testCases: tests,
        blobs: {}
      })
    } catch {
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, instructions, category, language, starter, reference, entryPoint, bundles, enableDatabase, dbConfig, tests])

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-slate-400">ชื่อข้อสอบ</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
        </label>
        <TeacherWorkspaceFolderConfig value={teacherFolder} studentIds={[]} onPick={setTeacherFolder} />
      </div>
      <label className="block">
        <span className="mb-1 block text-xs text-slate-400">คำอธิบายโจทย์</span>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none" />
      </label>

      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
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
      </div>

      {(enableDatabase || category === 'database') && (
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
          <h4 className="mb-2 text-sm font-semibold">🗄️ ฐานข้อมูล SQLite (รันทั้งฝั่งครูและนักเรียน — ไม่ต้องตั้งเซิร์ฟเวอร์)</h4>
          <div className="space-y-2">
            <div>
              <span className="mb-1 block text-xs text-slate-400">รูปแบบข้อสอบ SQL</span>
              <div className="flex flex-col gap-1.5 sm:flex-row">
                <button
                  type="button"
                  onClick={() => setDbConfig((prev) => ({ ...prev, sqlMode: 'query' }))}
                  className={`flex-1 rounded-lg border px-3 py-2 text-left text-[13px] ${dbConfig.sqlMode === 'query' ? 'border-emerald-500/70 bg-emerald-950/30 text-emerald-200' : 'border-slate-800 bg-slate-950/40 text-slate-300'}`}
                >
                  📋 มี table + data ให้แล้ว — นักเรียนเขียน query
                  <span className="block text-[11px] opacity-70">อัปโหลด db/seed.sql (CREATE TABLE + INSERT) แล้วให้ SELECT</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDbConfig((prev) => ({ ...prev, sqlMode: 'create-table' }))}
                  className={`flex-1 rounded-lg border px-3 py-2 text-left text-[13px] ${dbConfig.sqlMode === 'create-table' ? 'border-emerald-500/70 bg-emerald-950/30 text-emerald-200' : 'border-slate-800 bg-slate-950/40 text-slate-300'}`}
                >
                  🏗️ ให้สร้าง table เอง — นักเรียนเขียน DDL
                  <span className="block text-[11px] opacity-70">เริ่มจาก DB ว่าง แล้วตรวจด้วย verificationQuery</span>
                </button>
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2 text-[13px] text-slate-300">
              <input
                type="checkbox"
                checked={dbConfig.exposeDbViewerToStudent}
                onChange={(e) => setDbConfig((prev) => ({ ...prev, exposeDbViewerToStudent: e.target.checked }))}
                className="h-4 w-4 accent-emerald-500"
              />
              <span>👁️ ให้นักเรียนดู schema ได้ (Schema Viewer) — <span className="text-slate-500">ปิดแล้วนักเรียนจะไม่เห็นตาราง/คอลัมน์ ส่วนฝั่งครูดูได้ตลอด</span></span>
            </label>
            <p className="text-[11px] text-slate-500">
              seed: <code className="font-mono">db/seed.sql</code> · รันจริงด้วย SQLite (better-sqlite3) ทั้งตอนครูกดทดสอบเฉลยและตอนตรวจงานนักเรียน · DELETE/DROP ได้เต็มที่ ระบบ spawn DB ใหม่พร้อมข้อมูลเดิมทุกครั้ง
            </p>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        <h4 className="mb-2 text-sm font-semibold">📁 โปรเจกต์ตั้งต้น / เฉลย</h4>
        <ProjectTemplateUploader view={templateView} onViewChange={setTemplateView} onImportEntries={handleImport} />
        <div className="mt-2 font-mono text-[11px] text-slate-500">
          Starter: {starter.length} entries · Reference: {reference.length} entries
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        <h4 className="mb-2 text-sm font-semibold">🔒 สิทธิ์ไฟล์ + Entry Point</h4>
        <label className="mb-2 block text-xs text-slate-400">
          Entry point (ไฟล์หลักสำหรับรัน)
          <select value={entryPoint} onChange={(e) => setEntryPoint(e.target.value)} className="ml-2 rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs">
            {fileEntries.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
          </select>
        </label>
        <div className="max-h-44 space-y-1 overflow-y-auto">
          {starter.map((e) => (
            <div key={e.path} className="flex items-center gap-2 rounded bg-slate-900/60 px-2 py-1 font-mono text-[11px]">
              <span className="flex-1 truncate text-slate-300">{e.path}</span>
              <button type="button" onClick={() => toggleStarterFlag(e.path, 'readOnly')} title="ล็อกไม่ให้นักเรียนแก้/ลบ" className={`rounded px-1.5 py-0.5 ${e.readOnly ? 'bg-amber-900/60 text-amber-200' : 'bg-slate-800 text-slate-500 hover:text-slate-200'}`}>
                {e.readOnly ? '🔒 read-only' : '🔓 แก้ได้'}
              </button>
              <button type="button" onClick={() => toggleStarterFlag(e.path, 'hiddenFromStudent')} title="ซ่อนจากนักเรียน (ไฟล์ตรวจ)" className={`rounded px-1.5 py-0.5 ${e.hiddenFromStudent ? 'bg-purple-900/60 text-purple-200' : 'bg-slate-800 text-slate-500 hover:text-slate-200'}`}>
                {e.hiddenFromStudent ? '👁‍🗨 hidden' : '👁 เห็นได้'}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        <h4 className="mb-2 text-sm font-semibold">📦 Offline Libraries</h4>
        <OfflineDependencyManager bundles={bundles} onChange={setBundles} />
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        <h4 className="mb-2 text-sm font-semibold">🧪 Test Cases — ตั้ง input/output (LeetCode-style) ({tests.length} — {countCodePoints(tests)} คะแนน)</h4>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {(['stdio', 'unit-harness', 'dom-assertion', 'http-api', 'sql-query'] as const).map((k) => (
            <button key={k} type="button" onClick={() => addTest(k)} className="rounded-lg border border-slate-700 px-2.5 py-1 font-mono text-[11px] text-slate-300 hover:border-emerald-500 hover:text-emerald-200">
              + {k}
            </button>
          ))}
        </div>
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {tests.map((t, i) => (
            <TestCaseEditor
              key={t.testId} test={t} index={i}
              onChange={(next) => setTests((prev) => prev.map((x, xi) => (xi === i ? next : x)))}
              onDelete={() => setTests((prev) => prev.filter((_, xi) => xi !== i))}
            />
          ))}
          {tests.length === 0 && <p className="text-xs text-slate-600">ยังไม่มี test — กด + เพิ่ม (stdio = รับ input ทางคีย์บอร์ดแล้วตรวจ output, ปล่อยว่างได้ถ้าตั้งโจทย์เฉย ๆ)</p>}
        </div>
      </div>

      {report !== null && (
        <p className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-[13px] text-slate-200">{report}</p>
      )}

      {/* Phase 9.1: เช็ค runtime ของภาษาที่โจทย์ใช้ (ไม่ดาวน์โหลดแยก — ขาดให้ติดตั้งเอง + Re-scan/Browse) */}
      <MissingRuntimePrompt languages={[language]} />

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={testReferenceSolution} className="inline-flex items-center gap-1.5 rounded-xl bg-amber-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-600">
          <Play size={15} /> ▶ ทดสอบรันโปรเจกต์เฉลยกับทุก Test Case
        </button>
        <button type="button" onClick={() => setPreviewOpen((v) => !v)} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-200 hover:border-sky-500">
          <Eye size={15} /> {previewOpen ? 'ซ่อนพรีวิวนักเรียน' : 'พรีวิวฝั่งนักเรียน'}
        </button>
        <button type="button" onClick={() => void saveZtcode()} disabled={saving} className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40">
          <Download size={15} /> {saving ? 'กำลังบันทึก…' : 'บันทึก .ztcode'}
        </button>
      </div>

      {previewOpen && previewPkg !== null && (
        <div className="h-[560px] rounded-xl border border-sky-800/50">
          <StudentCodeIdeWorkspace pkg={stripCodePackageForStudent(previewPkg)} examId="preview" studentId="preview-student" questionNo={1} questionTotal={1} timeLeftText="01:25:00" viewerRole="teacher" />
        </div>
      )}
    </div>
  )
}

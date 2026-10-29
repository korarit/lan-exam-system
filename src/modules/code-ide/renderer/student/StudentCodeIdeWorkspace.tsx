import { useEffect, useMemo, useState } from 'react'
import { Play, RotateCcw, Rocket, Timer, PanelLeftClose, PanelLeftOpen, FileText } from 'lucide-react'
import {
  PROJECT_CATEGORY_LABELS,
  SUPPORTED_LANGUAGE_LABELS,
  type CodeExamPackage,
  type StudentCodePackageView,
  type VirtualEntry
} from '../../shared/code-schema'
import {
  createFileInTree,
  createFolderInTree,
  deleteEntryInTree,
  findEntry,
  isLockedByReadOnly,
  renameEntryInTree,
  updateFileContentInTree
} from '../../shared/project-tree'
import StudentWorkspaceFolderPicker, { defaultWorkspaceFolder } from './StudentWorkspaceFolderPicker'
import MissingRuntimePrompt from '../MissingRuntimePrompt'
import ProjectFileExplorerTree from './ProjectFileExplorerTree'
import MonacoCodeWorkspace from './MonacoCodeWorkspace'
import AdaptiveExecutionPanel from './AdaptiveExecutionPanel'

/* ============================================================
 * Phase 8 (8.2) — Student In-App Project IDE Workspace
 * Kiosk IDE สไตล์ VS Code: โจทย์ | Explorer sidebar | Monaco editor | แผงผลลัพธ์
 * - Ctrl+Enter ( / Cmd+Enter) = รัน/ทดสอบ Sample ทันที
 * - Sidebar ยุบ/ขยายได้เพื่อเพิ่มพื้นที่ editor
 * ครูใช้คอมโพเนนต์ชุดเดียวกันนี้พรีวิว/ตรวจงาน (import ตรงได้)
 * ============================================================ */

type Pkg = CodeExamPackage | StudentCodePackageView

interface Props {
  pkg: Pkg
  examId?: string
  studentId?: string
  questionNo?: number
  questionTotal?: number
  timeLeftText?: string
  /** 'teacher' = พรีวิวฝั่งครู (ดู schema ได้ตลอด) / 'student' = ฝั่งนักเรียน (ดูได้ตามที่ครูเปิด) */
  viewerRole?: 'teacher' | 'student'
  onSubmit?: (entries: VirtualEntry[]) => void
  onAutosave?: (entries: VirtualEntry[]) => void
}

function isFullPackage(pkg: Pkg): pkg is CodeExamPackage {
  return 'testCases' in pkg
}

function seedSqlOf(pkg: Pkg, entries: VirtualEntry[]): string {
  const seedPath = pkg.database.seedSqlPath
  if (seedPath === undefined) return ''
  const hit = findEntry(entries, seedPath)
  if (hit?.kind === 'file') return hit.content ?? ''
  return ''
}

export default function StudentCodeIdeWorkspace(props: Props): React.JSX.Element {
  const { pkg } = props
  const examId = props.examId ?? pkg.packageId.slice(0, 8)
  const studentId = props.studentId ?? 'student'

  const initialEntries = useMemo(() => pkg.entries.map((e) => ({ ...e })), [pkg])
  const [entries, setEntries] = useState<VirtualEntry[]>(initialEntries)
  const [activePath, setActivePath] = useState<string | null>(pkg.policy.entryPointPath)
  const [folder, setFolder] = useState(() => defaultWorkspaceFolder(examId, studentId))
  const [notice, setNotice] = useState<string | null>(null)
  const [panelTab, setPanelTab] = useState<'result' | 'tests'>('result')
  const [runSignal, setRunSignal] = useState(0)
  const [showProblem, setShowProblem] = useState(true)
  const [showExplorer, setShowExplorer] = useState(true)

  const sampleTests = useMemo(
    () => (isFullPackage(pkg) ? pkg.testCases.filter((t) => t.visibility === 'sample') : pkg.sampleTests),
    [pkg]
  )
  const libraries = useMemo(() => pkg.dependencies, [pkg])
  const readOnlyPaths = useMemo(() => {
    const locked = new Set<string>()
    for (const e of entries) {
      if (isLockedByReadOnly(entries, e.path)) locked.add(e.path)
    }
    return locked
  }, [entries])

  function runSamples(): void {
    setPanelTab('tests')
    setRunSignal((n) => n + 1)
  }

  // Ctrl+Enter / Cmd+Enter = รัน Sample (ทำงานแม้โฟกัสอยู่ใน Monaco editor)
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        runSamples()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function mutate(next: VirtualEntry[], message?: string): void {
    setEntries(next)
    props.onAutosave?.(next)
    if (message !== undefined) setNotice(message)
  }

  function fail(err: unknown): void {
    if (err instanceof Error) {
      if (err.name === 'ProjectTreePermissionError') setNotice(`⛔ ${err.message} — ไฟล์/โฟลเดอร์นี้ถูกล็อกโดยอาจารย์`)
      else if (err.name === 'ProjectTreeLimitError') setNotice('⛔ ขนาดโปรเจกต์เกิน maxProjectSizeBytes')
      else setNotice(`⛔ ${err.message}`)
    }
  }

  function handleUpload(files: FileList): void {
    void (async () => {
      try {
        let next = entries
        for (const f of Array.from(files)) {
          const text = await f.text()
          next = createFileInTree(next, pkg.policy, f.name, text.slice(0, 500_000))
        }
        mutate(next, `📤 อัปโหลด ${files.length} ไฟล์แล้ว`)
      } catch (err) {
        fail(err)
      }
    })()
  }

  return (
    <div className="flex h-full flex-col rounded-2xl border border-slate-800 bg-slate-950/40">
      {/* Kiosk HUD */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2 text-xs text-slate-400">
        <button
          type="button"
          onClick={() => setShowProblem((v) => !v)}
          title={showProblem ? 'ซ่อนโจทย์' : 'แสดงโจทย์'}
          className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
        >
          <FileText size={14} />
        </button>
        <button
          type="button"
          onClick={() => setShowExplorer((v) => !v)}
          title={showExplorer ? 'ซ่อน Explorer' : 'แสดง Explorer'}
          className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
        >
          {showExplorer ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        </button>
        <span className="font-semibold text-slate-200">{pkg.title}</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5">ข้อ {props.questionNo ?? 1}/{props.questionTotal ?? 1}</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5">{PROJECT_CATEGORY_LABELS[pkg.category]}</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5">{SUPPORTED_LANGUAGE_LABELS[pkg.language]}</span>
        <span className="ml-auto inline-flex items-center gap-1 font-mono"><Timer size={12} />{props.timeLeftText ?? '--:--'}</span>
      </div>
      {notice !== null && (
        <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900/70 px-3 py-1.5 text-xs text-amber-200">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-slate-500 hover:text-slate-200">ปิด</button>
        </div>
      )}
      {/* Phase 9.1: เช็ค runtime ของภาษาที่ข้อสอบใช้จริงก่อนเริ่ม (ขาดให้ติดตั้งเอง + Re-scan/Browse) */}
      <MissingRuntimePrompt languages={[pkg.language]} compact />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* โจทย์ + libraries (ยุบได้) */}
        {showProblem && (
          <div className="h-56 shrink-0 overflow-y-auto border-b border-slate-800 p-3 lg:h-auto lg:w-60 lg:border-b-0 lg:border-r">
            <h3 className="mb-1 text-sm font-semibold text-slate-100">📄 โจทย์</h3>
            <p className="whitespace-pre-wrap text-[13px] leading-6 text-slate-300">{pkg.instructions || '(อาจารย์ยังไม่ได้เขียนคำอธิบาย)'}</p>
            <div className="mt-3">
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">📦 Libraries ที่ใช้ได้</h4>
              {libraries.length === 0 ? (
                <p className="text-[11px] text-slate-600">ไม่มีไลบรารีเสริม</p>
              ) : (
                <ul className="space-y-0.5 font-mono text-[11px] text-slate-400">
                  {libraries.map((l, i) => (
                    <li key={i}>- {l.packages.map((p) => `${p.name}@${p.version}`).join(', ') || l.ecosystem}</li>
                  ))}
                </ul>
              )}
            </div>
            <button
              type="button"
              onClick={() => mutate(initialEntries.map((e) => ({ ...e })), '🔄 รีเซ็ตโค้ดกลับเป็น Starter Project แล้ว')}
              className="mt-3 inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-amber-500 hover:text-amber-200"
            >
              <RotateCcw size={12} /> Reset โค้ด
            </button>
          </div>
        )}

        {/* Explorer sidebar (ยุบได้) */}
        {showExplorer && (
          <div className="h-64 shrink-0 border-b border-slate-800 lg:h-auto lg:w-60 lg:border-b-0 lg:border-r">
            <ProjectFileExplorerTree
              entries={entries}
              selectedPath={activePath}
              canCreate={pkg.policy.allowCreateFiles || pkg.policy.allowCreateFolders}
              canDeleteRename={pkg.policy.allowDeleteRename}
              allowUpload={pkg.policy.allowStudentFileUpload}
              libraries={libraries}
              onSelectFile={setActivePath}
              onCreateFile={(p) => {
                try {
                  mutate(createFileInTree(entries, pkg.policy, p, ''), `📄 สร้างไฟล์ ${p} (+เขียนลง ${folder})`)
                  setActivePath(p)
                } catch (err) { fail(err) }
              }}
              onCreateFolder={(p) => {
                try {
                  mutate(createFolderInTree(entries, pkg.policy, p), `📁 สร้างโฟลเดอร์ ${p}`)
                } catch (err) { fail(err) }
              }}
              onRename={(o, n) => {
                try {
                  mutate(renameEntryInTree(entries, pkg.policy, o, n))
                  if (activePath === o) setActivePath(n)
                } catch (err) { fail(err) }
              }}
              onDelete={(p) => {
                try {
                  mutate(deleteEntryInTree(entries, pkg.policy, p), `🗑 ลบ ${p}`)
                  if (activePath === p) setActivePath(pkg.policy.entryPointPath)
                } catch (err) { fail(err) }
              }}
              onUploadFiles={handleUpload}
            />
          </div>
        )}

        {/* Editor (พื้นที่หลัก — ขยายเต็มเมื่อยุบ sidebars) */}
        <div className="h-96 min-h-0 min-w-0 flex-1 lg:h-auto">
          <MonacoCodeWorkspace
            entries={entries}
            activePath={activePath}
            readOnlyPaths={readOnlyPaths}
            onSelectFile={setActivePath}
            onChangeContent={(p, c) => {
              try {
                setEntries((prev) => updateFileContentInTree(prev, p, c))
                // Real-time write-through ลงโฟลเดอร์จริง + autosave ผ่าน callback (Main ผูก Phase 10)
                props.onAutosave?.(entries)
              } catch (err) { fail(err) }
            }}
          />
        </div>

        {/* ขวา: แผงทดสอบ/ผลลัพธ์ */}
        <div className="flex h-96 min-h-0 flex-col border-t border-slate-800 lg:h-auto lg:w-[340px] lg:shrink-0 lg:border-l lg:border-t-0">
          <div className="flex border-b border-slate-800 text-xs">
            {(['result', 'tests'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setPanelTab(t)}
                className={`px-3 py-2 font-medium ${panelTab === t ? 'border-b-2 border-emerald-500 text-emerald-300' : 'text-slate-500 hover:text-slate-200'}`}
              >
                {t === 'result' ? '🧪 แผงทดสอบ/ผลลัพธ์' : `✅ Tests (${sampleTests.length})`}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AdaptiveExecutionPanel
              category={pkg.category}
              language={pkg.language}
              entries={entries}
              entryPointPath={pkg.policy.entryPointPath}
              sampleTests={sampleTests}
              database={pkg.database}
              seedSql={seedSqlOf(pkg, entries)}
              runSignal={runSignal}
              viewerRole={props.viewerRole ?? 'student'}
            />
          </div>
        </div>
      </div>

      {/* แถบล่าง */}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 px-3 py-2">
        <StudentWorkspaceFolderPicker examId={examId} studentId={studentId} value={folder} onPick={setFolder} />
        <span className="flex-1" />
        <button
          type="button"
          onClick={runSamples}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
        >
          <Play size={15} /> รัน / ทดสอบ Sample (Ctrl+Enter)
        </button>
        <button
          type="button"
          onClick={() => props.onSubmit?.(entries)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-sky-500"
        >
          <Rocket size={15} /> ส่งงาน
        </button>
      </div>
    </div>
  )
}

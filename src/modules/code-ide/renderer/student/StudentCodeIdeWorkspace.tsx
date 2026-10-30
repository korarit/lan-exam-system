import { useEffect, useMemo, useRef, useState } from 'react'
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
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { ScrollArea } from '@renderer/components/ui/scroll-area'

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
  const [lastAutosaveAtMs, setLastAutosaveAtMs] = useState<number | null>(null)
  const [panelTab, setPanelTab] = useState<'result' | 'tests'>('result')
  const [runSignal, setRunSignal] = useState(0)
  const [showProblem, setShowProblem] = useState(true)
  const [showExplorer, setShowExplorer] = useState(true)
  // mirror ของ entries กัน stale closure ตอนพิมพ์เร็ว + throttle autosave ทุก 5 วิ
  // (ท่อ LAN จริง: ExamView ส่งต่อผ่าน student:module-send — workspace เองไม่ยิง IPC ตรง)
  const entriesRef = useRef(entries)
  const lastAutosaveRef = useRef(0)
  const isTeacherPreview = (props.viewerRole ?? 'student') === 'teacher'

  /** autosave ผ่าน callback (ExamView ส่งต่อเข้า LAN / host) — throttle 5 วิกันสแปม */
  function queueAutosave(next: VirtualEntry[]): void {
    if (isTeacherPreview) return
    const now = Date.now()
    if (now - lastAutosaveRef.current < 5000) return
    lastAutosaveRef.current = now
    setLastAutosaveAtMs(now)
    props.onAutosave?.(next)
  }

  function handleSubmit(): void {
    const snapshot = entriesRef.current
    props.onSubmit?.(snapshot)
    if (isTeacherPreview) {
      setNotice('โหมดพรีวิวครู — ไม่ส่งงานจริง')
      return
    }
    setNotice('ส่งงานแล้ว — รอเครื่องแม่รับเข้า (ดูสถานะจากแถบด้านบนเมื่อ host ตอบกลับ)')
  }

  const sampleTests = useMemo(
    () => (isFullPackage(pkg) ? pkg.testCases.filter((t) => t.visibility === 'sample') : pkg.sampleTests),
    [pkg]
  )
  const libraries = useMemo(() => pkg.dependencies, [pkg])
  /** F-3b: รายชื่อ exact ที่ครูอนุมัติให้ติดตั้งเอง (npm/pip เท่านั้น) */
  const installPackages = useMemo(
    () =>
      (pkg.installPolicy.enabled
        ? pkg.dependencies.flatMap((d) =>
          d.ecosystem === 'npm' || d.ecosystem === 'pip'
            ? d.packages.map((p) => ({ ecosystem: d.ecosystem as 'npm' | 'pip', name: p.name, version: p.version }))
            : []
        )
        : []),
    [pkg]
  )
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
    entriesRef.current = next
    setEntries(next)
    queueAutosave(next)
    if (message !== undefined) setNotice(message)
  }

  function fail(err: unknown): void {
    if (err instanceof Error) {
      if (err.name === 'ProjectTreePermissionError') setNotice(`${err.message} — ไฟล์/โฟลเดอร์นี้ถูกล็อกโดยอาจารย์`)
      else if (err.name === 'ProjectTreeLimitError') setNotice('ขนาดโปรเจกต์เกิน maxProjectSizeBytes')
      else setNotice(`${err.message}`)
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
        mutate(next, `อัปโหลด ${files.length} ไฟล์แล้ว`)
      } catch (err) {
        fail(err)
      }
    })()
  }

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      {/* Kiosk HUD */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setShowProblem((v) => !v)}
          title={showProblem ? 'ซ่อนโจทย์' : 'แสดงโจทย์'}
        >
          <FileText size={14} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setShowExplorer((v) => !v)}
          title={showExplorer ? 'ซ่อน Explorer' : 'แสดง Explorer'}
        >
          {showExplorer ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        </Button>
        <span className="font-semibold text-foreground">{pkg.title}</span>
        <Badge variant="secondary" className="tabular-nums">ข้อ {props.questionNo ?? 1}/{props.questionTotal ?? 1}</Badge>
        <Badge variant="outline">{PROJECT_CATEGORY_LABELS[pkg.category]}</Badge>
        <Badge variant="outline">{SUPPORTED_LANGUAGE_LABELS[pkg.language]}</Badge>
        <span className="ml-auto inline-flex items-center gap-1 font-mono tabular-nums"><Timer size={12} />{props.timeLeftText ?? '--:--'}</span>
      </div>
      {notice !== null && (
        <div className="flex items-center gap-2 border-b bg-muted/60 px-3 py-1.5 text-xs">
          <span className="flex-1">{notice}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setNotice(null)}>ปิด</Button>
        </div>
      )}
      {/* Phase 9.1: เช็ค runtime ของภาษาที่ข้อสอบใช้จริงก่อนเริ่ม (ขาดให้ติดตั้งเอง + Re-scan/Browse) */}
      <MissingRuntimePrompt languages={[pkg.language]} compact />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* โจทย์ + libraries (ยุบได้) */}
        {showProblem && (
          <ScrollArea className="h-56 shrink-0 border-b p-3 lg:h-auto lg:w-60 lg:border-b-0 lg:border-r">
            <h3 className="mb-1 text-sm font-semibold">โจทย์</h3>
            <p className="whitespace-pre-wrap text-[13px] leading-6 text-muted-foreground">{pkg.instructions || '(อาจารย์ยังไม่ได้เขียนคำอธิบาย)'}</p>
            <div className="mt-3">
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Libraries ที่ใช้ได้</h4>
              {libraries.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">ไม่มีไลบรารีเสริม</p>
              ) : (
                <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                  {libraries.map((l, i) => (
                    <li key={i}>- {l.packages.map((p) => `${p.name}@${p.version}`).join(', ') || l.ecosystem}</li>
                  ))}
                </ul>
              )}
              {pkg.installPolicy.enabled && (
                <p className="mt-1 text-[11px] text-primary">
                  ครูอนุญาตให้ติดตั้งเองได้ (pip/npm) — กด “ติดตั้งไลบรารี” ในแผงทดสอบ
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => mutate(initialEntries.map((e) => ({ ...e })), 'รีเซ็ตโค้ดกลับเป็น Starter Project แล้ว')}
              className="mt-3"
            >
              <RotateCcw size={12} /> Reset โค้ด
            </Button>
          </ScrollArea>
        )}

        {/* Explorer sidebar (ยุบได้) */}
        {showExplorer && (
          <div className="h-64 shrink-0 border-b lg:h-auto lg:w-60 lg:border-b-0 lg:border-r">
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
                  mutate(createFileInTree(entries, pkg.policy, p, ''), `สร้างไฟล์ ${p} (+เขียนลง ${folder})`)
                  setActivePath(p)
                } catch (err) { fail(err) }
              }}
              onCreateFolder={(p) => {
                try {
                  mutate(createFolderInTree(entries, pkg.policy, p), `สร้างโฟลเดอร์ ${p}`)
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
                  mutate(deleteEntryInTree(entries, pkg.policy, p), `ลบ ${p}`)
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
                // ใช้ ref mirror กัน stale closure ตอนพิมพ์เร็ว — state กับ ref อัปเดตพร้อมกัน
                const next = updateFileContentInTree(entriesRef.current, p, c)
                entriesRef.current = next
                setEntries(next)
                // Real-time write-through ลงโฟลเดอร์จริง + autosave ผ่าน callback (throttle 5 วิ)
                queueAutosave(next)
              } catch (err) { fail(err) }
            }}
          />
        </div>

        {/* ขวา: แผงทดสอบ/ผลลัพธ์ */}
        <div className="flex h-96 min-h-0 flex-col border-t lg:h-auto lg:w-[340px] lg:shrink-0 lg:border-l lg:border-t-0">
          <Tabs value={panelTab} onValueChange={(v) => setPanelTab(v as 'result' | 'tests')} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="w-full rounded-none border-b">
              <TabsTrigger value="result" className="flex-1">แผงทดสอบ/ผลลัพธ์</TabsTrigger>
              <TabsTrigger value="tests" className="flex-1 tabular-nums">Tests ({sampleTests.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="result" className="mt-0 min-h-0 flex-1 overflow-y-auto">
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
                packageId={pkg.packageId}
                installPolicy={pkg.installPolicy}
                installPackages={installPackages}
              />
            </TabsContent>
            <TabsContent value="tests" className="mt-0 min-h-0 flex-1 overflow-y-auto">
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
                packageId={pkg.packageId}
                installPolicy={pkg.installPolicy}
                installPackages={installPackages}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <div
        title="draft เก็บในโฟลเดอร์เครื่อง + ส่ง host ทุก ≥5 วินาที ดูยืนยันจากแถบ ack ด้านบน เน็ตหลุด draft ไม่หาย"
        className="border-t bg-muted/40 px-3 py-1 text-[11px] tabular-nums text-muted-foreground"
      >
        {isTeacherPreview
          ? 'โหมดพรีวิวครู — ไม่ส่งงานจริง'
          : lastAutosaveAtMs === null
            ? 'ยังไม่มี autosave — แก้โค้ดแล้วระบบจะบันทึก draft อัตโนมัติ (เก็บในเครื่อง + ส่ง host)'
            : `draft ล่าสุด ${new Date(lastAutosaveAtMs).toLocaleTimeString('th-TH')} — เก็บในเครื่องแล้ว + ส่ง host แล้ว (รอยืนยัน ack)`}
      </div>
      {/* แถบล่าง */}
      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
        <StudentWorkspaceFolderPicker examId={examId} studentId={studentId} value={folder} onPick={setFolder} />
        <span className="flex-1" />
        <Button
          type="button"
          variant="secondary"
          onClick={runSamples}
        >
          <Play size={15} /> รัน / ทดสอบ Sample (Ctrl+Enter)
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
        >
          <Rocket size={15} /> ส่งงาน
        </Button>
      </div>
    </Card>
  )
}

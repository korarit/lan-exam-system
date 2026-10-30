import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, GitCompare, History, Code2, ListChecks, MonitorPlay, Plug, Database, MessageSquare } from 'lucide-react'
import type { CodeIdeSubmissionDetailResponse, CodeIdeSubmitProjectRequest } from '@shared/ipc-channels'
import type { VirtualEntry } from '../../shared/code-schema'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { ScrollArea } from '@renderer/components/ui/scroll-area'

type IpcEntries = CodeIdeSubmitProjectRequest['entries']

/** เติม defaults ให้ entries ที่มาจาก IPC ตรงกับ VirtualEntry (schema defaults) */
function toVirtualEntries(entries: IpcEntries | undefined): VirtualEntry[] {
  return (entries ?? []).map((e) => ({
    path: e.path,
    kind: e.kind,
    ...(e.content !== undefined ? { content: e.content } : {}),
    encoding: e.encoding ?? 'utf8',
    readOnly: e.readOnly ?? false,
    allowStudentCreateInside: e.allowStudentCreateInside ?? true,
    hiddenFromStudent: e.hiddenFromStudent ?? false
  }))
}
import ProjectFileExplorerTree from '../student/ProjectFileExplorerTree'
import MonacoCodeWorkspace from '../student/MonacoCodeWorkspace'

/* ============================================================
 * Phase 10 (10.3) — Teacher Project Mirror IDE Inspector
 * อาจารย์เห็น Folder & File Tree เหมือนฝั่งนักเรียนเป๊ะ (คอมโพเนนต์ชุดเดียวกัน)
 * + เทียบ Diff รายไฟล์กับเฉลย + Playback starter→draft→submitted
 * + ผลตรวจราย test + manual rubric + เปิดโฟลเดอร์ <studentId>
 * ============================================================ */

interface Props {
  studentId: string
  maxPoints: number
  category: string | null
  language: string | null
  onClose: () => void
}

/** มุมมองรายละเอียดหลัง normalize เป็น VirtualEntry เต็มรูปแล้ว */
interface DetailView {
  studentId: string
  status?: string
  manualPoints?: number | null
  entries: VirtualEntry[]
  starterEntries: VirtualEntry[]
  draftEntries?: VirtualEntry[]
  referenceEntries: VirtualEntry[]
  gradeResults?: CodeIdeSubmissionDetailResponse['gradeResults']
  blockedReason?: string | null
}

type ViewMode = 'code' | 'diff' | 'tests' | 'playback' | 'preview' | 'api' | 'sql' | 'comments'

interface DiffLine {
  type: 'same' | 'del' | 'add'
  text: string
}

/** line diff แบบง่าย (LCS ตัดเหลือ 4000 บรรทัด — เกินนั้นแสดงแบบเต็มสองฝั่ง) */
function diffLines(a: string, b: string): DiffLine[] | null {
  const aLines = a.split('\n')
  const bLines = b.split('\n')
  if (aLines.length + bLines.length > 4000) return null
  const n = aLines.length
  const m = bLines.length
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  // แคปความยาวเพื่อกัน DP ระเบิด (4000^2 ไม่ไหว — จริง ๆ เราแคปผลรวมไว้แล้ว แต่ n*m อาจถึง ~4M ช่อง = ok หน่วยความจำ ~8MB)
  if (n * m > 4_000_000) return null
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!
    const next = dp[i + 1]!
    for (let j = m - 1; j >= 0; j--) {
      row[j] = aLines[i] === bLines[j] ? (next[j + 1]! + 1) as number : Math.max(next[j]!, row[j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push({ type: 'same', text: aLines[i] ?? '' })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: aLines[i] ?? '' })
      i++
    } else {
      out.push({ type: 'add', text: bLines[j] ?? '' })
      j++
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: aLines[i] ?? '' })
    i++
  }
  while (j < m) {
    out.push({ type: 'add', text: bLines[j] ?? '' })
    j++
  }
  return out
}

function fileContent(entries: VirtualEntry[] | undefined, path: string): string | null {
  const hit = entries?.find((e) => e.kind === 'file' && e.path === path)
  if (!hit || hit.encoding === 'base64') return null
  return hit.content ?? ''
}

export default function StudentProjectInspectorModal(props: Props): React.JSX.Element {
  const [detail, setDetail] = useState<DetailView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>('code')
  const [activePath, setActivePath] = useState<string | null>(null)
  const [playbackIndex, setPlaybackIndex] = useState(2)
  const [manual, setManual] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    void window.ztExam
      .getCodeSubmissionDetail({ studentId: props.studentId })
      .then((res) => {
        if (!res.ok) {
          setError(res.reason ?? 'โหลดไม่สำเร็จ')
          return
        }
        // normalize ทุกชุดก่อนเก็บใน state ให้เป็น VirtualEntry เต็มรูป
        const normalized: DetailView = {
          studentId: res.studentId ?? props.studentId,
          ...(res.status !== undefined ? { status: res.status } : {}),
          ...(res.manualPoints !== undefined ? { manualPoints: res.manualPoints } : {}),
          entries: toVirtualEntries(res.entries),
          starterEntries: toVirtualEntries(res.starterEntries),
          ...(res.draftEntries !== undefined ? { draftEntries: toVirtualEntries(res.draftEntries) } : {}),
          referenceEntries: toVirtualEntries(res.referenceEntries),
          ...(res.gradeResults !== undefined ? { gradeResults: res.gradeResults } : {}),
          ...(res.blockedReason !== undefined ? { blockedReason: res.blockedReason } : {})
        }
        setDetail(normalized)
        const firstFile = normalized.entries?.find((e) => e.kind === 'file')
        setActivePath(firstFile?.path ?? null)
        setManual(res.manualPoints !== null && res.manualPoints !== undefined ? String(res.manualPoints) : '')
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'unknown'))
      .finally(() => setLoading(false))
  }, [props.studentId])

  const playbackStages = useMemo(() => {
    if (!detail) return []
    const stages: Array<{ label: string; entries: VirtualEntry[] | undefined }> = [
      { label: 'Starter (ตอนเริ่มสอบ)', entries: detail.starterEntries },
      { label: 'Autosave ล่าสุด', entries: detail.draftEntries },
      { label: 'ฉบับที่ส่ง (ตรวจ)', entries: detail.entries }
    ]
    return stages.filter((s) => s.entries !== undefined)
  }, [detail])

  const shownEntries = useMemo(() => {
    if (mode !== 'playback' || playbackStages.length === 0) return detail?.entries ?? []
    const idx = Math.min(playbackIndex, playbackStages.length - 1)
    return playbackStages[idx]?.entries ?? []
  }, [mode, playbackStages, playbackIndex, detail])

  const readOnlyAll = useMemo(() => {
    const set = new Set<string>()
    for (const e of shownEntries) {
      if (e.kind === 'file') set.add(e.path)
    }
    return set
  }, [shownEntries])

  const studentFiles = useMemo(
    () => (detail?.entries ?? []).filter((e) => e.kind === 'file').map((e) => e.path).sort(),
    [detail]
  )

  const diffResult = useMemo(() => {
    if (activePath === null || !detail) return null
    const student = fileContent(detail.entries, activePath)
    const reference = fileContent(detail.referenceEntries, activePath)
    if (student === null) return { kind: 'no-student' as const }
    if (reference === null) return { kind: 'added-by-student' as const, student }
    if (student === reference) return { kind: 'identical' as const }
    return { kind: 'diff' as const, lines: diffLines(reference, student) }
  }, [activePath, detail])

  async function saveManual(): Promise<void> {
    const raw = manual.trim()
    setSaving(true)
    try {
      const points = raw === '' ? null : Number(raw)
      if (points !== null && (!Number.isFinite(points) || points < 0 || points > props.maxPoints)) {
        setMsg(`คะแนนต้องอยู่ระหว่าง 0–${props.maxPoints} (ว่าง = ล้างกลับไปใช้ auto)`)
        return
      }
      const res = await window.ztExam.codeManualGrade({ studentId: props.studentId, points })
      setMsg(res.ok ? 'บันทึกคะแนนแล้ว (manual ชนะ auto)' : `${res.reason ?? 'failed'}`)
    } catch (err) {
      setMsg(`บันทึกไม่สำเร็จ: ${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setSaving(false)
    }
  }

  async function openFolder(): Promise<void> {
    const res = await window.ztExam.openCodeStudentFolder({ studentId: props.studentId })
    if (!res.ok) setMsg(`เปิดโฟลเดอร์ไม่สำเร็จ: ${res.reason ?? 'unknown'}`)
  }

  const visibleModes: Array<{ id: ViewMode; label: string; icon: React.ReactNode }> = [
    { id: 'code', label: 'Mirror IDE', icon: <Code2 size={13} /> },
    { id: 'diff', label: 'Diff เฉลย', icon: <GitCompare size={13} /> },
    { id: 'tests', label: `ผลตรวจ (${detail?.gradeResults?.length ?? 0})`, icon: <ListChecks size={13} /> },
    { id: 'playback', label: 'Playback', icon: <History size={13} /> },
    ...(props.category === 'frontend' || props.category === 'fullstack'
      ? [{ id: 'preview' as ViewMode, label: 'Preview', icon: <MonitorPlay size={13} /> }]
      : []),
    ...(props.category === 'backend' || props.category === 'fullstack'
      ? [{ id: 'api' as ViewMode, label: 'API', icon: <Plug size={13} /> }]
      : []),
    ...(props.category === 'database' || props.category === 'fullstack'
      ? [{ id: 'sql' as ViewMode, label: 'SQL', icon: <Database size={13} /> }]
      : []),
    { id: 'comments', label: 'คอมเมนต์', icon: <MessageSquare size={13} /> }
  ]

  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onClose() }}>
      <DialogContent className="flex h-[86vh] max-w-[1100px] flex-col overflow-hidden">
        {/* header */}
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 font-mono text-sm">
            <Code2 size={16} className="text-primary" />
            {props.studentId}
            {detail && (
              <Badge variant="secondary" className="font-mono text-[11px]">
                {detail.status}
                {detail.blockedReason ? ` — ${detail.blockedReason.slice(0, 80)}` : ''}
              </Badge>
            )}
            <span className="flex-1" />
            <Button type="button" variant="outline" size="sm" onClick={() => void openFolder()}>
              <FolderOpen size={13} /> เปิดโฟลเดอร์งาน
            </Button>
          </DialogTitle>
        </DialogHeader>

        {loading && <p className="p-8 text-center text-sm text-muted-foreground">กำลังโหลดโปรเจกต์…</p>}
        {error !== null && <p className="p-8 text-center text-sm text-destructive">{error}</p>}

        {detail && !loading && (
          <Tabs value={mode} onValueChange={(v) => setMode(v as ViewMode)} className="flex min-h-0 flex-1 flex-col">
            {/* mode tabs */}
            <div className="flex flex-wrap items-center gap-1 border-b">
              <TabsList>
                {visibleModes.map((t) => (
                  <TabsTrigger key={t.id} value={t.id}>
                    {t.icon} {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <span className="flex-1" />
              <div className="flex items-center gap-1 pb-1 text-xs">
                <span className="text-muted-foreground">Manual:</span>
                <Input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder={`0–${props.maxPoints} / ว่าง=auto`}
                  className="w-36 font-mono tabular-nums"
                  aria-label="คะแนน manual"
                />
                <Button type="button" variant="outline" size="sm" onClick={() => void saveManual()} disabled={saving}>
                  {saving ? '…' : 'บันทึก'}
                </Button>
              </div>
            </div>
            {msg !== null && <p className="border-b bg-muted/40 px-4 py-1.5 text-xs">{msg}</p>}

            <div className="min-h-0 flex-1">
              <TabsContent value="code" className="mt-0 h-full">
                <div className="flex h-full flex-col lg:flex-row">
                  <div className="h-56 shrink-0 border-b lg:h-auto lg:w-64 lg:border-b-0 lg:border-r">
                    <ProjectFileExplorerTree
                      entries={shownEntries}
                      selectedPath={activePath}
                      canCreate={false}
                      canDeleteRename={false}
                      allowUpload={false}
                      libraries={[]}
                      onSelectFile={setActivePath}
                      onCreateFile={() => undefined}
                      onCreateFolder={() => undefined}
                      onRename={() => undefined}
                      onDelete={() => undefined}
                    />
                  </div>
                  <div className="min-h-[320px] min-w-0 flex-1">
                    <MonacoCodeWorkspace
                      entries={shownEntries}
                      activePath={activePath}
                      readOnlyPaths={readOnlyAll}
                      onSelectFile={setActivePath}
                      onChangeContent={() => undefined}
                    />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="playback" className="mt-0 h-full">
                <div className="flex h-full flex-col">
                  <div className="flex items-center gap-3 border-b px-4 py-2 text-xs">
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, playbackStages.length - 1)}
                      value={Math.min(playbackIndex, Math.max(0, playbackStages.length - 1))}
                      onChange={(e) => setPlaybackIndex(Number(e.target.value))}
                      className="flex-1 accent-primary"
                      aria-label="ช่วงเวลา playback"
                    />
                    <span className="min-w-[220px] text-right font-medium text-primary">
                      {playbackStages[Math.min(playbackIndex, Math.max(0, playbackStages.length - 1))]?.label ?? '—'}
                    </span>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                    <div className="h-56 shrink-0 border-b lg:h-auto lg:w-64 lg:border-b-0 lg:border-r">
                      <ProjectFileExplorerTree
                        entries={shownEntries}
                        selectedPath={activePath}
                        canCreate={false}
                        canDeleteRename={false}
                        allowUpload={false}
                        libraries={[]}
                        onSelectFile={setActivePath}
                        onCreateFile={() => undefined}
                        onCreateFolder={() => undefined}
                        onRename={() => undefined}
                        onDelete={() => undefined}
                      />
                    </div>
                    <div className="min-h-[320px] min-w-0 flex-1">
                      <MonacoCodeWorkspace
                        entries={shownEntries}
                        activePath={activePath}
                        readOnlyPaths={readOnlyAll}
                        onSelectFile={setActivePath}
                        onChangeContent={() => undefined}
                      />
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="diff" className="mt-0 h-full">
                <div className="flex h-full flex-col lg:flex-row">
                  <ScrollArea className="h-48 shrink-0 border-b p-2 lg:h-auto lg:w-64 lg:border-b-0 lg:border-r">
                    <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      ไฟล์ ({studentFiles.length}) — [M]=แก้ [A]=สร้างใหม่
                    </p>
                    {studentFiles.map((p) => {
                      const student = fileContent(detail.entries, p)
                      const reference = fileContent(detail.referenceEntries, p)
                      const flag = reference === null ? '[A]' : student !== reference ? '[M]' : ''
                      return (
                        <Button
                          key={p}
                          type="button"
                          variant={activePath === p ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => setActivePath(p)}
                          className="mb-0.5 w-full justify-start truncate font-mono text-[11px]"
                        >
                          {flag && <Badge variant="outline" className="mr-1">{flag}</Badge>}{p}
                        </Button>
                      )
                    })}
                  </ScrollArea>
                  <ScrollArea className="min-h-[320px] flex-1 bg-muted/20 p-3 font-mono text-[12px] leading-5">
                    {activePath === null && <p className="text-muted-foreground">เลือกไฟล์ทางซ้ายเพื่อเทียบกับเฉลย</p>}
                    {activePath !== null && diffResult?.kind === 'no-student' && <p className="text-muted-foreground">ไฟล์นี้ไม่มีในงานนักเรียน</p>}
                    {activePath !== null && diffResult?.kind === 'added-by-student' && (
                      <div>
                        <p className="mb-2">[A] ไฟล์นี้นักเรียนสร้างเพิ่ม — ไม่มีในเฉลย</p>
                        <pre className="whitespace-pre-wrap text-primary">{diffResult.student}</pre>
                      </div>
                    )}
                    {activePath !== null && diffResult?.kind === 'identical' && <p className="text-primary">ตรงกับเฉลยทุกบรรทัด</p>}
                    {activePath !== null && diffResult?.kind === 'diff' && diffResult.lines === null && (
                      <p className="text-muted-foreground">ไฟล์ใหญ่เกิน diff อัตโนมัติ — เปิดดูทีละฝั่งในโหมด Mirror IDE</p>
                    )}
                    {activePath !== null && diffResult?.kind === 'diff' && diffResult.lines !== null && (
                      <div>
                        <p className="mb-2 text-muted-foreground">
                          <span className="text-destructive">— ฝั่งเฉลย</span> / <span className="text-primary">+ ฝั่งนักเรียน</span>
                        </p>
                        {diffResult.lines.slice(0, 1500).map((l, i) => (
                          <div
                            key={i}
                            className={
                              l.type === 'del' ? 'bg-destructive/10 text-destructive' : l.type === 'add' ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
                            }
                          >
                            <span className="mr-2 inline-block w-4 select-none opacity-60">{l.type === 'del' ? '—' : l.type === 'add' ? '+' : ' '}</span>
                            {l.text || ' '}
                          </div>
                        ))}
                        {diffResult.lines.length > 1500 && <p className="mt-2 text-muted-foreground">…แสดง 1500 บรรทัดแรกจากทั้งหมด {diffResult.lines.length} บรรทัด</p>}
                      </div>
                    )}
                  </ScrollArea>
                </div>
              </TabsContent>

              <TabsContent value="tests" className="mt-0 h-full">
                <ScrollArea className="h-full p-3">
                  {(detail.gradeResults ?? []).length === 0 && (
                    <p className="text-sm text-muted-foreground">ยังไม่มีผลตรวจ (งานอยู่ในคิว/กำลังตรวจ หรือตรวจล้มเหลว)</p>
                  )}
                  <Card>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Test</TableHead>
                          <TableHead>ชนิด</TableHead>
                          <TableHead>การมองเห็น</TableHead>
                          <TableHead>ผล</TableHead>
                          <TableHead className="text-right">คะแนน</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(detail.gradeResults ?? []).map((t) => (
                          <TableRow key={t.testId}>
                            <TableCell className="font-mono font-semibold">{t.testId}</TableCell>
                            <TableCell><Badge variant="secondary" className="font-mono text-[11px]">{t.kind}</Badge></TableCell>
                            <TableCell><Badge variant="outline" className="text-[11px]">{t.visibility}</Badge></TableCell>
                            <TableCell>
                              <Badge variant={t.passed === true ? 'default' : t.passed === false ? 'destructive' : 'outline'}>
                                {t.passed === true ? 'ผ่าน' : t.passed === false ? 'ไม่ผ่าน' : 'รอตรวจ'}
                              </Badge>
                              <p className="mt-1 text-xs text-muted-foreground">{t.note}</p>
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums">{t.earned}/{t.points}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="preview" className="mt-0 h-full"><PreviewTab studentId={props.studentId} /></TabsContent>
              <TabsContent value="api" className="mt-0 h-full"><ApiProbeTab studentId={props.studentId} /></TabsContent>
              <TabsContent value="sql" className="mt-0 h-full"><SqlWorkbenchTab studentId={props.studentId} /></TabsContent>
              <TabsContent value="comments" className="mt-0 h-full">
                <CommentsTab
                  studentId={props.studentId}
                  files={(detail.entries ?? []).filter((e) => e.kind === 'file').map((e) => e.path).sort()}
                />
              </TabsContent>
            </div>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ---------- แท็บรัน: Preview / API / SQL / Comments ---------- */

function PreviewTab(props: { studentId: string }): React.JSX.Element {
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [status, setStatus] = useState('กด “โหลดพรีวิว” เพื่อ bundle งานนักเรียนแล้วรันใน iframe แยก (sandbox + CSP ตัดเน็ต)')
  const [loading, setLoading] = useState(false)

  async function load(): Promise<void> {
    setLoading(true)
    try {
      const res = await window.ztExam.runCodePreview({ studentId: props.studentId })
      if (!res.ok || !res.html || !res.js) {
        setStatus(`${res.reason ?? 'โหลดไม่สำเร็จ'}`)
        return
      }
      // CSP ตัดเน็ต/ฟอร์ม/ปลั๊กอิน — เหลือแค่สคริปต์ inline ของ bundle เอง
      const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">`
      const withCsp = res.html.includes('</head>')
        ? res.html.replace('</head>', `${csp}</head>`)
        : `${csp}${res.html}`
      const doc = withCsp.includes('</body>')
        ? withCsp.replace('</body>', `<script>${res.js}</script></body>`)
        : `${withCsp}<script>${res.js}</script>`
      setSrcDoc(doc)
      setStatus('รันพรีวิวแล้ว — เหมือนที่นักเรียนเห็น (รูป/ฟอนต์ภายนอกถูก CSP ตัด เหลือโครง + สคริปต์)')
    } catch (err) {
      setStatus(`${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Button
          type="button" onClick={() => void load()} disabled={loading}
          size="sm"
        >
          {loading ? 'กำลัง bundle…' : 'โหลดพรีวิว'}
        </Button>
        <span className="flex-1">{status}</span>
      </div>
      <div className="min-h-[320px] flex-1 overflow-hidden rounded-md border bg-white">
        {srcDoc !== null ? (
          <iframe title="student-preview" sandbox="allow-scripts" srcDoc={srcDoc} className="h-full w-full" />
        ) : (
          <p className="p-8 text-center text-sm text-muted-foreground">ยังไม่โหลด</p>
        )}
      </div>
    </div>
  )
}

function ApiProbeTab(props: { studentId: string }): React.JSX.Element {
  const [method, setMethod] = useState<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>('GET')
  const [apiPath, setApiPath] = useState('/api/users')
  const [body, setBody] = useState('{"name": "Test"}')
  const [result, setResult] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function fire(): Promise<void> {
    setLoading(true)
    setResult('กำลังรันเซิร์ฟเวอร์นักเรียนชั่วคราวแล้วยิง…')
    try {
      const res = await window.ztExam.probeCodeApi({
        studentId: props.studentId,
        method,
        path: apiPath,
        ...(method === 'GET' ? {} : { bodyJson: body })
      })
      setResult(
        res.ok
          ? `HTTP ${res.status ?? '?'} — ${res.note ?? ''}\n${res.body ?? ''}`.slice(0, 4000)
          : `${res.reason ?? res.note ?? 'failed'}`
      )
    } catch (err) {
      setResult(`${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
          <SelectTrigger className="w-28 font-mono text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input value={apiPath} onChange={(e) => setApiPath(e.target.value)} placeholder="/api/users/1" className="min-w-40 flex-1 font-mono text-xs" aria-label="พาธ API" />
        <Button type="button" size="sm" onClick={() => void fire()} disabled={loading}>
          {loading ? 'กำลังยิง…' : 'ยิงทดสอบ'}
        </Button>
      </div>
      {method !== 'GET' && (
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder='{"name": "Test"}' className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      )}
      <pre className="min-h-[200px] flex-1 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-xs">
        {result ?? 'ผลจะขึ้นตรงนี้ (เซิร์ฟเวอร์ถูก teardown ทันทีหลังยิง — พอร์ตไม่ค้าง)'}
      </pre>
    </div>
  )
}

function SqlWorkbenchTab(props: { studentId: string }): React.JSX.Element {
  const [sql, setSql] = useState('SELECT * FROM users;')
  const [columns, setColumns] = useState<string[]>([])
  const [rows, setRows] = useState<Array<Array<string | number | null>>>([])
  const [note, setNote] = useState('พิมพ์ SELECT แล้วกดรัน (seed ใหม่ทุกครั้ง + รัน studentSql ก่อน — ลบ/แก้ตารางได้เต็มที่)')
  const [loading, setLoading] = useState(false)

  async function run(): Promise<void> {
    setLoading(true)
    try {
      const res = await window.ztExam.queryCodeSql({ studentId: props.studentId, sql })
      if (!res.ok) {
        setNote(`${res.reason ?? 'failed'}`)
        return
      }
      setColumns(res.columns ?? [])
      setRows(res.rows ?? [])
      setNote(res.note ?? '')
    } catch (err) {
      setNote(`${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-start gap-1.5">
        <textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={3} className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <Button type="button" size="sm" onClick={() => void run()} disabled={loading}>
          {loading ? 'รัน…' : 'รัน'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
      <div className="min-h-[200px] flex-1 overflow-auto rounded-md border">
        <Table className="font-mono">
          <TableHeader>
            <TableRow>
              {columns.map((c) => <TableHead key={c}>{c}</TableHead>)}
              {columns.length === 0 && <TableHead>(ยังไม่มีผล)</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                {r.map((v, j) => (
                  <TableCell key={j}>{v === null ? <span className="text-muted-foreground">NULL</span> : String(v)}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function CommentsTab(props: { studentId: string; files: string[] }): React.JSX.Element {
  const [activeFile, setActiveFile] = useState(props.files[0] ?? '')
  const [comments, setComments] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function reload(): Promise<void> {
    try {
      const res = await window.ztExam.listCodeComments({ studentId: props.studentId })
      if (res.ok && res.comments) {
        const map: Record<string, string> = {}
        for (const c of res.comments) map[c.path] = c.comment
        setComments(map)
        if (activeFile !== '' && map[activeFile] !== undefined) setDraft(map[activeFile] ?? '')
      }
    } catch {
      /* อ่านไม่ได้ — ข้าม */
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.studentId])

  const scrollRef = useRef<HTMLDivElement>(null)

  function selectFile(p: string): void {
    setActiveFile(p)
    setDraft(comments[p] ?? '')
    setMsg(null)
  }

  async function save(): Promise<void> {
    if (activeFile === '') return
    setSaving(true)
    try {
      const res = await window.ztExam.saveCodeComment({ studentId: props.studentId, path: activeFile, comment: draft })
      if (res.ok) {
        setMsg(draft.trim() === '' ? 'ลบคอมเมนต์แล้ว' : 'บันทึกคอมเมนต์แล้ว')
        await reload()
        scrollRef.current?.scrollTo({ top: 0 })
      } else {
        setMsg(`${res.reason ?? 'failed'}`)
      }
    } catch (err) {
      setMsg(`${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setSaving(false)
    }
  }

  const commented = Object.keys(comments)

  return (
    <div ref={scrollRef} className="flex h-full flex-col gap-2 overflow-y-auto p-3 lg:flex-row">
      <ScrollArea className="h-48 shrink-0 p-2 lg:h-auto lg:w-64">
        <Card>
          <CardContent className="pt-3">
            <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground tabular-nums">
              ไฟล์ ({props.files.length}) · มีคอมเมนต์ ({commented.length})
            </p>
            {props.files.map((p) => (
              <Button
                key={p} type="button" variant={activeFile === p ? 'secondary' : 'ghost'} size="sm" onClick={() => selectFile(p)}
                className="mb-0.5 w-full justify-start truncate font-mono text-[11px]"
              >
                {comments[p] !== undefined && <MessageSquare size={11} className="text-primary" />}{p}
              </Button>
            ))}
          </CardContent>
        </Card>
      </ScrollArea>
      <div className="flex min-h-[280px] flex-1 flex-col gap-2">
        <p className="font-mono text-xs text-muted-foreground">คอมเมนต์ไฟล์: <span className="text-primary">{activeFile || '— เลือกไฟล์ทางซ้าย'}</span></p>
        <textarea
          value={draft} onChange={(e) => setDraft(e.target.value)} rows={8}
          placeholder="เช่น ตรงนี้ควรแยกฟังก์ชัน validate ออกมา — หัก 2 คะแนน"
          disabled={activeFile === ''}
          className="w-full flex-1 rounded-md border border-input bg-background px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        />
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={() => void save()} disabled={saving || activeFile === ''}>
            {saving ? '…' : 'บันทึกคอมเมนต์'}
          </Button>
          <span className="text-[11px] text-muted-foreground">ล้างข้อความเป็นค่าว่างแล้วบันทึก = ลบคอมเมนต์</span>
          {msg !== null && <span className="text-xs">{msg}</span>}
        </div>
      </div>
    </div>
  )
}

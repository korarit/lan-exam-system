import { useEffect, useMemo, useRef, useState } from 'react'
import { X, FolderOpen, GitCompare, History, Code2, ListChecks, MonitorPlay, Plug, Database, MessageSquare } from 'lucide-react'
import type { CodeIdeSubmissionDetailResponse, CodeIdeSubmitProjectRequest } from '@shared/ipc-channels'
import type { VirtualEntry } from '../../shared/code-schema'

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
        setMsg(`⛔ คะแนนต้องอยู่ระหว่าง 0–${props.maxPoints} (ว่าง = ล้างกลับไปใช้ auto)`)
        return
      }
      const res = await window.ztExam.codeManualGrade({ studentId: props.studentId, points })
      setMsg(res.ok ? '✅ บันทึกคะแนนแล้ว (manual ชนะ auto)' : `⛔ ${res.reason ?? 'failed'}`)
    } catch (err) {
      setMsg(`⛔ บันทึกไม่สำเร็จ: ${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setSaving(false)
    }
  }

  async function openFolder(): Promise<void> {
    const res = await window.ztExam.openCodeStudentFolder({ studentId: props.studentId })
    if (!res.ok) setMsg(`⛔ เปิดโฟลเดอร์ไม่สำเร็จ: ${res.reason ?? 'unknown'}`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={props.onClose}>
      <div
        className="flex h-[86vh] w-[1100px] max-w-full flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-2.5">
          <Code2 size={16} className="text-sky-400" />
          <span className="font-mono text-sm font-semibold text-slate-100">{props.studentId}</span>
          {detail && (
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
              {detail.status}
              {detail.blockedReason ? ` — ${detail.blockedReason.slice(0, 80)}` : ''}
            </span>
          )}
          <span className="flex-1" />
          <button type="button" onClick={() => void openFolder()} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs hover:border-emerald-500">
            <FolderOpen size={13} /> เปิดโฟลเดอร์งาน
          </button>
          <button type="button" onClick={props.onClose} className="rounded-lg border border-slate-700 p-1.5 hover:border-slate-500">
            <X size={14} />
          </button>
        </div>

        {loading && <p className="p-8 text-center text-sm text-slate-500">กำลังโหลดโปรเจกต์…</p>}
        {error !== null && <p className="p-8 text-center text-sm text-red-300">⛔ {error}</p>}

        {detail && !loading && (
          <>
            {/* mode tabs */}
            <div className="flex flex-wrap items-center gap-1 border-b border-slate-800 px-3 pt-2 text-xs">
              {(
                [
                  { id: 'code', label: '📁 Mirror IDE', icon: <Code2 size={13} />, show: true },
                  { id: 'diff', label: '⚖️ Diff เฉลย', icon: <GitCompare size={13} />, show: true },
                  { id: 'tests', label: `🧪 ผลตรวจ (${detail.gradeResults?.length ?? 0})`, icon: <ListChecks size={13} />, show: true },
                  { id: 'playback', label: '⏳ Playback', icon: <History size={13} />, show: true },
                  { id: 'preview', label: '▶ Preview', icon: <MonitorPlay size={13} />, show: props.category === 'frontend' || props.category === 'fullstack' },
                  { id: 'api', label: '🔌 API', icon: <Plug size={13} />, show: props.category === 'backend' || props.category === 'fullstack' },
                  { id: 'sql', label: '🗄️ SQL', icon: <Database size={13} />, show: props.category === 'database' || props.category === 'fullstack' },
                  { id: 'comments', label: '💬 คอมเมนต์', icon: <MessageSquare size={13} />, show: true }
                ] as const
              )
                .filter((t) => t.show)
                .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setMode(t.id)}
                  className={`inline-flex items-center gap-1 rounded-t-lg px-3 py-2 font-medium ${mode === t.id ? 'border-b-2 border-sky-500 text-sky-300' : 'text-slate-500 hover:text-slate-200'}`}
                >
                  {t.icon} {t.label}
                </button>
              ))}
              <span className="flex-1" />
              <div className="flex items-center gap-1 pb-1">
                <span className="text-slate-500">Manual:</span>
                <input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder={`0–${props.maxPoints} / ว่าง=auto`}
                  className="w-36 rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs focus:border-emerald-500 focus:outline-none"
                />
                <button type="button" onClick={() => void saveManual()} disabled={saving} className="rounded border border-slate-700 px-2 py-1 text-xs hover:border-emerald-500 disabled:opacity-40">
                  {saving ? '…' : 'บันทึก'}
                </button>
              </div>
            </div>
            {msg !== null && <p className="border-b border-slate-800 bg-slate-900/60 px-4 py-1.5 text-xs text-slate-200">{msg}</p>}

            <div className="min-h-0 flex-1">
              {(mode === 'code' || mode === 'playback') && (
                <div className="flex h-full flex-col">
                  {mode === 'playback' && (
                    <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-2 text-xs text-slate-300">
                      <span>⏳</span>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0, playbackStages.length - 1)}
                        value={Math.min(playbackIndex, Math.max(0, playbackStages.length - 1))}
                        onChange={(e) => setPlaybackIndex(Number(e.target.value))}
                        className="flex-1 accent-sky-500"
                      />
                      <span className="min-w-[220px] text-right font-medium text-sky-200">
                        {playbackStages[Math.min(playbackIndex, Math.max(0, playbackStages.length - 1))]?.label ?? '—'}
                      </span>
                    </div>
                  )}
                  <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                    <div className="h-56 shrink-0 border-b border-slate-800 lg:h-auto lg:w-64 lg:border-b-0 lg:border-r">
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
              )}

              {mode === 'diff' && (
                <div className="flex h-full flex-col lg:flex-row">
                  <div className="h-48 shrink-0 overflow-y-auto border-b border-slate-800 p-2 lg:h-auto lg:w-64 lg:border-b-0 lg:border-r">
                    <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      ไฟล์ ({studentFiles.length}) — [M]=แก้ [A]=สร้างใหม่
                    </p>
                    {studentFiles.map((p) => {
                      const student = fileContent(detail.entries, p)
                      const reference = fileContent(detail.referenceEntries, p)
                      const flag = reference === null ? '[A]' : student !== reference ? '[M]' : ''
                      return (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setActivePath(p)}
                          className={`mb-0.5 block w-full truncate rounded px-2 py-1 text-left font-mono text-[11px] ${activePath === p ? 'bg-sky-900/60 text-sky-100' : 'text-slate-300 hover:bg-slate-800'}`}
                        >
                          {flag && <span className="mr-1 text-amber-300">{flag}</span>}{p}
                        </button>
                      )
                    })}
                  </div>
                  <div className="min-h-[320px] flex-1 overflow-y-auto bg-slate-950 p-3 font-mono text-[12px] leading-5">
                    {activePath === null && <p className="text-slate-500">เลือกไฟล์ทางซ้ายเพื่อเทียบกับเฉลย</p>}
                    {activePath !== null && diffResult?.kind === 'no-student' && <p className="text-slate-500">ไฟล์นี้ไม่มีในงานนักเรียน</p>}
                    {activePath !== null && diffResult?.kind === 'added-by-student' && (
                      <div>
                        <p className="mb-2 text-amber-300">[A] ไฟล์นี้นักเรียนสร้างเพิ่ม — ไม่มีในเฉลย</p>
                        <pre className="whitespace-pre-wrap text-emerald-200">{diffResult.student}</pre>
                      </div>
                    )}
                    {activePath !== null && diffResult?.kind === 'identical' && <p className="text-emerald-300">✅ ตรงกับเฉลยทุกบรรทัด</p>}
                    {activePath !== null && diffResult?.kind === 'diff' && diffResult.lines === null && (
                      <p className="text-slate-400">ไฟล์ใหญ่เกิน diff อัตโนมัติ — เปิดดูทีละฝั่งในโหมด Mirror IDE</p>
                    )}
                    {activePath !== null && diffResult?.kind === 'diff' && diffResult.lines !== null && (
                      <div>
                        <p className="mb-2 text-slate-400">
                          <span className="text-red-300">— ฝั่งเฉลย</span> / <span className="text-emerald-300">+ ฝั่งนักเรียน</span>
                        </p>
                        {diffResult.lines.slice(0, 1500).map((l, i) => (
                          <div
                            key={i}
                            className={
                              l.type === 'del' ? 'bg-red-950/40 text-red-200' : l.type === 'add' ? 'bg-emerald-950/40 text-emerald-200' : 'text-slate-500'
                            }
                          >
                            <span className="mr-2 inline-block w-4 select-none opacity-60">{l.type === 'del' ? '—' : l.type === 'add' ? '+' : ' '}</span>
                            {l.text || ' '}
                          </div>
                        ))}
                        {diffResult.lines.length > 1500 && <p className="mt-2 text-slate-500">…แสดง 1500 บรรทัดแรกจากทั้งหมด {diffResult.lines.length} บรรทัด</p>}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {mode === 'tests' && (
                <div className="h-full overflow-y-auto p-3">
                  {(detail.gradeResults ?? []).length === 0 && (
                    <p className="text-sm text-slate-500">ยังไม่มีผลตรวจ (งานอยู่ในคิว/กำลังตรวจ หรือตรวจล้มเหลว)</p>
                  )}
                  <div className="space-y-2">
                    {(detail.gradeResults ?? []).map((t) => (
                      <div key={t.testId} className="rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2 text-[13px]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono font-semibold text-slate-100">{t.testId}</span>
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-400">{t.kind}</span>
                          <span className={`rounded px-1.5 py-0.5 text-[11px] ${t.visibility === 'hidden' ? 'bg-purple-900/60 text-purple-200' : 'bg-slate-800 text-slate-400'}`}>
                            {t.visibility}
                          </span>
                          <span className="ml-auto font-mono text-slate-200">
                            {t.passed === true ? '✅' : t.passed === false ? '❌' : '⏳'} {t.earned}/{t.points}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-400">{t.note}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {mode === 'preview' && <PreviewTab studentId={props.studentId} />}
              {mode === 'api' && <ApiProbeTab studentId={props.studentId} />}
              {mode === 'sql' && <SqlWorkbenchTab studentId={props.studentId} />}
              {mode === 'comments' && (
                <CommentsTab
                  studentId={props.studentId}
                  files={(detail.entries ?? []).filter((e) => e.kind === 'file').map((e) => e.path).sort()}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
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
        setStatus(`⛔ ${res.reason ?? 'โหลดไม่สำเร็จ'}`)
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
      setStatus('✅ รันพรีวิวแล้ว — เหมือนที่นักเรียนเห็น (รูป/ฟอนต์ภายนอกถูก CSP ตัด เหลือโครง + สคริปต์)')
    } catch (err) {
      setStatus(`⛔ ${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <button
          type="button" onClick={() => void load()} disabled={loading}
          className="rounded-lg bg-emerald-700 px-3 py-1.5 font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
        >
          {loading ? 'กำลัง bundle…' : '▶ โหลดพรีวิว'}
        </button>
        <span className="flex-1">{status}</span>
      </div>
      <div className="min-h-[320px] flex-1 overflow-hidden rounded-xl border border-slate-800 bg-white">
        {srcDoc !== null ? (
          <iframe title="student-preview" sandbox="allow-scripts" srcDoc={srcDoc} className="h-full w-full" />
        ) : (
          <p className="p-8 text-center text-sm text-slate-500">ยังไม่โหลด</p>
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
    setResult('⏳ กำลังรันเซิร์ฟเวอร์นักเรียนชั่วคราวแล้วยิง…')
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
          : `⛔ ${res.reason ?? res.note ?? 'failed'}`
      )
    } catch (err) {
      setResult(`⛔ ${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs">
          {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input value={apiPath} onChange={(e) => setApiPath(e.target.value)} placeholder="/api/users/1" className="min-w-40 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs" />
        <button type="button" onClick={() => void fire()} disabled={loading} className="rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-40">
          {loading ? 'กำลังยิง…' : 'ยิงทดสอบ'}
        </button>
      </div>
      {method !== 'GET' && (
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder='{"name": "Test"}' className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs" />
      )}
      <pre className="min-h-[200px] flex-1 overflow-auto whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-slate-200">
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
        setNote(`⛔ ${res.reason ?? 'failed'}`)
        return
      }
      setColumns(res.columns ?? [])
      setRows(res.rows ?? [])
      setNote(res.note ?? '')
    } catch (err) {
      setNote(`⛔ ${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-start gap-1.5">
        <textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={3} className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs" />
        <button type="button" onClick={() => void run()} disabled={loading} className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40">
          {loading ? 'รัน…' : '▶ รัน'}
        </button>
      </div>
      <p className="text-xs text-slate-500">{note}</p>
      <div className="min-h-[200px] flex-1 overflow-auto rounded-xl border border-slate-800">
        <table className="w-full text-left font-mono text-xs">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/60">
              {columns.map((c) => <th key={c} className="px-2 py-1.5 text-slate-300">{c}</th>)}
              {columns.length === 0 && <th className="px-2 py-1.5 text-slate-600">(ยังไม่มีผล)</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-slate-800/50">
                {r.map((v, j) => (
                  <td key={j} className="px-2 py-1 text-slate-200">{v === null ? <span className="text-slate-600">NULL</span> : String(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
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
        setMsg(draft.trim() === '' ? '🗑 ลบคอมเมนต์แล้ว' : '✅ บันทึกคอมเมนต์แล้ว')
        await reload()
        scrollRef.current?.scrollTo({ top: 0 })
      } else {
        setMsg(`⛔ ${res.reason ?? 'failed'}`)
      }
    } catch (err) {
      setMsg(`⛔ ${err instanceof Error ? err.message : 'unknown'}`)
    } finally {
      setSaving(false)
    }
  }

  const commented = Object.keys(comments)

  return (
    <div ref={scrollRef} className="flex h-full flex-col gap-2 overflow-y-auto p-3 lg:flex-row">
      <div className="h-48 shrink-0 overflow-y-auto rounded-xl border border-slate-800 p-2 lg:h-auto lg:w-64">
        <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          ไฟล์ ({props.files.length}) · มีคอมเมนต์ ({commented.length})
        </p>
        {props.files.map((p) => (
          <button
            key={p} type="button" onClick={() => selectFile(p)}
            className={`mb-0.5 block w-full truncate rounded px-2 py-1 text-left font-mono text-[11px] ${activeFile === p ? 'bg-sky-900/60 text-sky-100' : 'text-slate-300 hover:bg-slate-800'}`}
          >
            {comments[p] !== undefined && <span className="mr-1 text-amber-300">💬</span>}{p}
          </button>
        ))}
      </div>
      <div className="flex min-h-[280px] flex-1 flex-col gap-2">
        <p className="font-mono text-xs text-slate-400">💬 คอมเมนต์ไฟล์: <span className="text-sky-200">{activeFile || '— เลือกไฟล์ทางซ้าย'}</span></p>
        <textarea
          value={draft} onChange={(e) => setDraft(e.target.value)} rows={8}
          placeholder="เช่น ตรงนี้ควรแยกฟังก์ชัน validate ออกมา — หัก 2 คะแนน"
          disabled={activeFile === ''}
          className="w-full flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] focus:border-sky-500 focus:outline-none disabled:opacity-40"
        />
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void save()} disabled={saving || activeFile === ''} className="rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-40">
            {saving ? '…' : 'บันทึกคอมเมนต์'}
          </button>
          <span className="text-[11px] text-slate-600">ล้างข้อความเป็นค่าว่างแล้วบันทึก = ลบคอมเมนต์</span>
          {msg !== null && <span className="text-xs text-slate-300">{msg}</span>}
        </div>
      </div>
    </div>
  )
}

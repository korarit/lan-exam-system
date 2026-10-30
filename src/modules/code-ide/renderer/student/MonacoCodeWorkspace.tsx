import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Lock } from 'lucide-react'
import type * as monaco from 'monaco-editor'
import { monacoLanguageForPath, type VirtualEntry } from '../../shared/code-schema'
import { Card } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

/* ============================================================
 * Phase 8 (8.2.2) — MonacoCodeWorkspace (Multi-File & Cross-File)
 * Monaco ตัวจริง: model ต่อไฟล์ผ่าน monaco.Uri.file(path) —
 * import ข้ามไฟล์/โฟลเดอร์มี IntelliSense ตรงกันทั้งโปรเจกต์,
 * .d.ts ของ libraries ผ่าน typescriptDefaults.addExtraLib
 * โหลด Monaco ไม่ได้ (เช่น CSP/worker ถูกบล็อก) → textarea fallback
 * ============================================================ */

interface Props {
  entries: readonly VirtualEntry[]
  activePath: string | null
  readOnlyPaths: Set<string>
  /** ไฟล์ .d.ts ของ libraries (Monaco IntelliSense ออฟไลน์) */
  extraLibs?: Array<{ content: string; filePath: string }>
  onSelectFile: (path: string) => void
  onChangeContent: (path: string, content: string) => void
}

export interface MonacoFileModel {
  path: string
  languageId: string
  /** เทียบเท่า monaco.Uri.file(path) */
  uri: string
  content: string
}

/** สร้าง model ต่อไฟล์ — ตรงกับ monaco.editor.createModel ที่ผูกกับ editor */
export function buildMonacoModels(entries: readonly VirtualEntry[]): MonacoFileModel[] {
  return entries
    .filter((e) => e.kind === 'file' && e.encoding === 'utf8')
    .map((e) => ({
      path: e.path,
      languageId: monacoLanguageForPath(e.path),
      uri: `inmemory://model/${e.path}`,
      content: e.content ?? ''
    }))
}

let monacoEnvReady = false
type WorkerCtor = new () => Worker

function ensureMonacoEnv(EditorWorker: WorkerCtor, TsWorker: WorkerCtor): void {
  if (monacoEnvReady) return
  monacoEnvReady = true
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'typescript' || label === 'javascript') return new TsWorker()
      return new EditorWorker()
    }
  }
}

type LoadState = 'loading' | 'ready' | 'failed'

export default function MonacoCodeWorkspace(props: Props): React.JSX.Element {
  const models = useMemo(() => buildMonacoModels(props.entries), [props.entries])
  const [openPaths, setOpenPaths] = useState<string[]>(() =>
    props.activePath !== null ? [props.activePath] : []
  )
  const [loadState, setLoadState] = useState<LoadState>('loading')

  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof monaco | null>(null)
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>())
  const listenersRef = useRef(new Map<string, monaco.IDisposable>())
  const libsAppliedRef = useRef<string | null>(null)

  // โหลด Monaco + inline workers (blob) ครั้งเดียวตอน mount —
  // เป็น lazy chunk แยกจาก bundle หลัก (ts.worker ~11MB ไม่ถ่วงตอนเปิดแอป)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // Inline workers ทำงานได้ทั้ง dev (http) และแอปแพ็กแล้ว (file://)
        const [m, ew, tw] = await Promise.all([
          import('monaco-editor'),
          import('monaco-editor/esm/vs/editor/editor.worker?worker&inline'),
          import('monaco-editor/esm/vs/language/typescript/ts.worker?worker&inline')
        ])
        if (cancelled) return
        ensureMonacoEnv(ew.default, tw.default)
        monacoRef.current = m
        setLoadState('ready')
      } catch {
        if (!cancelled) setLoadState('failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // สร้าง editor instance ครั้งเดียวเมื่อโหลดเสร็จ
  useEffect(() => {
    if (loadState !== 'ready' || containerRef.current === null || monacoRef.current === null) return
    const m = monacoRef.current
    const editor = m.editor.create(containerRef.current, {
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 8 },
      renderLineHighlight: 'all'
    })
    editorRef.current = editor
    return () => {
      for (const d of listenersRef.current.values()) d.dispose()
      listenersRef.current.clear()
      for (const model of modelsRef.current.values()) model.dispose()
      modelsRef.current.clear()
      libsAppliedRef.current = null
      editor.dispose()
      editorRef.current = null
    }
  }, [loadState])

  // .d.ts ของ libraries → IntelliSense ออฟไลน์
  useEffect(() => {
    if (loadState !== 'ready' || monacoRef.current === null) return
    const m = monacoRef.current
    const key = (props.extraLibs ?? []).map((l) => l.filePath).join('|')
    if (libsAppliedRef.current === key) return
    libsAppliedRef.current = key
    for (const lib of props.extraLibs ?? []) {
      m.typescript.typescriptDefaults.addExtraLib(lib.content, lib.filePath)
      m.typescript.javascriptDefaults.addExtraLib(lib.content, lib.filePath)
    }
  }, [loadState, props.extraLibs])

  // ซิงก์ entries → models (สร้าง/อัปเดต/ลบ) โดยไม่กวน undo stack ถ้าเนื้อหาตรงกัน
  useEffect(() => {
    if (loadState !== 'ready' || monacoRef.current === null) return
    const m = monacoRef.current
    const seen = new Set<string>()
    for (const f of models) {
      seen.add(f.path)
      let model = modelsRef.current.get(f.path)
      if (model === undefined || model.isDisposed()) {
        model = m.editor.createModel(f.content, f.languageId, m.Uri.file(`/${f.path}`))
        modelsRef.current.set(f.path, model)
        const path = f.path
        listenersRef.current.get(path)?.dispose()
        listenersRef.current.set(
          path,
          model.onDidChangeContent(() => {
            const current = modelsRef.current.get(path)
            if (current !== undefined && !current.isDisposed()) {
              props.onChangeContent(path, current.getValue())
            }
          })
        )
      } else {
        if (model.getLanguageId() !== f.languageId) {
          m.editor.setModelLanguage(model, f.languageId)
        }
        if (model.getValue() !== f.content) {
          model.setValue(f.content)
        }
      }
    }
    for (const [path, model] of modelsRef.current) {
      if (!seen.has(path)) {
        listenersRef.current.get(path)?.dispose()
        listenersRef.current.delete(path)
        modelsRef.current.delete(path)
        model.dispose()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadState, models])

  // ไฟล์ที่เลือก → setModel + readOnly
  useEffect(() => {
    const editor = editorRef.current
    if (loadState !== 'ready' || editor === null) return
    const model = props.activePath !== null ? modelsRef.current.get(props.activePath) : undefined
    if (editor.getModel() !== (model ?? null)) {
      editor.setModel(model ?? null)
    }
    const readOnly = props.activePath !== null && props.readOnlyPaths.has(props.activePath)
    editor.updateOptions({ readOnly })
  }, [loadState, props.activePath, props.readOnlyPaths, models])

  useEffect(() => {
    if (props.activePath !== null && !openPaths.includes(props.activePath)) {
      setOpenPaths((prev) => [...prev, props.activePath as string])
    }
  }, [props.activePath, openPaths])

  function closeTab(path: string): void {
    setOpenPaths((prev) => {
      const next = prev.filter((p) => p !== path)
      if (props.activePath === path && next.length > 0) {
        props.onSelectFile(next[next.length - 1] as string)
      }
      return next
    })
  }

  const activeModel = models.find((mm) => mm.path === props.activePath) ?? null
  const isReadOnly = props.activePath !== null && props.readOnlyPaths.has(props.activePath)

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      {/* Multi-tab */}
      <div className="flex items-center gap-0.5 overflow-x-auto border-b bg-muted/40 px-1 pt-1">
        {openPaths.map((p) => {
          const active = p === props.activePath
          return (
            <div
              key={p}
              className={cn('group flex shrink-0 items-center gap-1 rounded-t-md border-x border-t px-2 py-1 font-mono text-xs',
                active ? 'border-border bg-card text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              <button type="button" onClick={() => props.onSelectFile(p)} title={p} className="max-w-40 truncate">
                {p.split('/').pop()}
              </button>
              <Button type="button" variant="ghost" size="icon" onClick={() => closeTab(p)} className="h-5 w-5 opacity-0 group-hover:opacity-100" aria-label={`ปิด ${p}`}>
                <X size={12} />
              </Button>
            </div>
          )
        })}
        {openPaths.length === 0 && <span className="px-2 py-1 text-xs text-muted-foreground">เลือกไฟล์จาก Project Files เพื่อเริ่มเขียนโค้ด</span>}
      </div>

      {activeModel === null ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
          ยังไม่ได้เปิดไฟล์ — คลิกไฟล์ในต้นไม้โปรเจกต์ หรือสร้างไฟล์ใหม่
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b px-3 py-1 text-[11px] text-muted-foreground">
            <code className="font-mono">{activeModel.path}</code>
            <Badge variant="secondary" className="font-mono">{activeModel.languageId}</Badge>
            {isReadOnly && <Badge variant="outline"><Lock size={10} /> read-only</Badge>}
            <span className="ml-auto hidden tabular-nums sm:inline">models: {models.length} (cross-file IntelliSense พร้อม)</span>
          </div>
          {loadState === 'failed' ? (
            <TextareaFallback
              content={activeModel.content}
              readOnly={isReadOnly}
              activePath={props.activePath}
              onChangeContent={props.onChangeContent}
            />
          ) : (
            <div ref={containerRef} className="min-h-0 flex-1" />
          )}
        </>
      )}
    </Card>
  )
}

function TextareaFallback(props: {
  content: string
  readOnly: boolean
  activePath: string | null
  onChangeContent: (path: string, content: string) => void
}): React.JSX.Element {
  const lines = props.content.split('\n').length
  return (
    <div className="flex min-h-0 flex-1">
      <div aria-hidden className="select-none overflow-hidden border-r bg-muted/40 px-2 py-3 text-right font-mono text-[13px] leading-6 tabular-nums text-muted-foreground">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        value={props.content}
        readOnly={props.readOnly}
        spellCheck={false}
        onChange={(e) => {
          if (props.activePath !== null) props.onChangeContent(props.activePath, e.target.value)
        }}
        className="min-h-0 flex-1 resize-none bg-background p-3 font-mono text-[13px] leading-6 outline-none"
      />
    </div>
  )
}

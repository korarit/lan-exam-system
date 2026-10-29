import { useMemo, useState } from 'react'
import type { DomTestCase, VirtualEntry } from '../../../shared/code-schema'

/* Phase 8 (8.2.3) โหมด 2: Frontend Web & React — Sandboxed Live Preview + DOM assertions */

export function buildWebSrcDoc(entries: readonly VirtualEntry[]): string | null {
  const byPath = new Map(entries.map((e) => [e.path.toLowerCase(), e]))
  const findByExt = (...exts: string[]): VirtualEntry[] =>
    entries.filter((e) => e.kind === 'file' && exts.some((x) => e.path.toLowerCase().endsWith(x)))

  // 1) มี index.html → inline css/js ภายในโปรเจกต์
  const indexHtml = [...byPath.values()].find((e) => e.kind === 'file' && /(^|\/)index\.html$/i.test(e.path))
  if (indexHtml?.content !== undefined) {
    let doc = indexHtml.content
    const cssFiles = findByExt('.css')
    const jsFiles = findByExt('.js')
    if (cssFiles.length > 0 && !/<style/i.test(doc)) {
      doc = doc.replace(/<\/head>/i, `${cssFiles.map((c) => `<style>\n${c.content ?? ''}\n</style>`).join('\n')}</head>`)
    }
    if (jsFiles.length > 0 && !/<script/i.test(doc)) {
      doc = doc.replace(/<\/body>/i, `${jsFiles.map((j) => `<script>\n${j.content ?? ''}\n</script>`).join('\n')}</body>`)
    }
    return doc
  }
  // 2) ไม่มี index.html แต่มี html อื่น → ใช้ไฟล์แรก
  const anyHtml = findByExt('.html')[0]
  if (anyHtml?.content !== undefined) return anyHtml.content
  return null
}

export default function WebReactPreviewPanel(props: {
  entries: readonly VirtualEntry[]
  language: string
  tests: DomTestCase[]
}): React.JSX.Element {
  const srcDoc = useMemo(() => buildWebSrcDoc(props.entries), [props.entries])
  const [logs, setLogs] = useState<string[]>([])
  const isReact = props.language === 'react'

  return (
    <div className="space-y-3 p-3">
      {isReact && (
        <p className="rounded-lg border border-amber-800/50 bg-amber-950/30 px-2.5 py-1.5 text-[11px] text-amber-200">
          โปรเจกต์ React จะถูก bundle ออฟไลน์ (esbuild) + รันใน Headless DOM Runner ใน Phase 9 — ด้านล่างคือ preview สำหรับไฟล์ HTML/CSS/JS ตั้งต้น
        </p>
      )}
      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Sandboxed Live Preview</h3>
        {srcDoc === null ? (
          <p className="rounded-lg border border-slate-800 p-4 text-center text-xs text-slate-500">
            ยังไม่มีไฟล์ .html ในโปรเจกต์ — สร้าง index.html แล้ว preview จะขึ้นตรงนี้
          </p>
        ) : (
          <iframe
            title="web-preview"
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            onError={() => setLogs((prev) => [...prev, 'preview error'])}
            className="h-64 w-full rounded-lg border border-slate-700 bg-white"
          />
        )}
      </div>
      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Console Logs</h3>
        <div className="max-h-20 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-2 font-mono text-[11px] text-slate-400">
          {logs.length === 0 ? '(ยังไม่มี log — console ของหน้า preview จะรวมตรงนี้ใน Phase 9)' : logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">DOM Assertions ({props.tests.length})</h3>
        {props.tests.length === 0 && <p className="text-xs text-slate-500">ไม่มี sample DOM test</p>}
        {props.tests.map((t) => (
          <div key={t.testId} className="mb-1.5 rounded-lg border border-slate-800 bg-slate-950/60 p-2">
            <div className="flex items-center gap-2 text-[13px]">
              <span className="font-medium text-slate-200">{t.title}</span>
              <code className="font-mono text-[11px] text-slate-500">{t.route}</code>
              <span className="ml-auto rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-amber-300">รอ DOM Runner (Phase 9)</span>
            </div>
            <pre className="mt-1 overflow-x-auto rounded bg-slate-900 p-1.5 font-mono text-[11px] text-slate-400">{t.assertionScript}</pre>
          </div>
        ))}
      </div>
    </div>
  )
}

import { useMemo, useState } from 'react'
import type { DomTestCase, VirtualEntry } from '../../../shared/code-schema'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { ScrollArea } from '@renderer/components/ui/scroll-area'

/* Phase 8 (8.2.3) โหมด 2: Frontend Web & React — Sandboxed Live Preview + DOM assertions */

export function buildWebSrcDoc(entries: readonly VirtualEntry[]): string | null {
  const findByExt = (...exts: string[]): VirtualEntry[] =>
    entries.filter((e) => e.kind === 'file' && exts.some((x) => e.path.toLowerCase().endsWith(x)))

  // 1) มี index.html → inline css/js ภายในโปรเจกต์
  const indexHtml = entries.find((e) => e.kind === 'file' && /(^|\/)index\.html$/i.test(e.path))
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
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="px-2.5 py-1.5 text-[11px]">
            โปรเจกต์ React จะถูก bundle ออฟไลน์ (esbuild) + รันใน Headless DOM Runner ใน Phase 9 — ด้านล่างคือ preview สำหรับไฟล์ HTML/CSS/JS ตั้งต้น
          </CardContent>
        </Card>
      )}
      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sandboxed Live Preview</h3>
        {srcDoc === null ? (
          <Card className="border-dashed">
            <CardContent className="p-4 text-center text-xs text-muted-foreground">
              ยังไม่มีไฟล์ .html ในโปรเจกต์ — สร้าง index.html แล้ว preview จะขึ้นตรงนี้
            </CardContent>
          </Card>
        ) : (
          <iframe
            title="web-preview"
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            onError={() => setLogs((prev) => [...prev, 'preview error'])}
            className="h-64 w-full rounded-md border bg-white"
          />
        )}
      </div>
      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Console Logs</h3>
        <ScrollArea className="max-h-20">
          <div className="rounded-md border bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
            {logs.length === 0 ? '(ยังไม่มี log — console ของหน้า preview จะรวมตรงนี้ใน Phase 9)' : logs.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </ScrollArea>
      </div>
      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground tabular-nums">DOM Assertions ({props.tests.length})</h3>
        {props.tests.length === 0 && <p className="text-xs text-muted-foreground">ไม่มี sample DOM test</p>}
        {props.tests.map((t) => (
          <Card key={t.testId} className="mb-1.5 bg-muted/30">
            <CardContent className="pt-2">
              <div className="flex items-center gap-2 text-[13px]">
                <span className="font-medium">{t.title}</span>
                <code className="font-mono text-[11px] text-muted-foreground">{t.route}</code>
                <Badge variant="outline" className="ml-auto text-[10px]">รอ DOM Runner (Phase 9)</Badge>
              </div>
              <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-1.5 font-mono text-[11px] text-muted-foreground">{t.assertionScript}</pre>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

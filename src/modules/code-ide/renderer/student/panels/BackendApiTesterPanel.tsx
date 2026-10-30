import { useState } from 'react'
import { Send, Play } from 'lucide-react'
import type { HttpApiTestCase } from '../../../shared/code-schema'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent } from '@renderer/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { ScrollArea } from '@renderer/components/ui/scroll-area'

/* Phase 8 (8.2.3) โหมด 3: Backend API — Mini API Client + Sample HTTP tests + Server logs */

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface ServerLogLine {
  at: string
  text: string
}

export default function BackendApiTesterPanel(props: { tests: HttpApiTestCase[] }): React.JSX.Element {
  const [method, setMethod] = useState<Method>('GET')
  const [path, setPath] = useState('/api/users')
  const [body, setBody] = useState('{\n  "name": "Somchai"\n}')
  const [response, setResponse] = useState<string | null>(null)
  const [logs, setLogs] = useState<ServerLogLine[]>([
    { at: new Date().toLocaleTimeString(), text: 'server: รอการรัน (Sandbox Runtime มา Phase 9)' }
  ])

  function now(): string {
    return new Date().toLocaleTimeString()
  }

  function sendRequest(): void {
    // Phase 8 (UI): จำลอง client — ผูกกับเซิร์ฟเวอร์ sandbox จริงใน Phase 9
    setResponse(`HTTP/1.1 … (ยังไม่ยิงจริง — Sandbox server มา Phase 9)\n${method} ${path}\n${method === 'GET' || method === 'DELETE' ? '' : body}`)
    setLogs((prev) => [...prev, { at: now(), text: `${method} ${path} → (queued, รอ Phase 9 runtime)` }])
  }

  return (
    <div className="space-y-3 p-3">
      <Card className="bg-muted/30">
        <CardContent className="pt-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Mini API Client</h3>
          <div className="flex gap-1.5">
            <Select value={method} onValueChange={(v) => setMethod(v as Method)}>
              <SelectTrigger className="w-28 font-mono text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as Method[]).map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/api/products?role=admin"
              className="min-w-0 flex-1 font-mono text-xs"
              aria-label="พาธ API"
            />
            <Button type="button" size="sm" onClick={sendRequest}>
              <Send size={12} /> ยิง
            </Button>
          </div>
          {method !== 'GET' && method !== 'DELETE' && (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder='{"key": "value"}'
              className="mt-1.5 w-full rounded-md border border-input bg-background p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          )}
          {response !== null && (
            <pre className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11px]">{response}</pre>
          )}
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground tabular-nums">Sample HTTP API Tests ({props.tests.length})</h3>
        {props.tests.length === 0 && <p className="text-xs text-muted-foreground">ไม่มี sample API test</p>}
        {props.tests.map((t) => (
          <Card key={t.testId} className="mb-1.5 bg-muted/30">
            <CardContent className="pt-2">
              <div className="flex items-center gap-2 text-[13px]">
                <span className="font-medium">{t.title}</span>
                <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{t.points} คะแนน</span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setLogs((prev) => [...prev, { at: now(), text: `run ${t.testId} → รอ Phase 9 grader` }])}
                >
                  <Play size={12} /> รัน
                </Button>
              </div>
              {t.requests.map((r, i) => (
                <div key={i} className="mt-1 font-mono text-[11px] text-muted-foreground">
                  <span className="text-primary">{r.method}</span> {r.path} → <span className="text-primary">{r.expectedStatus}</span>
                  <span> ({r.expectedBodyMatcher})</span>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Server Console (stdout/stderr)</h3>
        <ScrollArea className="max-h-28">
          <div className="rounded-md border bg-muted/40 p-2 font-mono text-[11px] tabular-nums text-muted-foreground">
            {logs.map((l, i) => <div key={i}><span>{l.at}</span> {l.text}</div>)}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

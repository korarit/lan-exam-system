import { useState } from 'react'
import { Send, Play } from 'lucide-react'
import type { HttpApiTestCase } from '../../../shared/code-schema'

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
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Mini API Client</h3>
        <div className="flex gap-1.5">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as Method)}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs focus:border-sky-500 focus:outline-none"
          >
            {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as Method[]).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/api/products?role=admin"
            className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs focus:border-sky-500 focus:outline-none"
          />
          <button type="button" onClick={sendRequest} className="inline-flex items-center gap-1 rounded bg-sky-700 px-3 py-1.5 text-xs font-medium hover:bg-sky-600">
            <Send size={12} /> ยิง
          </button>
        </div>
        {method !== 'GET' && method !== 'DELETE' && (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder='{"key": "value"}'
            className="mt-1.5 w-full rounded border border-slate-700 bg-slate-900 p-2 font-mono text-xs focus:border-sky-500 focus:outline-none"
          />
        )}
        {response !== null && (
          <pre className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-slate-900 p-2 font-mono text-[11px] text-slate-300">{response}</pre>
        )}
      </div>

      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Sample HTTP API Tests ({props.tests.length})</h3>
        {props.tests.length === 0 && <p className="text-xs text-slate-500">ไม่มี sample API test</p>}
        {props.tests.map((t) => (
          <div key={t.testId} className="mb-1.5 rounded-lg border border-slate-800 bg-slate-950/60 p-2">
            <div className="flex items-center gap-2 text-[13px]">
              <span className="font-medium text-slate-200">{t.title}</span>
              <span className="ml-auto text-[11px] text-slate-500">{t.points} คะแนน</span>
              <button
                type="button"
                onClick={() => setLogs((prev) => [...prev, { at: now(), text: `run ${t.testId} → รอ Phase 9 grader` }])}
                className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium hover:bg-emerald-600"
              >
                <Play size={12} /> รัน
              </button>
            </div>
            {t.requests.map((r, i) => (
              <div key={i} className="mt-1 font-mono text-[11px] text-slate-400">
                <span className="text-sky-300">{r.method}</span> {r.path} → <span className="text-emerald-300">{r.expectedStatus}</span>
                <span className="text-slate-600"> ({r.expectedBodyMatcher})</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Server Console (stdout/stderr)</h3>
        <div className="max-h-28 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-2 font-mono text-[11px] text-slate-400">
          {logs.map((l, i) => <div key={i}><span className="text-slate-600">{l.at}</span> {l.text}</div>)}
        </div>
      </div>
    </div>
  )
}

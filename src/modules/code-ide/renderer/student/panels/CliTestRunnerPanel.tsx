import { useEffect, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import type { CliTestCase } from '../../../shared/code-schema'

/* Phase 8 (8.2.3) โหมด 1: CLI / Algorithm — Sample tests + Custom Input Console */

interface RunResult {
  actualStdout: string
  passed: boolean | null
  note: string
}

export default function CliTestRunnerPanel(props: { tests: CliTestCase[]; runSignal?: number | undefined }): React.JSX.Element {
  const [customInput, setCustomInput] = useState('')
  const [results, setResults] = useState<Record<string, RunResult>>({})
  const [customOutput, setCustomOutput] = useState<string | null>(null)
  const firstSignal = useRef(true)

  function runSample(t: CliTestCase): void {
    // Phase 8 (UI): จำลองการรัน — Runtime จริง (javac/java, python, node) มา Phase 9
    setResults((prev) => ({
      ...prev,
      [t.testId]: {
        actualStdout: t.expectedStdout,
        passed: null,
        note: 'UI preview — การรัน/ตรวจจริงด้วย External Runtime มาใน Phase 9'
      }
    }))
  }

  // Ctrl+Enter จาก workspace: รัน sample ทั้งหมด
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false
      return
    }
    if (props.runSignal === undefined || props.runSignal === 0) return
    for (const t of props.tests) runSample(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.runSignal])

  return (
    <div className="space-y-3 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Sample Test Cases ({props.tests.length})</h3>
      {props.tests.length === 0 && <p className="text-xs text-slate-500">ข้อนี้ไม่มี sample test — กดรันด้วย Custom Input ด้านล่าง</p>}
      {props.tests.map((t) => {
        const r = results[t.testId]
        return (
          <div key={t.testId} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-slate-200">{t.title}</span>
              <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{t.kind}</span>
              <span className="ml-auto text-[11px] text-slate-500">{t.points} คะแนน</span>
              <button
                type="button"
                onClick={() => runSample(t)}
                className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium hover:bg-emerald-600"
              >
                <Play size={12} /> รัน
              </button>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-1.5 font-mono text-[11px]">
              <div className="rounded bg-slate-900 p-1.5"><span className="text-slate-500">stdin:</span> <pre className="whitespace-pre-wrap text-slate-300">{t.stdin || '(ว่าง)'}</pre></div>
              <div className="rounded bg-slate-900 p-1.5"><span className="text-slate-500">expected:</span> <pre className="whitespace-pre-wrap text-slate-300">{t.expectedStdout || '(ว่าง)'}</pre></div>
              {r !== undefined && (
                <div className="rounded bg-slate-900 p-1.5"><span className="text-slate-500">actual:</span> <pre className="whitespace-pre-wrap text-slate-300">{r.actualStdout}</pre>
                  <p className="mt-1 font-sans text-[10px] text-amber-300">{r.note}</p>
                </div>
              )}
            </div>
          </div>
        )
      })}

      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
        <h4 className="mb-1.5 text-xs font-semibold text-slate-300">Custom Input Console</h4>
        <textarea
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          rows={3}
          placeholder="พิมพ์ stdin ทดสอบเอง…"
          className="w-full rounded border border-slate-700 bg-slate-900 p-2 font-mono text-xs focus:border-sky-500 focus:outline-none"
        />
        <div className="mt-1.5 flex gap-2">
          <button
            type="button"
            onClick={() => setCustomOutput('รอ Runtime Phase 9 — stdin ที่กรอกจะถูกส่งให้โปรแกรมของนักเรียน')}
            className="inline-flex items-center gap-1 rounded bg-sky-700 px-2.5 py-1 text-xs font-medium hover:bg-sky-600"
          >
            <Play size={12} /> รันด้วย input นี้ (Ctrl+Enter)
          </button>
        </div>
        {customOutput !== null && <p className="mt-1.5 text-[11px] text-amber-300">{customOutput}</p>}
      </div>
    </div>
  )
}

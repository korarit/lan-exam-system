import { useEffect, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import type { CliTestCase, SupportedCodeLanguage, VirtualEntry } from '../../../shared/code-schema'
import type { CodeIdeRuntimeStatus } from '../../../../../shared/ipc-channels'

/* Phase 8 (8.2.3) + Phase 9 (9.4.1) โหมด 1: CLI / Algorithm
 * - ปุ่มรันยิง IPC `code-ide:run-cli` ไปรันจริงใน Main (external runtime + Anti-Delete Guard)
 * - แสดงสถานะ runtime (เจอ/ขาด + คำแนะนำติดตั้ง) จาก `code-ide:check-runtimes`
 * - ถ้าไม่มี IPC (เช่นพรีวิวนอก Electron) จะ fallback เป็นข้อความจำลองแบบเดิม
 */

interface RunResult {
  actualStdout: string
  passed: boolean | null
  note: string
  stderr?: string | undefined
}

interface Props {
  tests: CliTestCase[]
  entries: readonly VirtualEntry[]
  language: SupportedCodeLanguage
  entryPointPath: string
  runSignal?: number | undefined
}

function api(): Window['ztExam'] | null {
  try {
    return typeof window !== 'undefined' && window.ztExam?.runCliTest !== undefined ? window.ztExam : null
  } catch {
    return null
  }
}

export default function CliTestRunnerPanel(props: Props): React.JSX.Element {
  const [customInput, setCustomInput] = useState('')
  const [results, setResults] = useState<Record<string, RunResult>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [customOutput, setCustomOutput] = useState<string | null>(null)
  const [customRunning, setCustomRunning] = useState(false)
  const [runtimeNote, setRuntimeNote] = useState<string | null>(null)
  const firstSignal = useRef(true)

  // เช็ค runtime ของภาษาที่ใช้ครั้งเดียวตอนเปิดแผง
  useEffect(() => {
    const zt = api()
    if (zt === null) return
    void (async () => {
      try {
        const res = await zt.checkRuntimes({ languages: [props.language] })
        const missing = res.runtimes.filter((r: CodeIdeRuntimeStatus) => !r.found)
        setRuntimeNote(
          missing.length === 0
            ? null
            : `⚠️ ไม่พบ ${missing.map((r) => `${r.name}${r.hint !== '' ? ` (${r.hint})` : ''}`).join(', ')} ในเครื่อง — ติดตั้งเองก่อนกดรัน`
        )
      } catch {
        // เช็คไม่สำเร็จไม่ถือว่าพัง — กดรันแล้วจะเห็น error จริง
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.language])

  async function runSample(t: CliTestCase): Promise<void> {
    const zt = api()
    if (zt === null) {
      // Fallback นอก Electron: จำลองแบบเดิม
      setResults((prev) => ({
        ...prev,
        [t.testId]: {
          actualStdout: t.expectedStdout,
          passed: null,
          note: 'UI preview — การรัน/ตรวจจริงด้วย External Runtime มาใน Phase 9'
        }
      }))
      return
    }
    setRunning((prev) => ({ ...prev, [t.testId]: true }))
    try {
      const r = await zt.runCliTest({
        language: props.language,
        entryPointPath: props.entryPointPath,
        entries: [...props.entries],
        test: t
      })
      const extra = [
        r.timedOut ? '⏱ หมดเวลา (ถูกตัดจบ)' : '',
        r.exitCode !== null && r.exitCode !== 0 ? `exit code ${r.exitCode}` : '',
        r.blockedReason ?? '',
        r.stderr.trim() !== '' ? `stderr: ${r.stderr.slice(0, 500)}` : ''
      ].filter((s) => s !== '')
      setResults((prev) => ({
        ...prev,
        [t.testId]: {
          actualStdout: r.actualStdout,
          passed: r.passed,
          stderr: r.stderr,
          note: [r.note, ...extra].filter((s) => s !== '').join(' · ')
        }
      }))
    } catch (err) {
      setResults((prev) => ({
        ...prev,
        [t.testId]: {
          actualStdout: '',
          passed: null,
          note: `⛔ รันไม่สำเร็จ: ${err instanceof Error ? err.message : 'IPC error'}`
        }
      }))
    } finally {
      setRunning((prev) => ({ ...prev, [t.testId]: false }))
    }
  }

  async function runCustom(): Promise<void> {
    const zt = api()
    if (zt === null) {
      setCustomOutput('รอ Runtime Phase 9 — stdin ที่กรอกจะถูกส่งให้โปรแกรมของนักเรียน')
      return
    }
    setCustomRunning(true)
    setCustomOutput(null)
    try {
      const r = await zt.runCliTest({
        language: props.language,
        entryPointPath: props.entryPointPath,
        entries: [...props.entries],
        test: {
          testId: 'custom-input',
          kind: 'stdio' as const,
          title: 'Custom input',
          stdin: customInput,
          expectedStdout: '',
          inputs: [],
          visibility: 'sample' as const,
          points: 1,
          timeoutMs: 5000
        }
      })
      setCustomOutput(
        [`▶ output:\n${r.actualStdout || '(ว่าง)'}`, r.stderr.trim() !== '' ? `stderr:\n${r.stderr.slice(0, 1000)}` : '', r.note]
          .filter((s) => s !== '')
          .join('\n')
      )
    } catch (err) {
      setCustomOutput(`⛔ รันไม่สำเร็จ: ${err instanceof Error ? err.message : 'IPC error'}`)
    } finally {
      setCustomRunning(false)
    }
  }

  // Ctrl+Enter จาก workspace: รัน sample ทั้งหมดตามลำดับ
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false
      return
    }
    if (props.runSignal === undefined || props.runSignal === 0) return
    void (async () => {
      for (const t of props.tests) await runSample(t)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.runSignal])

  return (
    <div className="space-y-3 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Sample Test Cases ({props.tests.length})</h3>
      {runtimeNote !== null && (
        <p className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-2.5 py-2 text-[11px] leading-5 text-amber-200">{runtimeNote}</p>
      )}
      {props.tests.length === 0 && <p className="text-xs text-slate-500">ข้อนี้ไม่มี sample test — กดรันด้วย Custom Input ด้านล่าง</p>}
      {props.tests.map((t) => {
        const r = results[t.testId]
        const isRunning = running[t.testId] === true
        return (
          <div key={t.testId} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-slate-200">{t.title}</span>
              <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{t.kind}</span>
              <span className="ml-auto text-[11px] text-slate-500">{t.points} คะแนน</span>
              <button
                type="button"
                onClick={() => void runSample(t)}
                disabled={isRunning}
                className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium hover:bg-emerald-600 disabled:opacity-40"
              >
                <Play size={12} /> {isRunning ? 'กำลังรัน…' : 'รัน'}
              </button>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-1.5 font-mono text-[11px]">
              {(t.inputs ?? []).length > 0 && (
                <div className="rounded bg-slate-900 p-1.5">
                  <span className="text-slate-500">inputs:</span>
                  <div className="mt-1 space-y-0.5">
                    {(t.inputs ?? []).map((inp, ii) => (
                      <div key={ii} className="flex gap-2">
                        <span className="text-sky-300">{inp.name}</span>
                        <span className="rounded bg-slate-800 px-1 text-[10px] text-slate-400">{inp.type}</span>
                        <span className="text-slate-200">= {inp.value === '' ? '(ว่าง)' : inp.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="rounded bg-slate-900 p-1.5"><span className="text-slate-500">stdin:</span> <pre className="whitespace-pre-wrap text-slate-300">{t.stdin || '(ว่าง — ใช้ inputs ด้านบน)'}</pre></div>
              <div className="rounded bg-slate-900 p-1.5"><span className="text-slate-500">expected output:</span> <pre className="whitespace-pre-wrap text-slate-300">{t.expectedStdout || '(ไม่มี — โจทย์ข้อนี้ไม่ตรวจอัตโนมัติ)'}</pre></div>
              {r !== undefined && (
                <div className={`rounded bg-slate-900 p-1.5 ${r.passed === true ? 'border border-emerald-800/60' : r.passed === false ? 'border border-red-800/60' : ''}`}>
                  <span className="text-slate-500">actual{ r.passed === true ? ' ✅' : r.passed === false ? ' ❌' : ''}:</span>
                  <pre className="whitespace-pre-wrap text-slate-300">{r.actualStdout || '(ว่าง)'}</pre>
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
            onClick={() => void runCustom()}
            disabled={customRunning}
            className="inline-flex items-center gap-1 rounded bg-sky-700 px-2.5 py-1 text-xs font-medium hover:bg-sky-600 disabled:opacity-40"
          >
            <Play size={12} /> {customRunning ? 'กำลังรัน…' : 'รันด้วย input นี้ (Ctrl+Enter)'}
          </button>
        </div>
        {customOutput !== null && <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[11px] text-amber-300">{customOutput}</pre>}
      </div>
    </div>
  )
}

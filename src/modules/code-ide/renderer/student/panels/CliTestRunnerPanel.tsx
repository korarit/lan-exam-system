import { useEffect, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import type { CliTestCase, SupportedCodeLanguage, VirtualEntry } from '../../../shared/code-schema'
import type { CodeIdeRuntimeStatus } from '../../../../../shared/ipc-channels'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'

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
  /** F-3: packageId ใช้ผูก offline libs ที่แคชไว้ (undefined = รันด้วย runtime เครื่องล้วน) */
  packageId?: string | undefined
  /** F-3b: นโยบายติดตั้งเอง (ครู opt-in) + รายชื่อ exact ที่ครูอนุมัติ */
  installPolicy?: { enabled: boolean; ecosystems: Array<'npm' | 'pip'> } | undefined
  installPackages?: Array<{ ecosystem: 'npm' | 'pip'; name: string; version: string }> | undefined
}

/** ecosystem ที่ภาษานี้ติดตั้งเองได้ (นอกนั้นต้องใช้ blob ออฟไลน์) */
function installEcosystemFor(language: SupportedCodeLanguage): 'npm' | 'pip' | null {
  if (['javascript', 'typescript', 'node-backend', 'react', 'html-css-js'].includes(language)) return 'npm'
  if (['python', 'python-backend'].includes(language)) return 'pip'
  return null
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
  const [installNote, setInstallNote] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const firstSignal = useRef(true)

  const wantedEco = installEcosystemFor(props.language)
  const approvedForEco = (props.installPackages ?? []).filter((p) => wantedEco !== null && p.ecosystem === wantedEco)
  const canSelfInstall =
    props.installPolicy?.enabled === true &&
    wantedEco !== null &&
    props.installPolicy.ecosystems.includes(wantedEco) &&
    approvedForEco.length > 0 &&
    props.packageId !== undefined

  /** F-3b: ติดตั้งไลบรารีที่ครูอนุมัติ (ครั้งเดียวต่อโจทย์) แล้วรายงาน manifest กลับ host */
  async function ensureInstalled(): Promise<boolean> {
    const zt = api()
    if (zt === null || props.packageId === undefined) return false
    if (!canSelfInstall) return true // ไม่ต้องติดตั้ง — รันด้วย runtime เครื่องล้วน
    try {
      const st = await zt.studentDepsStatus({ packageId: props.packageId })
      if (st.cached) return true
    } catch {
      return false
    }
    setInstalling(true)
    setInstallNote('กำลังติดตั้งไลบรารีที่ครูอนุมัติ… (ครั้งแรกครั้งเดียว)')
    try {
      const r = await zt.installStudentDeps({ packageId: props.packageId, packages: approvedForEco })
      if (!r.ok) {
        setInstallNote(`ติดตั้งไม่สำเร็จ (${r.reason ?? 'unknown'}) — รันด้วย runtime เครื่องตัวเองล้วน`)
        return false
      }
      setInstallNote(`ติดตั้งแล้ว: ${r.installed.join(', ')}`)
      // รายงาน manifest กลับ host (host เก็บลง grading report ให้ครูตรวจเทียบ)
      try {
        await window.ztExam.moduleSend({
          moduleId: 'code-ide',
          kind: 'action',
          payloadJson: JSON.stringify({ type: 'code-ide.deps-installed', packages: r.installed })
        })
      } catch {
        /* สายหลุด — manifest รอบนี้หาย แต่ deps ในเครื่องยังใช้รันได้ */
      }
      return true
    } catch {
      setInstallNote('ติดตั้งไม่สำเร็จ — รันด้วย runtime เครื่องตัวเองล้วน')
      return false
    } finally {
      setInstalling(false)
    }
  }

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
            : `ไม่พบ ${missing.map((r) => `${r.name}${r.hint !== '' ? ` (${r.hint})` : ''}`).join(', ')} ในเครื่อง — ติดตั้งเองก่อนกดรัน`
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
      await ensureInstalled()
      const r = await zt.runCliTest({
        language: props.language,
        entryPointPath: props.entryPointPath,
        entries: [...props.entries],
        test: t,
        ...(props.packageId !== undefined ? { packageId: props.packageId } : {})
      })
      const extra = [
        r.timedOut ? 'หมดเวลา (ถูกตัดจบ)' : '',
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
          note: `รันไม่สำเร็จ: ${err instanceof Error ? err.message : 'IPC error'}`
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
      await ensureInstalled()
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
        },
        ...(props.packageId !== undefined ? { packageId: props.packageId } : {})
      })
      setCustomOutput(
        [`output:\n${r.actualStdout || '(ว่าง)'}`, r.stderr.trim() !== '' ? `stderr:\n${r.stderr.slice(0, 1000)}` : '', r.note]
          .filter((s) => s !== '')
          .join('\n')
      )
    } catch (err) {
      setCustomOutput(`รันไม่สำเร็จ: ${err instanceof Error ? err.message : 'IPC error'}`)
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
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground tabular-nums">Sample Test Cases ({props.tests.length})</h3>
      {runtimeNote !== null && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="px-2.5 py-2 text-[11px] leading-5">{runtimeNote}</CardContent>
        </Card>
      )}
      {canSelfInstall && (
        <Card>
          <CardContent className="px-2.5 py-2 text-[11px] leading-5">
            ครูอนุญาตให้ติดตั้งไลบรารีเอง: <span className="font-mono">{approvedForEco.map((p) => `${p.name}@${p.version}`).join(', ')}</span>
            <Button
              type="button"
              size="sm"
              onClick={() => void ensureInstalled()}
              disabled={installing}
              className="ml-2"
            >
              {installing ? 'กำลังติดตั้ง…' : 'ติดตั้งเลย'}
            </Button>
            {installNote !== null && <p className="mt-1 text-muted-foreground">{installNote}</p>}
          </CardContent>
        </Card>
      )}
      {props.tests.length === 0 && <p className="text-xs text-muted-foreground">ข้อนี้ไม่มี sample test — กดรันด้วย Custom Input ด้านล่าง</p>}
      {props.tests.map((t) => {
        const r = results[t.testId]
        const isRunning = running[t.testId] === true
        return (
          <Card key={t.testId} className="bg-muted/30">
            <CardContent className="pt-3">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium">{t.title}</span>
                <Badge variant="secondary" className="font-mono text-[10px]">{t.kind}</Badge>
                {r !== undefined && (
                  <Badge variant={r.passed === true ? 'default' : r.passed === false ? 'destructive' : 'outline'}>
                    {r.passed === true ? 'ผ่าน' : r.passed === false ? 'ไม่ผ่าน' : 'ยังไม่ตรวจ'}
                  </Badge>
                )}
                <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{t.points} คะแนน</span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void runSample(t)}
                  disabled={isRunning}
                >
                  <Play size={12} /> {isRunning ? 'กำลังรัน…' : 'รัน'}
                </Button>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-1.5 font-mono text-[11px]">
                {(t.inputs ?? []).length > 0 && (
                  <div className="rounded-md bg-muted p-1.5">
                    <span className="text-muted-foreground">inputs:</span>
                    <div className="mt-1 space-y-0.5">
                      {(t.inputs ?? []).map((inp, ii) => (
                        <div key={ii} className="flex gap-2">
                          <span className="text-primary">{inp.name}</span>
                          <Badge variant="outline" className="text-[10px]">{inp.type}</Badge>
                          <span>= {inp.value === '' ? '(ว่าง)' : inp.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="rounded-md bg-muted p-1.5"><span className="text-muted-foreground">stdin:</span> <pre className="whitespace-pre-wrap">{t.stdin || '(ว่าง — ใช้ inputs ด้านบน)'}</pre></div>
                <div className="rounded-md bg-muted p-1.5"><span className="text-muted-foreground">expected output:</span> <pre className="whitespace-pre-wrap">{t.expectedStdout || '(ไม่มี — โจทย์ข้อนี้ไม่ตรวจอัตโนมัติ)'}</pre></div>
                {r !== undefined && (
                  <div className="rounded-md bg-muted p-1.5">
                    <span className="text-muted-foreground">actual:</span>
                    <pre className="whitespace-pre-wrap">{r.actualStdout || '(ว่าง)'}</pre>
                    <p className="mt-1 font-sans text-[10px] text-muted-foreground">{r.note}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )
      })}

      <Card className="bg-muted/30">
        <CardContent className="pt-3">
          <h4 className="mb-1.5 text-xs font-semibold">Custom Input Console</h4>
          <textarea
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            rows={3}
            placeholder="พิมพ์ stdin ทดสอบเอง…"
            className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="mt-1.5 flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void runCustom()}
              disabled={customRunning}
            >
              <Play size={12} /> {customRunning ? 'กำลังรัน…' : 'รันด้วย input นี้ (Ctrl+Enter)'}
            </Button>
          </div>
          {customOutput !== null && <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[11px]">{customOutput}</pre>}
        </CardContent>
      </Card>
    </div>
  )
}

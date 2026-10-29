import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, RefreshCcw } from 'lucide-react'
import type { DatabaseConfig, SqlTestCase } from '../../../shared/code-schema'

/* Phase 8 (8.2.3) โหมด 4: Database & SQL Workbench
 * - Schema & Data Browser (ตาราง/คอลัมน์/ข้อมูลตั้งต้น)
 * - Ephemeral DB Respawn: ลบ/แก้/ลบตารางได้เต็มที่ — Spawn ใหม่พร้อมข้อมูลเดิมทุกครั้งที่ Run
 * - Query Result Table (Expected vs Actual) — SQLite จริงผูกใน Phase 9 */

interface Props {
  database: DatabaseConfig
  seedSql: string
  tests: SqlTestCase[]
  runSignal?: number | undefined
}

function parseTables(seedSql: string): Array<{ name: string; columns: string[] }> {
  const tables: Array<{ name: string; columns: string[] }> = []
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?(\w+)["'`\]]?\s*\(([\s\S]*?)\)\s*;/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(seedSql)) !== null) {
    const name = m[1] as string
    const colsRaw = (m[2] as string).split(',').map((c) => c.trim()).filter((c) => c.length > 0)
    const columns = colsRaw
      .map((c) => c.split(/\s+/)[0]?.replace(/["'`[\]]/g, '') ?? '')
      .filter((c) => c.length > 0 && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(c))
    tables.push({ name, columns })
  }
  return tables
}

function isDestructive(sql: string): boolean {
  return /\b(DELETE|DROP|TRUNCATE|UPDATE|ALTER)\b/i.test(sql)
}

export default function DatabaseWorkbenchPanel(props: Props): React.JSX.Element {
  // Master Seed เก็บแยก — Ephemeral copy ถูก spawn ใหม่ทุกครั้งที่ Run/Respawn
  const [epoch, setEpoch] = useState(0)
  const [query, setQuery] = useState('SELECT * FROM users;')
  const [lastResult, setLastResult] = useState<string | null>(null)
  const tables = useMemo(() => parseTables(props.seedSql), [props.seedSql])
  const firstSignal = useRef(true)

  function runQuery(): void {
    const destructive = isDestructive(query)
    // Phase 8 (UI): จำลอง respawn — Phase 9 ผูก better-sqlite3/ephemeral DB จริง
    setEpoch((e) => (props.database.respawnFreshDbOnEveryRun ? e + 1 : e))
    setLastResult(
      destructive
        ? `คำสั่ง Destructive ถูกบันทึกบน DB จำลอง (epoch ${epoch + 1}) — Spawn ใหม่พร้อมข้อมูลตั้งต้นเดิมแล้ว ✅ (SQLite จริงมา Phase 9)`
        : `รันบน DB จำลอง (epoch ${epoch + 1}) — ผลลัพธ์จริงจาก SQLite มา Phase 9`
    )
  }

  function respawn(): void {
    setEpoch((e) => e + 1)
    setLastResult(`🔄 Spawn Fresh DB แล้ว (epoch ${epoch + 1}) — คืนค่าตารางและข้อมูลตั้งต้นเดิมครบ`)
  }

  // Ctrl+Enter จาก workspace: รัน query ปัจจุบัน
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false
      return
    }
    if (props.runSignal === undefined || props.runSignal === 0) return
    runQuery()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.runSignal])

  return (
    <div className="space-y-3 p-3">
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Schema & Data Browser</h3>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">epoch {epoch}</span>
          <button type="button" onClick={respawn} className="ml-auto inline-flex items-center gap-1 rounded bg-slate-700 px-2 py-1 text-[11px] hover:bg-slate-600">
            <RefreshCcw size={12} /> Spawn Fresh DB
          </button>
        </div>
        {tables.length === 0 ? (
          <p className="text-xs text-slate-500">ไม่พบ CREATE TABLE ใน seed — อัปโหลด db/seed.sql หรือ .sqlite ใน Builder</p>
        ) : (
          tables.map((t) => (
            <div key={t.name} className="mb-1 rounded bg-slate-900 p-1.5 font-mono text-[11px]">
              <span className="text-emerald-300">▦ {t.name}</span>
              <span className="text-slate-500"> ({t.columns.join(', ')})</span>
            </div>
          ))
        )}
        <p className="mt-1.5 text-[11px] text-slate-500">
          {props.database.allowDestructiveQueries
            ? 'โจทย์ข้อนี้อนุญาต DELETE / DROP / ALTER ได้เต็มที่ — ระบบเก็บ Master Seed แยกไว้เสมอ'
            : 'โหมดอ่านอย่างเดียว'}
        </p>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">SQL Editor</h3>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={4}
          spellCheck={false}
          className="w-full rounded border border-slate-700 bg-slate-900 p-2 font-mono text-xs focus:border-sky-500 focus:outline-none"
        />
        <button type="button" onClick={runQuery} className="mt-1.5 inline-flex items-center gap-1 rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium hover:bg-emerald-600">
          <Play size={12} /> รัน Query (Ctrl+Enter)
        </button>
        {lastResult !== null && <p className="mt-1.5 text-[11px] text-amber-300">{lastResult}</p>}
      </div>

      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Query Result — Expected vs Actual ({props.tests.length})</h3>
        {props.tests.length === 0 && <p className="text-xs text-slate-500">ไม่มี sample SQL test</p>}
        {props.tests.map((t) => (
          <div key={t.testId} className="mb-1.5 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/60 p-2">
            <div className="mb-1 flex items-center gap-2 text-[13px]">
              <span className="font-medium text-slate-200">{t.title}</span>
              <span className="ml-auto text-[11px] text-slate-500">{t.points} คะแนน</span>
            </div>
            <table className="w-full font-mono text-[11px]">
              <thead>
                <tr className="text-left text-slate-500">
                  {t.expectedColumns.map((c) => <th key={c} className="border-b border-slate-800 px-1.5 py-1 font-medium">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {t.expectedRows.slice(0, 5).map((row, i) => (
                  <tr key={i} className="text-slate-300">
                    {row.map((cell, j) => <td key={j} className="border-b border-slate-800/50 px-1.5 py-1">{cell ?? 'NULL'}</td>)}
                  </tr>
                ))}
                {t.expectedRows.length === 0 && (
                  <tr><td colSpan={Math.max(1, t.expectedColumns.length)} className="px-1.5 py-2 text-slate-600">(ตรวจผ่าน verificationQuery — ไม่มีแถวตัวอย่าง)</td></tr>
                )}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  )
}

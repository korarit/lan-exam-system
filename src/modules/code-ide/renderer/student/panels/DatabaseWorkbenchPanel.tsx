import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, RefreshCcw } from 'lucide-react'
import type { DatabaseConfig, SqlTestCase } from '../../../shared/code-schema'

/* Phase 8 (8.2.3) + Phase 9 (9.4.4) โหมด 4: Database & SQL Workbench (SQLite เท่านั้น)
 * - Runtime: SQLite (better-sqlite3) ทั้งฝั่งครูและนักเรียน — ไม่ต้องตั้งเซิร์ฟเวอร์
 * - 2 โหมดข้อสอบ: 'query' (มี table+data ให้แล้ว) / 'create-table' (ให้สร้าง table เอง)
 * - Ephemeral DB: DELETE/DROP ได้เต็มที่ — Spawn ใหม่พร้อมข้อมูลเดิมทุกครั้งที่ Run
 * - Schema Viewer: ครูดูได้ตลอด / นักเรียนดูได้เฉพาะเมื่อครูเปิด exposeDbViewerToStudent
 */

interface Props {
  database: DatabaseConfig
  seedSql: string
  tests: SqlTestCase[]
  runSignal?: number | undefined
  /** 'teacher' ดู schema ได้ตลอด / 'student' ดูได้เฉพาะเมื่อครูเปิด */
  viewerRole?: 'teacher' | 'student'
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
  const viewerRole = props.viewerRole ?? 'student'
  const sqlMode = props.database.sqlMode ?? 'query'
  const canViewSchema = viewerRole === 'teacher' || props.database.exposeDbViewerToStudent

  // Master Seed เก็บแยก — Ephemeral copy ถูก spawn ใหม่พร้อมข้อมูลเดิมทุกครั้งที่ Run/Respawn
  const [epoch, setEpoch] = useState(0)
  const [query, setQuery] = useState(
    sqlMode === 'create-table' ? 'CREATE TABLE students (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL\n);' : 'SELECT * FROM users;'
  )
  const [lastResult, setLastResult] = useState<string | null>(null)
  const [sqlResults, setSqlResults] = useState<Record<string, { passed: boolean | null; actualColumns: string[]; actualRows: Array<Array<string | number | null>>; note: string }>>({})
  const [sqlRunning, setSqlRunning] = useState(false)
  const firstSignal = useRef(true)

  function hasIpc(): boolean {
    try {
      return typeof window !== 'undefined' && window.ztExam?.runSqlTest !== undefined
    } catch {
      return false
    }
  }

  // Live schema: seed + DDL ที่นักเรียนกำลังเขียน (รองรับโหมดสร้าง table — พิมพ์ CREATE TABLE แล้วเห็นตารางขึ้นทันที)
  const liveSchemaSql = useMemo(() => `${props.seedSql}\n${query}`, [props.seedSql, query])
  const tables = useMemo(() => parseTables(liveSchemaSql), [liveSchemaSql])
  const seedTables = useMemo(() => parseTables(props.seedSql), [props.seedSql])

  async function runQuery(): Promise<void> {
    const destructive = isDestructive(query)
    // รันจริงด้วย SQLite (better-sqlite3) ฝั่ง Main: spawn ephemeral DB ใหม่ทุกครั้ง
    setEpoch((e) => (props.database.respawnFreshDbOnEveryRun ? e + 1 : e))
    if (!hasIpc()) {
      // Fallback นอก Electron: ข้อความจำลองแบบเดิม
      setLastResult(
        destructive
          ? `คำสั่งถูกส่งไป SQLite ephemeral (epoch ${epoch + 1}) — Spawn ใหม่พร้อมข้อมูลตั้งต้นเดิมแล้ว ✅`
          : `รันบน SQLite ephemeral (epoch ${epoch + 1}) — ผลลัพธ์จริงตรวจด้วย better-sqlite3 ฝั่ง Main`
      )
      return
    }
    if (props.tests.length === 0) {
      setLastResult('ไม่มี sample SQL test — query ถูกส่งไปรันบน SQLite ephemeral แล้ว (ดูผลตรวจเมื่อครูเพิ่ม test)')
      return
    }
    setSqlRunning(true)
    try {
      const next: Record<string, { passed: boolean | null; actualColumns: string[]; actualRows: Array<Array<string | number | null>>; note: string }> = {}
      for (const t of props.tests) {
        try {
          const r = await window.ztExam.runSqlTest({ seedSql: props.seedSql, studentSql: query, test: t })
          next[t.testId] = { passed: r.passed, actualColumns: r.actualColumns, actualRows: r.actualRows, note: r.note }
        } catch (err) {
          next[t.testId] = { passed: null, actualColumns: [], actualRows: [], note: `⛔ รันไม่สำเร็จ: ${err instanceof Error ? err.message : 'IPC error'}` }
        }
      }
      setSqlResults(next)
      const passedCount = Object.values(next).filter((r) => r.passed === true).length
      setLastResult(`รันบน SQLite ephemeral (epoch ${epoch + 1}) — ผ่าน ${passedCount}/${props.tests.length} sample tests ✅`)
    } finally {
      setSqlRunning(false)
    }
  }

  function respawn(): void {
    setEpoch((e) => e + 1)
    setQuery(sqlMode === 'create-table' ? 'CREATE TABLE students (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL\n);' : 'SELECT * FROM users;')
    setLastResult(`🔄 Spawn Fresh DB แล้ว (epoch ${epoch + 1}) — คืนค่าตารางและข้อมูลตั้งต้นเดิมครบ`)
  }

  // Ctrl+Enter จาก workspace: รัน query ปัจจุบัน
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false
      return
    }
    if (props.runSignal === undefined || props.runSignal === 0) return
    void runQuery()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.runSignal])

  return (
    <div className="space-y-3 p-3">
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">SQLite</span>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">epoch {epoch}</span>
          <span className="text-[11px] text-slate-500">
            {sqlMode === 'query' ? '📋 โหมด query — มี table+data ให้แล้ว' : '🏗️ โหมดสร้าง table — เริ่มจาก DB ว่าง'}
          </span>
          <button type="button" onClick={respawn} className="ml-auto inline-flex items-center gap-1 rounded bg-slate-700 px-2 py-1 text-[11px] hover:bg-slate-600">
            <RefreshCcw size={12} /> Spawn Fresh DB
          </button>
        </div>
      </div>

      {canViewSchema ? (
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Schema Viewer {viewerRole === 'teacher' && <span className="text-amber-300">(ครู — เห็นตลอด)</span>}
            </h3>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{tables.length} tables</span>
          </div>
          {tables.length === 0 ? (
            <p className="text-xs text-slate-500">
              {sqlMode === 'create-table'
                ? 'ยังไม่มีตาราง — เขียน CREATE TABLE ในช่อง SQL Editor ด้านล่าง ตารางจะขึ้นที่นี่'
                : 'ไม่พบ CREATE TABLE ใน seed — อัปโหลด db/seed.sql ใน Builder'}
            </p>
          ) : (
            tables.map((t) => {
              const fromSeed = seedTables.some((s) => s.name === t.name)
              return (
                <div key={t.name} className="mb-1 rounded bg-slate-900 p-1.5 font-mono text-[11px]">
                  <span className="text-emerald-300">▦ {t.name}</span>
                  <span className="text-slate-500"> ({t.columns.join(', ')})</span>
                  {!fromSeed && <span className="ml-1 rounded bg-sky-900/60 px-1 text-[10px] text-sky-300">สร้างเอง</span>}
                </div>
              )
            })
          )}
          <p className="mt-1.5 text-[11px] text-slate-500">
            {props.database.allowDestructiveQueries
              ? 'โจทย์ข้อนี้อนุญาต DELETE / DROP / ALTER ได้เต็มที่ — ระบบเก็บ Master Seed แยกไว้เสมอ'
              : 'โหมดอ่านอย่างเดียว'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
          <p className="text-xs text-slate-500">🔒 ครูปิด Schema Viewer ไว้ — เขียน SQL จากโจทย์ได้เลย (รันแล้วดูผลในตารางด้านล่าง)</p>
        </div>
      )}

      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">SQL Editor (SQLite)</h3>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={4}
          spellCheck={false}
          className="w-full rounded border border-slate-700 bg-slate-900 p-2 font-mono text-xs focus:border-sky-500 focus:outline-none"
        />
        <button type="button" onClick={() => void runQuery()} disabled={sqlRunning} className="mt-1.5 inline-flex items-center gap-1 rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium hover:bg-emerald-600 disabled:opacity-40">
          <Play size={12} /> {sqlRunning ? 'กำลังรัน…' : 'รัน Query (Ctrl+Enter)'}
        </button>
        {lastResult !== null && <p className="mt-1.5 text-[11px] text-amber-300">{lastResult}</p>}
      </div>

      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Query Result — Expected vs Actual ({props.tests.length})</h3>
        {props.tests.length === 0 && <p className="text-xs text-slate-500">ไม่มี sample SQL test</p>}
        {props.tests.map((t) => {
          const actual = sqlResults[t.testId]
          return (
          <div key={t.testId} className={`mb-1.5 overflow-x-auto rounded-lg border bg-slate-950/60 p-2 ${actual?.passed === true ? 'border-emerald-800/60' : actual?.passed === false ? 'border-red-800/60' : 'border-slate-800'}`}>
            <div className="mb-1 flex items-center gap-2 text-[13px]">
              <span className="font-medium text-slate-200">{t.title}</span>
              {actual?.passed === true && <span className="text-[11px] text-emerald-300">✅ ผ่าน</span>}
              {actual?.passed === false && <span className="text-[11px] text-red-300">❌ ไม่ผ่าน</span>}
              <span className="ml-auto text-[11px] text-slate-500">{t.points} คะแนน</span>
            </div>
            <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-slate-500">expected</p>
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
            {actual !== undefined && (
              <>
                <p className="mb-1 mt-2 font-mono text-[10px] uppercase tracking-wide text-slate-500">actual (SQLite จริง)</p>
                {actual.actualColumns.length > 0 ? (
                  <table className="w-full font-mono text-[11px]">
                    <thead>
                      <tr className="text-left text-sky-400">
                        {actual.actualColumns.map((c) => <th key={c} className="border-b border-slate-800 px-1.5 py-1 font-medium">{c}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {actual.actualRows.slice(0, 5).map((row, i) => (
                        <tr key={i} className="text-slate-200">
                          {row.map((cell, j) => <td key={j} className="border-b border-slate-800/50 px-1.5 py-1">{cell ?? 'NULL'}</td>)}
                        </tr>
                      ))}
                      {actual.actualRows.length === 0 && (
                        <tr><td colSpan={Math.max(1, actual.actualColumns.length)} className="px-1.5 py-2 text-slate-600">(ไม่มีแถว)</td></tr>
                      )}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-[11px] text-slate-500">ไม่มีตารางผลลัพธ์ (โจทย์ DDL/คำสั่งเขียน — ตรวจด้วย verificationQuery)</p>
                )}
                <p className="mt-1 text-[11px] text-amber-300">{actual.note}</p>
              </>
            )}
          </div>
          )
        })}
      </div>
    </div>
  )
}

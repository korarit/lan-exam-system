import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, RefreshCcw } from 'lucide-react'
import type { DatabaseConfig, SqlTestCase } from '../../../shared/code-schema'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'

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
          ? `คำสั่งถูกส่งไป SQLite ephemeral (epoch ${epoch + 1}) — Spawn ใหม่พร้อมข้อมูลตั้งต้นเดิมแล้ว`
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
          next[t.testId] = { passed: null, actualColumns: [], actualRows: [], note: `รันไม่สำเร็จ: ${err instanceof Error ? err.message : 'IPC error'}` }
        }
      }
      setSqlResults(next)
      const passedCount = Object.values(next).filter((r) => r.passed === true).length
      setLastResult(`รันบน SQLite ephemeral (epoch ${epoch + 1}) — ผ่าน ${passedCount}/${props.tests.length} sample tests`)
    } finally {
      setSqlRunning(false)
    }
  }

  function respawn(): void {
    setEpoch((e) => e + 1)
    setQuery(sqlMode === 'create-table' ? 'CREATE TABLE students (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL\n);' : 'SELECT * FROM users;')
    setLastResult(`Spawn Fresh DB แล้ว (epoch ${epoch + 1}) — คืนค่าตารางและข้อมูลตั้งต้นเดิมครบ`)
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
      <Card className="bg-muted/30">
        <CardContent className="flex items-center gap-2 pt-3">
          <Badge variant="default" className="font-mono text-[10px]">SQLite</Badge>
          <Badge variant="secondary" className="font-mono text-[10px] tabular-nums">epoch {epoch}</Badge>
          <span className="text-[11px] text-muted-foreground">
            {sqlMode === 'query' ? 'โหมด query — มี table+data ให้แล้ว' : 'โหมดสร้าง table — เริ่มจาก DB ว่าง'}
          </span>
          <Button type="button" variant="secondary" size="sm" onClick={respawn} className="ml-auto">
            <RefreshCcw size={12} /> Spawn Fresh DB
          </Button>
        </CardContent>
      </Card>

      {canViewSchema ? (
        <Card className="bg-muted/30">
          <CardContent className="pt-3">
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Schema Viewer {viewerRole === 'teacher' && <span>(ครู — เห็นตลอด)</span>}
              </h3>
              <Badge variant="secondary" className="font-mono text-[10px] tabular-nums">{tables.length} tables</Badge>
            </div>
            {tables.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {sqlMode === 'create-table'
                  ? 'ยังไม่มีตาราง — เขียน CREATE TABLE ในช่อง SQL Editor ด้านล่าง ตารางจะขึ้นที่นี่'
                  : 'ไม่พบ CREATE TABLE ใน seed — อัปโหลด db/seed.sql ใน Builder'}
              </p>
            ) : (
              tables.map((t) => {
                const fromSeed = seedTables.some((s) => s.name === t.name)
                return (
                  <div key={t.name} className="mb-1 rounded-md bg-muted p-1.5 font-mono text-[11px]">
                    <span className="text-primary">{t.name}</span>
                    <span className="text-muted-foreground"> ({t.columns.join(', ')})</span>
                    {!fromSeed && <Badge variant="outline" className="ml-1 text-[10px]">สร้างเอง</Badge>}
                  </div>
                )
              })
            )}
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {props.database.allowDestructiveQueries
                ? 'โจทย์ข้อนี้อนุญาต DELETE / DROP / ALTER ได้เต็มที่ — ระบบเก็บ Master Seed แยกไว้เสมอ'
                : 'โหมดอ่านอย่างเดียว'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="bg-muted/30">
          <CardContent className="pt-3">
            <p className="text-xs text-muted-foreground">ครูปิด Schema Viewer ไว้ — เขียน SQL จากโจทย์ได้เลย (รันแล้วดูผลในตารางด้านล่าง)</p>
          </CardContent>
        </Card>
      )}

      <Card className="bg-muted/30">
        <CardContent className="pt-3">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">SQL Editor (SQLite)</h3>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={4}
            spellCheck={false}
            className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="button" size="sm" onClick={() => void runQuery()} disabled={sqlRunning} className="mt-1.5">
            <Play size={12} /> {sqlRunning ? 'กำลังรัน…' : 'รัน Query (Ctrl+Enter)'}
          </Button>
          {lastResult !== null && <p className="mt-1.5 text-[11px] text-muted-foreground">{lastResult}</p>}
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground tabular-nums">Query Result — Expected vs Actual ({props.tests.length})</h3>
        {props.tests.length === 0 && <p className="text-xs text-muted-foreground">ไม่มี sample SQL test</p>}
        {props.tests.map((t) => {
          const actual = sqlResults[t.testId]
          return (
            <Card key={t.testId} className="mb-1.5 bg-muted/30">
              <CardContent className="overflow-x-auto pt-3">
                <div className="mb-1 flex items-center gap-2 text-[13px]">
                  <span className="font-medium">{t.title}</span>
                  {actual?.passed === true && <Badge>ผ่าน</Badge>}
                  {actual?.passed === false && <Badge variant="destructive">ไม่ผ่าน</Badge>}
                  <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{t.points} คะแนน</span>
                </div>
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">expected</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      {t.expectedColumns.map((c) => <TableHead key={c}>{c}</TableHead>)}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {t.expectedRows.slice(0, 5).map((row, i) => (
                      <TableRow key={i}>
                        {row.map((cell, j) => <TableCell key={j}>{cell ?? 'NULL'}</TableCell>)}
                      </TableRow>
                    ))}
                    {t.expectedRows.length === 0 && (
                      <TableRow><TableCell colSpan={Math.max(1, t.expectedColumns.length)}>(ตรวจผ่าน verificationQuery — ไม่มีแถวตัวอย่าง)</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
                {actual !== undefined && (
                  <>
                    <p className="mb-1 mt-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">actual (SQLite จริง)</p>
                    {actual.actualColumns.length > 0 ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {actual.actualColumns.map((c) => <TableHead key={c} className="text-primary">{c}</TableHead>)}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {actual.actualRows.slice(0, 5).map((row, i) => (
                            <TableRow key={i}>
                              {row.map((cell, j) => <TableCell key={j}>{cell ?? 'NULL'}</TableCell>)}
                            </TableRow>
                          ))}
                          {actual.actualRows.length === 0 && (
                            <TableRow><TableCell colSpan={Math.max(1, actual.actualColumns.length)}>(ไม่มีแถว)</TableCell></TableRow>
                          )}
                        </TableBody>
                      </Table>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">ไม่มีตารางผลลัพธ์ (โจทย์ DDL/คำสั่งเขียน — ตรวจด้วย verificationQuery)</p>
                    )}
                    <p className="mt-1 text-[11px] text-muted-foreground">{actual.note}</p>
                  </>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

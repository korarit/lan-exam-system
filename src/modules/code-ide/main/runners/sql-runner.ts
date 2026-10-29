import { checkMysqlPortReachable } from '../mysql-connection'
import type { DatabaseConfig, SqlTestCase } from '../../shared/code-schema'

/* Phase 9 (9.4.4) — SQL Runner
 * - sqlite: better-sqlite3 in-memory + spawn ใหม่ทุก test (Master Seed → ephemeral)
 * - mysql: preflight TCP check (host:port) ก่อน — query จริงต้องใช้ driver ฝั่ง Main (Phase 10)
 */

export interface SqlRunResult {
  testId: string
  passed: boolean | null
  actualColumns: string[]
  actualRows: unknown[][]
  note: string
}

function normalizeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' || typeof v === 'string') return v
  return String(v)
}

export async function runSqliteTest(
  seedSql: string,
  studentSql: string,
  test: SqlTestCase
): Promise<SqlRunResult> {
  try {
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(':memory:')
    try {
      db.exec('PRAGMA foreign_keys = ON')
      // กัน ATTACH — กระโดดออกนอก DB ไม่ได้
      db.exec(seedSql === '' ? 'CREATE TABLE IF NOT EXISTS _noop(id INTEGER);' : seedSql)
      if ((test.setupSqlOverride ?? '').trim() !== '') db.exec(test.setupSqlOverride as string)
      const trimmed = studentSql.trim()
      if (trimmed !== '') {
        const isSelect = /^\s*(SELECT|WITH)\b/i.test(trimmed)
        if (isSelect) {
          const stmt = db.prepare(trimmed)
          const cols = stmt.columns().map((c: { name: string }) => c.name)
          const rows = (stmt.all() as Array<Record<string, unknown>>).map((r) => cols.map((c) => normalizeCell(r[c])))
          return compare(test, cols, rows, 'รัน SELECT ของนักเรียน')
        }
        db.exec(trimmed)
      }
      if ((test.verificationQuery ?? '').trim() !== '') {
        const stmt = db.prepare(test.verificationQuery as string)
        const cols = stmt.columns().map((c: { name: string }) => c.name)
        const rows = (stmt.all() as Array<Record<string, unknown>>).map((r) => cols.map((c) => normalizeCell(r[c])))
        return compare(test, cols, rows, 'รันคำสั่งนักเรียนแล้วตรวจด้วย verificationQuery')
      }
      return { testId: test.testId, passed: null, actualColumns: [], actualRows: [], note: 'ไม่มี SELECT/verificationQuery — ตั้งโจทย์เฉย ๆ ไม่ตรวจ' }
    } finally {
      try { db.close() } catch { /* noop */ }
    }
  } catch (err) {
    return { testId: test.testId, passed: false, actualColumns: [], actualRows: [], note: `⛔ SQLite error: ${err instanceof Error ? err.message : 'unknown'}` }
  }
}

function compare(test: SqlTestCase, cols: string[], rows: unknown[][], note: string): SqlRunResult {
  const expCols = test.expectedColumns
  const colOk = test.checkColumnOrder
    ? JSON.stringify(cols) === JSON.stringify(expCols)
    : expCols.every((c) => cols.includes(c)) && cols.length === expCols.length
  const norm = (r: unknown[][]): string => JSON.stringify(test.checkRowOrder ? r : [...r].map((x) => JSON.stringify(x)).sort())
  const rowOk = norm(rows.map((r) => r.map(normalizeCell))) === norm(test.expectedRows as unknown[][])
  const passed = colOk && rowOk
  return {
    testId: test.testId, passed, actualColumns: cols, actualRows: rows,
    note: passed ? `✅ ผ่าน — ${note}` : `❌ ไม่ตรง (คอลัมน์ ${colOk ? 'ถูก' : 'ผิด'} / แถว ${rowOk ? 'ถูก' : 'ผิด'})`
  }
}

export async function runMysqlPreflight(
  database: DatabaseConfig,
  test: SqlTestCase
): Promise<SqlRunResult> {
  const reach = await checkMysqlPortReachable(database.host, database.port, 3000)
  if (!reach.ok) {
    return { testId: test.testId, passed: false, actualColumns: [], actualRows: [], note: reach.message }
  }
  if (database.databaseName.trim() === '') {
    return { testId: test.testId, passed: false, actualColumns: [], actualRows: [], note: '⛔ ยังไม่ใส่ database name (ใส่ exam_db — ไม่ใช่ชื่อตาราง users)' }
  }
  // Query จริงต้องใช้ mysql driver (แนะนำ mysql2) ฝั่ง Main — ตอนนี้คืน preflight ว่าพร้อม
  return {
    testId: test.testId, passed: null, actualColumns: [], actualRows: [],
    note: `🔌 ${reach.message} — พร้อมยิง query ไป ${database.host}:${database.port}/${database.databaseName} (รันจริงผูก mysql driver ใน Phase 10)`
  }
}

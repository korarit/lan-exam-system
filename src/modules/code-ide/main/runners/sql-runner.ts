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

/** เปรียบเทียบผล SELECT กับ expected — ใช้ร่วมกับ grader ตรวจ verifyDb หลังยิง API */
export function compareSqlResult(
  expectedColumns: string[],
  expectedRows: unknown[][],
  checkColumnOrder: boolean,
  checkRowOrder: boolean,
  actualColumns: string[],
  actualRows: unknown[][]
): { passed: boolean; columnOk: boolean; rowOk: boolean } {
  const colOk = checkColumnOrder
    ? JSON.stringify(actualColumns) === JSON.stringify(expectedColumns)
    : expectedColumns.every((c) => actualColumns.includes(c)) && actualColumns.length === expectedColumns.length
  const norm = (r: unknown[][]): string =>
    JSON.stringify(checkRowOrder ? r : [...r].map((x) => JSON.stringify(x)).sort())
  const rowOk = norm(actualRows.map((r) => r.map(normalizeCell))) === norm(expectedRows as unknown[][])
  return { passed: colOk && rowOk, columnOk: colOk, rowOk: rowOk }
}

function compare(test: SqlTestCase, cols: string[], rows: unknown[][], note: string): SqlRunResult {
  const { passed, columnOk, rowOk } = compareSqlResult(
    test.expectedColumns,
    test.expectedRows as unknown[][],
    test.checkColumnOrder,
    test.checkRowOrder,
    cols,
    rows
  )
  return {
    testId: test.testId, passed, actualColumns: cols, actualRows: rows,
    note: passed ? `✅ ผ่าน — ${note}` : `❌ ไม่ตรง (คอลัมน์ ${columnOk ? 'ถูก' : 'ผิด'} / แถว ${rowOk ? 'ถูก' : 'ผิด'})`
  }
}

/**
 * รัน SQL ตามใจครูบนฐานข้อมูลจำลอง (Inspector SQL Workbench):
 * seed ใหม่ทุกครั้ง + รัน studentSql ของนักเรียนก่อน (ถ้ามี) แล้วรัน query ของครู
 * คืนคอลัมน์/แถวจริง (cap 200 แถว) — ไม่ตรวจให้คะแนน
 */
export async function queryStudentDatabase(
  seedSql: string,
  studentSql: string,
  teacherSql: string,
  limit = 200
): Promise<{ columns: string[]; rows: unknown[][]; note: string }> {
  try {
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(':memory:')
    try {
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(seedSql === '' ? 'CREATE TABLE IF NOT EXISTS _noop(id INTEGER);' : seedSql)
      const trimmedStudent = studentSql.trim()
      if (trimmedStudent !== '' && !/^\s*(SELECT|WITH)\b/i.test(trimmedStudent)) {
        db.exec(trimmedStudent)
      }
      const trimmed = teacherSql.trim()
      if (trimmed === '') return { columns: [], rows: [], note: 'พิมพ์ SQL แล้วกดรัน' }
      if (/^\s*ATTACH\b/i.test(trimmed)) {
        return { columns: [], rows: [], note: '⛔ บล็อก ATTACH — กระโดดออกนอก DB ไม่ได้' }
      }
      if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(trimmed)) {
        const stmt = db.prepare(trimmed)
        const cols = stmt.columns().map((c: { name: string }) => c.name)
        const all = (stmt.all() as Array<Record<string, unknown>>).map((r) => cols.map((c) => normalizeCell(r[c])))
        return {
          columns: cols.slice(0, 64),
          rows: all.slice(0, limit).map((r) => r.slice(0, 64)),
          note: `✅ ${all.length} แถว${all.length > limit ? ` (แสดง ${limit} แรก)` : ''}`
        }
      }
      db.exec(trimmed)
      return { columns: [], rows: [], note: '✅ รันคำสั่งแก้ไขแล้ว — พิมพ์ SELECT ดูผล' }
    } finally {
      try {
        db.close()
      } catch {
        /* noop */
      }
    }
  } catch (err) {
    return { columns: [], rows: [], note: `⛔ SQLite error: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}` }
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

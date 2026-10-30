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

/* ============================================================
 * Phase 11 (11.2.2) — SQL Heavy Query Timeout Guard
 * better-sqlite3 เป็น synchronous API และไม่มี db.interrupt()
 * ในเวอร์ชันที่ใช้ จึงรัน query ใน worker thread แยกแล้ว terminate
 * เมื่อเกิน timeoutMs — กัน Recursive CTE ไม่รู้จบ / Cross Join
 * ยักษ์ค้างโปรเซสหลักของเครื่องแม่/เครื่องนักเรียน
 * (return type เดิม SqlRunResult — แทน runSqliteTest ได้ทันที)
 * ============================================================ */

interface SqlWorkerOut {
  mode: 'select' | 'verified' | 'none' | 'timeout'
  cols: string[]
  rows: unknown[][]
}

/* หมายเหตุการออกแบบ (Phase 11.2.2):
 * - better-sqlite3 ไม่มี db.interrupt() และ stmt.all()/db.exec() ที่ไม่รู้จบ
 *   คือ synchronous native call — worker.terminate() จากข้างนอกค้างตามได้
 *   เพราะ V8 แทรก termination ไม่ได้กลาง native call
 * - ทางออก: worker อ่านทีละแถวด้วย stmt.iterate() แล้วเช็ค deadline
 *   เองระหว่างแถว (JS ได้รันทุกแถว) — เจอ query ไม่รู้จบก็ post timeout
 *   แล้วจบตัวเองสะอาด ไม่ต้องพึ่ง terminate
 * - timer ฝั่ง main + terminate (แบบ race ไม่รอค้าง) เป็น backstop สำหรับ
 *   เคส exec หนักที่เป็น native call เดียว (เช่น DML พ่วง CTE ไม่รู้จบ)
 */
const SQL_WORKER_CODE = `
const { parentPort, workerData } = require('worker_threads');
(function main() {
  try {
    const D = require(workerData.bindingPath);
    const deadline = Date.now() + workerData.timeoutMs;
    const db = new D(':memory:');
    const timedOut = () => Date.now() > deadline;
    function collect(stmt, cols) {
      const rows = [];
      for (const r of stmt.iterate()) {
        rows.push(cols.map((c) => (r[c] === undefined ? null : r[c])));
        if (rows.length >= 5000) break;
        if (timedOut()) return { timeout: true, rows };
      }
      return { timeout: false, rows };
    }
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(workerData.seedSql === '' ? 'CREATE TABLE IF NOT EXISTS _noop(id INTEGER);' : workerData.seedSql);
      if (workerData.setupSqlOverride.trim() !== '') db.exec(workerData.setupSqlOverride);
      const trimmed = workerData.studentSql.trim();
      if (trimmed !== '' && /^\\s*(SELECT|WITH)\\b/i.test(trimmed)) {
        const stmt = db.prepare(trimmed);
        const cols = stmt.columns().map((c) => c.name);
        const got = collect(stmt, cols);
        if (got.timeout) parentPort.postMessage({ mode: 'timeout', cols, rows: [] });
        else parentPort.postMessage({ mode: 'select', cols, rows: got.rows });
      } else {
        if (trimmed !== '') db.exec(trimmed);
        if (workerData.verificationQuery.trim() !== '') {
          const stmt = db.prepare(workerData.verificationQuery);
          const cols = stmt.columns().map((c) => c.name);
          const got = collect(stmt, cols);
          if (got.timeout) parentPort.postMessage({ mode: 'timeout', cols, rows: [] });
          else parentPort.postMessage({ mode: 'verified', cols, rows: got.rows });
        } else {
          parentPort.postMessage({ mode: 'none', cols: [], rows: [] });
        }
      }
    } finally {
      try { db.close(); } catch (_) { /* noop */ }
    }
  } catch (err) {
    parentPort.postMessage({ error: err instanceof Error ? err.message : 'worker failed' });
  }
})();
`;

export async function runSqliteTestWithTimeout(
  seedSql: string,
  studentSql: string,
  test: SqlTestCase
): Promise<SqlRunResult> {
  // กัน ATTACH กระโดดออกนอก DB (เดิมมีแค่ใน workbench — รวมไว้ที่นี่ด้วย)
  if (/^\s*ATTACH\b/i.test(studentSql.trim())) {
    return { testId: test.testId, passed: false, actualColumns: [], actualRows: [], note: '⛔ บล็อก ATTACH — กระโดดออกนอก DB ไม่ได้' }
  }
  let bindingPath: string
  try {
    // หมายเหตุ: ไฟล์นี้ถูก vite transform เป็น ESM — ใช้ createRequire แทน require ตรง ๆ
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    bindingPath = req.resolve('better-sqlite3') as string
  } catch {
    return runSqliteTest(seedSql, studentSql, test)
  }
  let WorkerCtor: typeof import('node:worker_threads').Worker
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    WorkerCtor = (req('node:worker_threads') as typeof import('node:worker_threads')).Worker
  } catch {
    return runSqliteTest(seedSql, studentSql, test)
  }
  let worker: import('node:worker_threads').Worker
  try {
    worker = new WorkerCtor(SQL_WORKER_CODE, {
      eval: true,
      workerData: {
        bindingPath,
        seedSql,
        setupSqlOverride: test.setupSqlOverride ?? '',
        studentSql,
        verificationQuery: test.verificationQuery ?? '',
        timeoutMs: Math.max(100, Math.min(test.timeoutMs, 60_000))
      }
    })
  } catch {
    return runSqliteTest(seedSql, studentSql, test)
  }
  const timeoutMs = Math.max(100, Math.min(test.timeoutMs, 60_000))
  try {
    const out = await new Promise<SqlWorkerOut>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('SQL_TIMEOUT'))
      }, timeoutMs + 2000)
      // กัน timer ค้าง event loop หลัง worker จบ
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        ;(timer as unknown as { unref: () => void }).unref()
      }
      worker.once('message', (msg: unknown) => {
        clearTimeout(timer)
        if (typeof msg === 'object' && msg !== null && 'error' in msg) {
          reject(new Error(String((msg as { error: unknown }).error).slice(0, 300)))
          return
        }
        resolve(msg as SqlWorkerOut)
      })
      worker.once('error', (err: Error) => {
        clearTimeout(timer)
        reject(err)
      })
      worker.once('exit', (code: number) => {
        clearTimeout(timer)
        if (code !== 0) reject(new Error(`SQL_WORKER_EXIT_${code}`))
      })
    })
    if (out.mode === 'timeout') {
      return { testId: test.testId, passed: false, actualColumns: [], actualRows: [], note: `⏱️ หมดเวลา ${timeoutMs}ms (ตัดจบ query แล้ว — สงสัย Recursive CTE / Cross Join ยักษ์)` }
    }
    if (out.mode === 'select') return compare(test, out.cols, out.rows, 'รัน SELECT ของนักเรียน')
    if (out.mode === 'verified') {
      return compare(test, out.cols, out.rows, 'รันคำสั่งนักเรียนแล้วตรวจด้วย verificationQuery')
    }
    return { testId: test.testId, passed: null, actualColumns: [], actualRows: [], note: 'ไม่มี SELECT/verificationQuery — ตั้งโจทย์เฉย ๆ ไม่ตรวจ' }
  } catch (err) {
    if (err instanceof Error && err.message === 'SQL_TIMEOUT') {
      return { testId: test.testId, passed: false, actualColumns: [], actualRows: [], note: `⏱️ หมดเวลา ${timeoutMs}ms (ตัดจบ query แล้ว — สงสัย Recursive CTE / Cross Join ยักษ์)` }
    }
    return { testId: test.testId, passed: false, actualColumns: [], actualRows: [], note: `⛔ SQLite error: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}` }
  } finally {
    try {
      // terminate อาจค้างถ้า worker ติดใน native call เดียวที่ไม่รู้จบ —
      // รอแบบ race แล้วปล่อย (worker กรณี SELECT ออกเองทาง deadline อยู่แล้ว)
      await Promise.race([
        worker.terminate(),
        new Promise((resolve) => setTimeout(resolve, 3000))
      ])
    } catch {
      /* ปิดไม่ได้ — GC จัดการ */
    }
  }
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

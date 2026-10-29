import fs from 'node:fs'
import type { IpcRouter } from './router'
import type {
  CodeIdeRunCliResponse,
  CodeIdeRunSqlResponse,
  CodeIdeCheckRuntimesResponse,
  CodeIdeAddSdkPathResponse,
  CodeIdeBrowseSdkPathResponse
} from '@shared/ipc-channels'
import {
  VirtualEntrySchema,
  CliTestCaseSchema,
  SqlTestCaseSchema,
  SupportedCodeLanguageSchema
} from '@modules/code-ide/shared/code-schema'
import { runCliTest } from '@modules/code-ide/main/runners/cli-runner'
import { runSqliteTest } from '@modules/code-ide/main/runners/sql-runner'
import {
  discoverRuntimes,
  runtimesForLanguage,
  setCustomSdkPath,
  getCustomSdkPath,
  checkRuntime
} from '@modules/code-ide/main/runtime-locator'

/* ============================================================
 * Phase 9 — IPC ของโมดูล code-ide (Local Runtime)
 * - code-ide:run-cli       รัน 1 CLI sample test ด้วยโค้ดปัจจุบันของนักเรียนบนเครื่องตัวเอง
 * - code-ide:run-sql       รัน 1 SQL sample test ด้วย query ปัจจุบันบน SQLite ephemeral
 * - code-ide:check-runtimes เช็คว่า runtime ของภาษาที่ใช้มีในเครื่องไหม
 * - code-ide:browse-sdk-path เปิด dialog เลือกโฟลเดอร์ SDK ที่ติดตั้งเอง
 * - code-ide:add-sdk-path  ลงทะเบียนโฟลเดอร์ SDK + ตรวจว่ามี binary จริง
 * ไม่จำกัด role: นักเรียนรันบนเครื่องตัวเอง, ครูรันพรีวิว/ตรวจบนเครื่องแม่
 * ============================================================ */

function toCell(v: unknown): string | number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') return v.slice(0, 2000)
  return String(v).slice(0, 2000)
}

export function registerCodeIdeHandlers(router: IpcRouter): void {
  router.register('code-ide:run-cli', async (req): Promise<CodeIdeRunCliResponse> => {
    // เติม defaults ผ่าน schema ของโมดูล (request ใน ipc-channels ตั้งใจให้เป็น optional)
    const entries = req.entries.map((e) => VirtualEntrySchema.parse(e))
    const language = SupportedCodeLanguageSchema.parse(req.language)
    const test = CliTestCaseSchema.parse(req.test)
    // Custom SDK path ที่ผู้ใช้ Browse เองต้องมีผลตอนรันด้วย — เติมนำหน้า PATH
    const { getRuntimePathEntries } = await import('@modules/code-ide/main/runtime-locator')
    // F-3: ถ้าเครื่องนี้แคช DependencyBundle ของโจทย์ข้อนี้ไว้แล้ว ลิงก์เข้า sandbox ด้วย
    const { getStudentDepsLayout } = await import('@modules/code-ide/main/code-deps-cache')
    const cached = req.packageId !== undefined ? getStudentDepsLayout(req.packageId) : undefined
    const r = await runCliTest(entries, language, req.entryPointPath, test, {
      extraPathDirs: getRuntimePathEntries(runtimesForLanguage(language)),
      ...(cached !== undefined ? { depsCache: cached } : {})
    })
    const res: CodeIdeRunCliResponse = {
      testId: r.testId,
      passed: r.passed,
      actualStdout: r.actualStdout.slice(0, 25_000),
      stderr: r.stderr.slice(0, 6_000),
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      note: r.note.slice(0, 500)
    }
    if (r.blockedReason !== undefined) res.blockedReason = r.blockedReason.slice(0, 500)
    return res
  })

  router.register('code-ide:run-sql', async (req): Promise<CodeIdeRunSqlResponse> => {
    const test = SqlTestCaseSchema.parse(req.test)
    const r = await runSqliteTest(req.seedSql, req.studentSql, test)
    const rows = r.actualRows.slice(0, 200).map((row) => row.slice(0, 64).map(toCell))
    return {
      testId: r.testId,
      passed: r.passed,
      actualColumns: r.actualColumns.slice(0, 64),
      actualRows: rows,
      note:
        r.actualRows.length > 200
          ? `${r.note.slice(0, 400)} (แสดง 200 แถวแรกจากทั้งหมด ${r.actualRows.length} แถว)`
          : r.note.slice(0, 500)
    }
  })

  router.register('code-ide:check-runtimes', async (req): Promise<CodeIdeCheckRuntimesResponse> => {
    const needed = [...new Set(req.languages.flatMap((l) => runtimesForLanguage(l)))]
    if (needed.length === 0) return { runtimes: [] }
    const found = await discoverRuntimes(needed)
    return {
      runtimes: needed.map((name) => {
        const info = found[name]!
        const customPath = getCustomSdkPath(name)
        const status = { name, found: info.found, hint: info.found ? '' : info.hint }
        return {
          ...status,
          ...(info.version !== undefined ? { version: info.version } : {}),
          ...(info.path !== undefined ? { path: info.path } : {}),
          ...(customPath !== undefined ? { customPath } : {})
        }
      })
    }
  })

  router.register('code-ide:browse-sdk-path', async (req): Promise<CodeIdeBrowseSdkPathResponse> => {
    try {
      const { dialog } = await import('electron')
      const picked = await dialog.showOpenDialog({
        title: req.title ?? 'เลือกโฟลเดอร์ที่ติดตั้ง Runtime/SDK ไว้',
        properties: ['openDirectory']
      })
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: false, reason: 'CANCELLED' }
      }
      return { ok: true, dirPath: picked.filePaths[0] }
    } catch {
      return { ok: false, reason: 'DIALOG_FAILED' }
    }
  })

  router.register('code-ide:add-sdk-path', async (req): Promise<CodeIdeAddSdkPathResponse> => {
    const dir = req.dirPath.trim()
    try {
      if (!fs.statSync(dir).isDirectory()) return { ok: false, reason: 'NOT_A_DIRECTORY' }
    } catch {
      return { ok: false, reason: 'NOT_A_DIRECTORY' }
    }
    setCustomSdkPath(req.runtime, dir)
    // ตรวจทันทีว่ามี binary ของ runtime นั้นในโฟลเดอร์จริง (พร้อมใช้ทันทีกด Re-scan)
    const info = await checkRuntime(req.runtime)
    if (info.found && info.path !== undefined && info.path.startsWith(dir)) {
      return { ok: true, version: info.version ?? '' }
    }
    return { ok: false, reason: `NO_RUNTIME_BINARY (ไม่พบ ${req.runtime} ใน ${dir} — เลือกโฟลเดอร์ bin ที่มีตัว runtime อยู่)` }
  })

  /* F-3: เครื่องนักเรียนแคช DependencyBundle blobs จาก stripped view (ตรวจ sha256 ก่อนแตก) */
  router.register('code-ide:cache-student-bundles', async (req) => {
    try {
      const { ensureStudentBundleCache } = await import('@modules/code-ide/main/code-deps-cache')
      const { layout } = ensureStudentBundleCache({
        packageId: req.packageId,
        dependencies: req.dependencies,
        blobs: req.blobs
      })
      return { ok: true, cached: true, unsupported: layout.unsupported }
    } catch (err) {
      return {
        ok: false,
        cached: false,
        unsupported: [],
        reason: err instanceof Error ? err.message.slice(0, 120) : 'CACHE_FAILED'
      }
    }
  })

  /* F-3b: สถานะ deps ของโจทย์ข้อนี้บนเครื่องนี้ (blob cache / ติดตั้งเอง) */
  router.register('code-ide:student-deps-status', async (req) => {
    const { getStudentDepsLayout } = await import('@modules/code-ide/main/code-deps-cache')
    return { cached: getStudentDepsLayout(req.packageId) !== undefined }
  })

  /* F-3b: เครื่องนักเรียน pip/npm install เอง (ครู opt-in — รายชื่อ exact ที่ครูอนุมัติเท่านั้น) */
  router.register('code-ide:install-student-deps', async (req) => {
    try {
      const { installStudentPackages } = await import('@modules/code-ide/main/student-deps-installer')
      const r = await installStudentPackages({ packageId: req.packageId, packages: req.packages })
      if (!r.ok) {
        return { ok: false, installed: r.installed, note: r.note.slice(0, 1000), ...(r.reason !== undefined ? { reason: r.reason.slice(0, 200) } : {}) }
      }
      return { ok: true, installed: r.installed, note: r.note.slice(0, 1000) }
    } catch (err) {
      return {
        ok: false,
        installed: [],
        note: '',
        reason: err instanceof Error ? err.message.slice(0, 120) : 'INSTALL_FAILED'
      }
    }
  })
}

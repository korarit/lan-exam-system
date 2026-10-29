import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {
  typedInputsToStdin,
  type CliTestCase,
  type CodeExamPackage,
  type CodeTestCase,
  type DomTestCase,
  type HttpApiTestCase,
  type SqlTestCase,
  type SupportedCodeLanguage,
  type VirtualEntry
} from '../shared/code-schema'
import { materializeExecutionSandbox, teardownRunDir } from './workspace-materializer'
import { buildSandboxEnv, scanDestructiveCode } from './anti-delete-guard'
import { authorizedChildProcesses } from './authorized-process-registry'
import type { DepsCacheLayout } from './code-deps-cache'
import { runCliTest } from './runners/cli-runner'
import { bundleFrontend } from './runners/frontend-runner'
import { documentHtmlFor, runDomTest } from './runners/dom-runner'
import { allocateEphemeralPort, killProcessTree, runHttpTests, spawnServer, waitForPort } from './runners/backend-api-runner'
import { compareSqlResult, runSqliteTest } from './runners/sql-runner'
import { checkRuntime, getRuntimePathEntries, runtimesForLanguage } from './runtime-locator'

/* ============================================================
 * Phase 10 (10.2) — Multi-Stack Auto-Grading Queue (เครื่องแม่)
 * ตรวจโปรเจกต์นักเรียนกับ Hidden Test Cases ครบ 4 หมวด:
 * CLI / Frontend / Backend API / Database(SQLite)
 *
 * ความปลอดภัย:
 * - รันใน Isolated Run Directory (os.tmpdir) เท่านั้น ห้ามรันใน
 *   <TeacherSelectedFolder>/<studentId>/ โดยเด็ดขาด (คัดลอกก่อนรันเสมอ)
 * - สแกนโค้ดทำลายไฟล์ก่อนรัน (blocked → status 'blocked' + แจ้งครู)
 * - จำกัด concurrency ตามคอร์ CPU + แยกพอร์ต/ephemeral DB ต่อ worker
 * ============================================================ */

export interface GradeTestResult {
  testId: string
  kind: CodeTestCase['kind']
  visibility: 'sample' | 'hidden'
  points: number
  earned: number
  /** null = ตรวจอัตโนมัติไม่ได้ (ขาด runtime / ต้องตรวจด้วยตา) */
  passed: boolean | null
  note: string
  durationMs: number
}

export interface GradeReport {
  packageId: string
  studentId: string
  category: CodeExamPackage['category']
  language: SupportedCodeLanguage
  totalPoints: number
  earnedPoints: number
  passedCount: number
  totalCount: number
  results: GradeTestResult[]
  gradedAtMs: number
  blockedReason?: string | undefined
  runtimeMissing?: string[] | undefined
}

export interface GradeJobInput {
  examPackage: CodeExamPackage
  studentId: string
  entries: VirtualEntry[]
  /** กันรันในคลังงานครู: ถ้า runDir หลุดเข้าไปใต้ path นี้ให้ปฏิเสธทันที */
  teacherWorkspaceRoot?: string | undefined
  /** offline libs ที่แตกจาก blobs แล้ว (undefined = รันด้วยโค้ดนักเรียนล้วน) */
  depsCache?: DepsCacheLayout | undefined
}

/* ---------- Bounded Concurrency Worker Queue ---------- */

export function defaultMaxConcurrentRuns(): number {
  const cpus = typeof os.cpus === 'function' ? os.cpus().length : 4
  return Math.max(2, cpus - 2)
}

interface QueuedTask<T> {
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

export class GradingWorkerQueue {
  private running = 0
  private readonly pending: Array<QueuedTask<GradeReport>> = []

  constructor(private readonly maxConcurrent: number = defaultMaxConcurrentRuns()) {}

  get activeCount(): number {
    return this.running
  }

  get pendingCount(): number {
    return this.pending.length
  }

  enqueue(job: GradeJobInput): Promise<GradeReport> {
    return new Promise<GradeReport>((resolve, reject) => {
      this.pending.push({ task: () => gradeProject(job), resolve, reject })
      void this.pump()
    })
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.pending.length > 0) {
      const item = this.pending.shift()
      if (!item) return
      this.running += 1
      item
        .task()
        .then(item.resolve, item.reject)
        .finally(() => {
          this.running -= 1
          this.pump()
        })
    }
  }
}

/* ---------- Multi-Stack Grading Dispatch ---------- */

export async function gradeProject(job: GradeJobInput): Promise<GradeReport> {
  const started = Date.now()
  const { examPackage: pkg, studentId, entries } = job
  const empty: GradeReport = {
    packageId: pkg.packageId,
    studentId,
    category: pkg.category,
    language: pkg.language,
    totalPoints: 0,
    earnedPoints: 0,
    passedCount: 0,
    totalCount: pkg.testCases.length,
    results: [],
    gradedAtMs: started
  }

  // ชั้นที่ 3 ของ Anti-Delete Guard: สแกนก่อนรันทุกครั้ง (บนเครื่องแม่)
  const hits = scanDestructiveCode(entries)
  if (hits.length > 0) {
    const h = hits[0]!
    const reason = `🚫 [Runtime Guard] บล็อก ${h.path}:${h.line} (${h.pattern}) — ตรวจพบคำสั่งลบไฟล์/เรียก shell`
    return { ...empty, blockedReason: reason }
  }

  // แยกตาม kind ของ test (ไม่ใช่ category) — โจทย์ fullstack/mixed ที่มีหลาย kind ตรวจครบทุกตัว
  try {
    const cli = pkg.testCases.filter((t): t is CliTestCase => t.kind === 'stdio' || t.kind === 'unit-harness')
    const dom = pkg.testCases.filter((t): t is DomTestCase => t.kind === 'dom-assertion')
    const http = pkg.testCases.filter((t): t is HttpApiTestCase => t.kind === 'http-api')
    const sql = pkg.testCases.filter((t): t is SqlTestCase => t.kind === 'sql-query')
    const collect = { runtimeMissing: [] as string[] }
    const parts = await Promise.all([
      cli.length > 0
        ? gradeCliTests(pkg, entries, cli, job.teacherWorkspaceRoot, job.depsCache, collect)
        : [],
      dom.length > 0
        ? gradeDomTests(pkg, entries, dom, job.teacherWorkspaceRoot)
        : [],
      http.length > 0
        ? gradeBackendTests(pkg, entries, http, job.teacherWorkspaceRoot, job.depsCache, collect)
        : [],
      sql.length > 0
        ? gradeSqlTests(pkg, entries, sql)
        : []
    ])
    const results = parts.flat()
    // คงลำดับ test ตาม package (dashboard อ่านง่าย)
    const order = new Map(pkg.testCases.map((t, i) => [t.testId, i]))
    results.sort((a, b) => (order.get(a.testId) ?? 0) - (order.get(b.testId) ?? 0))
    const missing = [...new Set(collect.runtimeMissing)]
    return summarize(pkg, studentId, results, missing.length > 0 ? { runtimeMissing: missing } : {})
  } catch (err) {
    return {
      ...empty,
      results: [],
      gradedAtMs: Date.now(),
      blockedReason: `GRADER_ERROR: ${err instanceof Error ? err.message.slice(0, 300) : 'unknown'}`
    }
  }
}

function summarize(
  pkg: CodeExamPackage,
  studentId: string,
  results: GradeTestResult[],
  extra?: Partial<GradeReport>
): GradeReport {
  const earned = Math.round(results.reduce((s, r) => s + r.earned, 0) * 100) / 100
  const total = pkg.testCases.reduce((s, t) => s + t.points, 0)
  const passed = results.filter((r) => r.passed === true).length
  return {
    packageId: pkg.packageId,
    studentId,
    category: pkg.category,
    language: pkg.language,
    totalPoints: total,
    earnedPoints: earned,
    passedCount: passed,
    totalCount: pkg.testCases.length,
    results,
    gradedAtMs: Date.now(),
    ...extra
  }
}

function teacherOriginalsOf(pkg: CodeExamPackage): VirtualEntry[] {
  return pkg.entries.filter((e) => e.readOnly === true || e.hiddenFromStudent === true)
}

function assertOutsideVault(runDir: string, teacherWorkspaceRoot: string | undefined): void {
  if (!teacherWorkspaceRoot) return
  const root = path.resolve(teacherWorkspaceRoot) + path.sep
  const resolved = path.resolve(runDir)
  if (resolved === path.resolve(teacherWorkspaceRoot) || resolved.startsWith(root)) {
    throw new Error('VAULT_ISOLATION_VIOLATED: ห้ามรันโค้ดในคลังงานครู')
  }
}

/* ---------- หมวด CLI / Algorithm ---------- */

const INTERPRETED_CLI: SupportedCodeLanguage[] = ['python', 'javascript', 'php', 'python-backend']

async function gradeCliTests(
  pkg: CodeExamPackage,
  entries: VirtualEntry[],
  tests: CliTestCase[],
  teacherWorkspaceRoot: string | undefined,
  depsCache: DepsCacheLayout | undefined,
  collect: { runtimeMissing: string[] }
): Promise<GradeTestResult[]> {
  const extraPathDirs = getRuntimePathEntries(runtimesForLanguage(pkg.language))

  if (INTERPRETED_CLI.includes(pkg.language)) {
    const results: GradeTestResult[] = []
    for (const t of tests) {
      const started = Date.now()
      try {
        const r = await runCliTest(entries, pkg.language, pkg.policy.entryPointPath, t, {
          teacherOriginals: teacherOriginalsOf(pkg),
          extraPathDirs,
          ...(depsCache !== undefined ? { depsCache } : {})
        })
        results.push({
          testId: t.testId,
          kind: t.kind,
          visibility: t.visibility,
          points: t.points,
          earned: r.passed === true ? t.points : 0,
          passed: r.passed,
          note: r.blockedReason ?? r.note,
          durationMs: Date.now() - started
        })
      } catch (err) {
        results.push({
          testId: t.testId,
          kind: t.kind,
          visibility: t.visibility,
          points: t.points,
          earned: 0,
          passed: false,
          note: `⛔ รันไม่สำเร็จ: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
          durationMs: Date.now() - started
        })
      }
    }
    return results
  }

  // ภาษาคอมไพล์ (c/cpp/java/rust/go/typescript): คอมไพล์ครั้งเดียว แล้วรันทุก test
  return gradeCompiledCli(pkg, entries, tests, teacherWorkspaceRoot, extraPathDirs, depsCache, collect)
}

interface CompiledProgram {
  cmd: string
  args: (runDir: string) => string[]
  builtInDir: string
}

async function gradeCompiledCli(
  pkg: CodeExamPackage,
  entries: VirtualEntry[],
  tests: CliTestCase[],
  teacherWorkspaceRoot: string | undefined,
  extraPathDirs: string[],
  depsCache: DepsCacheLayout | undefined,
  collect: { runtimeMissing: string[] }
): Promise<GradeTestResult[]> {
  const mat = materializeExecutionSandbox(entries, {
    teacherOriginals: teacherOriginalsOf(pkg),
    ...(depsCache !== undefined ? { depsCache } : {})
  })
  const { runDir } = mat
  try {
    assertOutsideVault(runDir, teacherWorkspaceRoot)
    const program = await compileProgram(
      pkg.language,
      pkg.policy.entryPointPath,
      runDir,
      extraPathDirs,
      mat.javaCpExtras,
      mat.linkEnv
    )
    if (!program) {
      const missing = runtimesForLanguage(pkg.language)
      const results: GradeTestResult[] = tests.map((t) => ({
        testId: t.testId,
        kind: t.kind,
        visibility: t.visibility,
        points: t.points,
        earned: 0,
        passed: null,
        note: `⚠️ ตรวจอัตโนมัติไม่ได้ — เครื่องแม่ไม่มี runtime/compiler ของ ${pkg.language} (ติดตั้งแล้วกด Re-grade)`,
        durationMs: 0
      }))
      collect.runtimeMissing.push(...missing)
      return results
    }
    const results: GradeTestResult[] = []
    for (const t of tests) {
      const t0 = Date.now()
      const stdin = t.stdin.trim() !== '' ? t.stdin : typedInputsToStdin(t.inputs ?? [])
      const out = await spawnStdin(program.cmd, program.args(runDir), {
        cwd: runDir,
        env: buildSandboxEnv(runDir, mat.linkEnv),
        stdin,
        timeoutMs: t.timeoutMs,
        extraPathDirs
      })
      const norm = (s: string): string => s.replace(/\r\n/g, '\n').trim()
      const expected = norm(t.expectedStdout)
      const actual = norm(out.stdout)
      const passed = expected === '' ? null : actual === expected
      results.push({
        testId: t.testId,
        kind: t.kind,
        visibility: t.visibility,
        points: t.points,
        earned: passed === true ? t.points : 0,
        passed,
        note:
          out.timedOut === true
            ? '⏱️ หมดเวลา (ตัดจบ process tree แล้ว)'
            : expected === ''
              ? 'ไม่มี expected output — ตั้งโจทย์เฉย ๆ ไม่ตรวจอัตโนมัติ'
              : passed === true
                ? '✅ ผ่าน'
                : `❌ output ไม่ตรง expected${out.stderr ? ` (stderr: ${out.stderr.slice(0, 200)})` : ''}`,
        durationMs: Date.now() - t0
      })
    }
    return results
  } finally {
    teardownRunDir(runDir)
  }
}

/** คอมไพล์ 1 ครั้งต่อรอบตรวจ — คืนคำสั่งรัน หรือ null ถ้าไม่มี compiler ในเครื่อง */
async function compileProgram(
  language: SupportedCodeLanguage,
  entryPoint: string,
  runDir: string,
  extraPathDirs: string[],
  javaCpExtras: string[] = [],
  linkEnv: Record<string, string> = {}
): Promise<CompiledProgram | null> {
  const absEntry = path.join(runDir, entryPoint)
  const pathEnv = [...extraPathDirs, process.env.PATH ?? ''].filter((s) => s !== '').join(path.delimiter)
  const env = { ...buildSandboxEnv(runDir, linkEnv), PATH: pathEnv }
  if (language === 'c' || language === 'cpp') {
    const compiler = language === 'c' ? 'gcc' : 'g++'
    const sources = listSourcesRecursive(runDir, language === 'c' ? ['.c'] : ['.cpp', '.cc', '.cxx'])
    if (sources.length === 0) return null
    const outBin = path.join(runDir, process.platform === 'win32' ? 'app.exe' : 'app')
    const r = await runCommand(compiler, [...sources, '-O2', '-o', outBin], runDir, env, 60_000)
    if (!r.ok) return null
    return { cmd: outBin, args: () => [], builtInDir: runDir }
  }
  if (language === 'java' || language === 'java-backend') {
    const sources = listSourcesRecursive(runDir, ['.java'])
    if (sources.length === 0) return null
    const buildDir = path.join(runDir, 'build')
    try {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(buildDir, { recursive: true })
    } catch {
      return null
    }
    const javacCp = [buildDir, ...javaCpExtras].join(path.delimiter)
    const r = await runCommand('javac', ['-encoding', 'UTF-8', '-cp', javacCp, '-d', buildDir, ...sources], runDir, env, 60_000)
    if (!r.ok) return null
    const mainClass = entryPoint.split('/').pop()?.replace(/\.java$/, '') ?? 'Main'
    return { cmd: 'java', args: () => ['-Dfile.encoding=UTF-8', '-cp', javacCp, mainClass], builtInDir: runDir }
  }
  if (language === 'rust') {
    const r = await runCommand(
      'rustc',
      ['--edition', '2021', absEntry, '-o', path.join(runDir, process.platform === 'win32' ? 'app.exe' : 'app')],
      runDir,
      env,
      90_000
    )
    if (!r.ok) return null
    const outBin = path.join(runDir, process.platform === 'win32' ? 'app.exe' : 'app')
    return { cmd: outBin, args: () => [], builtInDir: runDir }
  }
  if (language === 'go' || language === 'go-backend') {
    const outBin = path.join(runDir, process.platform === 'win32' ? 'app.exe' : 'app')
    const r = await runCommand('go', ['build', '-o', outBin, '.'], runDir, env, 90_000)
    if (!r.ok) return null
    return { cmd: outBin, args: () => [], builtInDir: runDir }
  }
  if (language === 'typescript') {
    // esbuild เป็นเอนจินภายในของแอป (Phase 9) — bundle แล้วรันด้วย node
    try {
      const nodePaths = linkEnv.NODE_PATH !== undefined && linkEnv.NODE_PATH !== ''
        ? linkEnv.NODE_PATH.split(path.delimiter)
        : []
      const bundled = await bundleFrontend(absEntry, {
        absWorkingDir: runDir,
        ...(nodePaths.length > 0 ? { nodePaths } : {})
      })
      if (!bundled.ok || !bundled.outputJs) return null
      const { writeFileSync } = await import('node:fs')
      const outJs = path.join(runDir, '__ztcode_graded.cjs')
      writeFileSync(outJs, bundled.outputJs, 'utf8')
      const outBin = outJs
      return { cmd: 'node', args: () => [outBin], builtInDir: runDir }
    } catch {
      return null
    }
  }
  return null
}

function listSourcesRecursive(dir: string, exts: string[]): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let children: import('node:fs').Dirent[]
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      children = fs.readdirSync(d, { withFileTypes: true })
      for (const c of children) {
        const abs = path.join(d, c.name)
        if (c.isDirectory()) {
          if (c.name === 'build' || c.name === 'node_modules') continue
          walk(abs)
        } else if (c.isFile() && exts.some((e) => c.name.endsWith(e))) {
          out.push(abs)
        }
      }
    } catch {
      /* อ่านไม่ได้ — ข้าม */
    }
  }
  walk(dir)
  return out
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = ''
    let child: ChildProcess
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true, timeout: timeoutMs })
    } catch (err) {
      resolve({ ok: false, stderr: err instanceof Error ? err.message : 'spawn failed' })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* noop */
      }
    }, timeoutMs)
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString().slice(0, 4000)
    })
    child.on('error', (e: Error) => {
      clearTimeout(timer)
      resolve({ ok: false, stderr: e.message.slice(0, 500) })
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stderr: stderr.slice(0, 1000) })
    })
  })
}

async function spawnStdin(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; extraPathDirs: string[] }
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let child: ChildProcess
    try {
      const pathDelim = path.delimiter
      const env: NodeJS.ProcessEnv = {
        ...opts.env,
        PATH: [...opts.extraPathDirs, opts.env.PATH ?? ''].filter((s) => s !== '').join(pathDelim)
      }
      child = spawn(cmd, args, { cwd: opts.cwd, env, windowsHide: true, timeout: opts.timeoutMs })
      if (child.pid !== undefined) {
        authorizedChildProcesses.register(child.pid, 'code-grader-cli', opts.timeoutMs + 60_000)
      }
    } catch (err) {
      resolve({ stdout: '', stderr: err instanceof Error ? err.message : 'spawn failed', exitCode: null, timedOut: false })
      return
    }
    const finish = (out: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }): void => {
      if (child.pid !== undefined) authorizedChildProcesses.unregister(child.pid)
      resolve(out)
    }
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, opts.timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (stdout.length > 200_000) killProcessTree(child)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString().slice(0, 20_000)
    })
    child.on('error', (e: Error) => {
      clearTimeout(timer)
      finish({ stdout, stderr: `${stderr}\n${e.message}`.trim(), exitCode: null, timedOut })
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      finish({ stdout, stderr, exitCode: code, timedOut })
    })
    try {
      child.stdin?.write(opts.stdin)
      child.stdin?.end()
    } catch {
      /* noop */
    }
  })
}

/* ---------- หมวด Frontend ---------- */

async function gradeDomTests(
  pkg: CodeExamPackage,
  entries: VirtualEntry[],
  tests: DomTestCase[],
  teacherWorkspaceRoot: string | undefined
): Promise<GradeTestResult[]> {
  const { runDir } = materializeExecutionSandbox(entries, { teacherOriginals: teacherOriginalsOf(pkg) })
  try {
    assertOutsideVault(runDir, teacherWorkspaceRoot)
    const absEntry = path.join(runDir, pkg.policy.entryPointPath)
    let bundled: Awaited<ReturnType<typeof bundleFrontend>>
    try {
      bundled = await bundleFrontend(absEntry, { absWorkingDir: runDir })
    } catch (err) {
      bundled = {
        ok: false,
        errors: err instanceof Error ? err.message : 'bundle failed',
        note: 'esbuild bundle ไม่สำเร็จ'
      }
    }
    const results: GradeTestResult[] = []
    for (const t of tests) {
      const t0 = Date.now()
      if (!bundled.ok || !bundled.outputJs) {
        results.push({
          testId: t.testId,
          kind: t.kind,
          visibility: t.visibility,
          points: t.points,
          earned: 0,
          passed: false,
          note: `❌ bundle ไม่ผ่าน: ${(bundled.errors ?? '').slice(0, 300)}`,
          durationMs: Date.now() - t0
        })
        continue
      }
      try {
        const r = await runDomTest({
          testId: t.testId,
          bundleJs: bundled.outputJs,
          documentHtml: documentHtmlFor(findEntryHtml(entries, pkg.policy.entryPointPath, t.route), pkg.title),
          assertionScript: t.assertionScript,
          timeoutMs: t.timeoutMs
        })
        results.push({
          testId: t.testId,
          kind: t.kind,
          visibility: t.visibility,
          points: t.points,
          earned: r.passed === true ? t.points : 0,
          passed: r.passed,
          note: [r.note, ...r.consoleLogs.slice(0, 3)].join(' ').slice(0, 500),
          durationMs: Date.now() - t0
        })
      } catch (err) {
        results.push({
          testId: t.testId,
          kind: t.kind,
          visibility: t.visibility,
          points: t.points,
          earned: 0,
          passed: false,
          note: `⛔ DOM runner พัง: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
          durationMs: Date.now() - t0
        })
      }
    }
    return results
  } finally {
    teardownRunDir(runDir)
  }
}

/** หาไฟล์ HTML ตั้งต้นของนักเรียน (entry .html > route basename > ไฟล์ .html แรก) */
function findEntryHtml(entries: readonly VirtualEntry[], entryPoint: string, route: string): string | null {
  const asFile = (p: string): string | null => {
    const hit = entries.find((e) => e.kind === 'file' && e.path === p)
    if (!hit || hit.encoding === 'base64') return null
    return (hit.content ?? '').slice(0, 200_000)
  }
  if (entryPoint.toLowerCase().endsWith('.html')) {
    const direct = asFile(entryPoint)
    if (direct !== null) return direct
  }
  const base = route.split('/').pop() ?? ''
  if (base.toLowerCase().endsWith('.html')) {
    const byRoute = asFile(base.replace(/^\/+/, ''))
    if (byRoute !== null) return byRoute
  }
  const first = entries.find((e) => e.kind === 'file' && e.path.toLowerCase().endsWith('.html') && e.encoding !== 'base64')
  if (first?.content) return first.content.slice(0, 200_000)
  return null
}

/* ---------- หมวด Backend API ---------- */

interface BackendServerSpec {
  cmd: string
  args: string[]
  /** คอมไพล์ก่อนรัน (go/java) — คืน false ถ้าไม่มี toolchain */
  build?: (env: NodeJS.ProcessEnv) => Promise<boolean>
}

function backendServerCommand(
  language: SupportedCodeLanguage,
  entryPoint: string,
  runDir: string
): BackendServerSpec | null {
  const absEntry = path.join(runDir, entryPoint)
  switch (language) {
    case 'node-backend':
    case 'javascript':
      return { cmd: 'node', args: [absEntry] }
    case 'python-backend':
    case 'python':
      return { cmd: 'python', args: [absEntry] }
    case 'php-backend':
    case 'php': {
      // php built-in server: php -S 127.0.0.1:<PORT> -t <docRoot> <router>
      const docRoot = path.dirname(absEntry)
      return { cmd: 'php', args: ['-S', '127.0.0.1:${PORT}', '-t', docRoot, absEntry] }
    }
    case 'typescript': {
      // bundle ด้วย esbuild แล้วรันผลลัพธ์ด้วย node (PORT ส่งผ่าน env ตามปกติ)
      return {
        cmd: 'node',
        args: [path.join(runDir, '__ztcode_server.cjs')],
        build: async (env) => {
          try {
            const bundled = await bundleFrontend(absEntry, { absWorkingDir: runDir })
            if (!bundled.ok || !bundled.outputJs) return false
            const fs = await import('node:fs')
            fs.writeFileSync(path.join(runDir, '__ztcode_server.cjs'), bundled.outputJs, 'utf8')
            void env
            return true
          } catch {
            return false
          }
        }
      }
    }
    case 'go-backend':
    case 'go': {
      const outBin = path.join(runDir, process.platform === 'win32' ? 'server.exe' : 'server')
      return {
        cmd: outBin,
        args: [],
        build: async (env) => (await runCommand('go', ['build', '-o', outBin, '.'], runDir, env, 90_000)).ok
      }
    }
    case 'java-backend':
    case 'java': {
      const sources = listSourcesRecursive(runDir, ['.java'])
      if (sources.length === 0) return null
      const buildDir = path.join(runDir, 'build')
      const mainClass = entryPoint.split('/').pop()?.replace(/\.java$/, '') ?? 'Main'
      return {
        cmd: 'java',
        args: ['-Dfile.encoding=UTF-8', '-cp', buildDir, mainClass],
        build: async (env) => {
          try {
            const fs = await import('node:fs')
            fs.mkdirSync(buildDir, { recursive: true })
          } catch {
            return false
          }
          return (await runCommand('javac', ['-encoding', 'UTF-8', '-d', buildDir, ...sources], runDir, env, 60_000)).ok
        }
      }
    }
    default:
      return null
  }
}

async function gradeBackendTests(
  pkg: CodeExamPackage,
  entries: VirtualEntry[],
  tests: HttpApiTestCase[],
  teacherWorkspaceRoot: string | undefined,
  depsCache: DepsCacheLayout | undefined,
  collect: { runtimeMissing: string[] }
): Promise<GradeTestResult[]> {
  // เครื่องแม่ไม่มี runtime ของภาษานี้ → อย่าให้คะแนนมั่ว (รอติดตั้งแล้ว Re-grade)
  const needed = runtimesForLanguage(pkg.language)
  if (needed.length > 0) {
    const checks = await Promise.all(needed.map((name) => checkRuntime(name).catch(() => ({ found: false as const }))))
    const anyFound = checks.some((c) => c.found)
    if (!anyFound) {
      const results: GradeTestResult[] = tests.map((t) => ({
        testId: t.testId,
        kind: t.kind,
        visibility: t.visibility,
        points: t.points,
        earned: 0,
        passed: null,
        note: `⚠️ เครื่องแม่ไม่มี runtime ${needed.join('/')} — ติดตั้งลงเครื่องแล้วกด Re-grade (แอปไม่ดาวน์โหลดให้เอง)`,
        durationMs: 0
      }))
      collect.runtimeMissing.push(...needed)
      return results
    }
  }

  const mat = materializeExecutionSandbox(entries, {
    teacherOriginals: teacherOriginalsOf(pkg),
    ...(depsCache !== undefined ? { depsCache } : {})
  })
  const { runDir } = mat
  let server: ChildProcess | null = null
  try {
    assertOutsideVault(runDir, teacherWorkspaceRoot)
    const started = Date.now()
    const env = buildSandboxEnv(runDir, mat.linkEnv)
    const realSpec = backendServerCommand(pkg.language, pkg.policy.entryPointPath, runDir)
    if (!realSpec) {
      const results: GradeTestResult[] = tests.map((t) => ({
        testId: t.testId,
        kind: t.kind,
        visibility: t.visibility,
        points: t.points,
        earned: 0,
        passed: null,
        note: `⚠️ หมวด backend ยังไม่รองรับภาษา ${pkg.language} ในการตรวจอัตโนมัติ — ตรวจด้วยตาใน Mirror Preview`,
        durationMs: 0
      }))
      return results
    }
    if (realSpec.build) {
      const ok = await realSpec.build(env)
      if (!ok) {
        const results: GradeTestResult[] = tests.map((t) => ({
          testId: t.testId,
          kind: t.kind,
          visibility: t.visibility,
          points: t.points,
          earned: 0,
          passed: null,
          note: `⚠️ คอมไพล์เซิร์ฟเวอร์ไม่สำเร็จ / ไม่มี toolchain ของ ${pkg.language} — ติดตั้งแล้วกด Re-grade`,
          durationMs: 0
        }))
        collect.runtimeMissing.push(...runtimesForLanguage(pkg.language))
        return results
      }
    }
    // แยกพอร์ตต่อ worker — กัน EADDRINUSE ตอนนักเรียนส่งพร้อมกัน
    const port = await allocateEphemeralPort('127.0.0.1')
    server = spawnServer(realSpec.cmd, realSpec.args.map((a) => a.split('${PORT}').join(String(port))), {
      cwd: runDir,
      env,
      port,
      extraPathDirs: getRuntimePathEntries(runtimesForLanguage(pkg.language))
    })
    const ready = await waitForPort('127.0.0.1', port, 8000)
    if (!ready) {
      killProcessTree(server)
      server = null
      const results: GradeTestResult[] = tests.map((t) => ({
        testId: t.testId,
        kind: t.kind,
        visibility: t.visibility,
        points: t.points,
        earned: 0,
        passed: false,
        note: '❌ เซิร์ฟเวอร์ของนักเรียนไม่เปิดพอร์ตภายใน 8 วินาที (ตรวจ PORT env / listen 127.0.0.1)',
        durationMs: Date.now() - started
      }))
      return results
    }
    const results: GradeTestResult[] = []
    for (const t of tests) {
      const t0 = Date.now()
      const httpResults = await runHttpTests(
        `http://127.0.0.1:${port}`,
        t.requests.map((r) => ({
          method: r.method,
          path: r.path,
          expectedStatus: r.expectedStatus,
          expectedBodyMatcher: r.expectedBodyMatcher,
          expectedBody: r.expectedBody,
          ...(r.headers !== undefined ? { headers: r.headers } : {}),
          ...(r.bodyJson !== undefined ? { bodyJson: r.bodyJson } : {})
        })),
        t.timeoutMs
      )
      const httpPassed = httpResults.length > 0 && httpResults.every((r) => r.passed)
      const detail = httpResults.map((r) => `${r.path}: ${r.passed ? '✅' : `❌ ${r.note.slice(0, 120)}`}`).join(' | ')
      // ตรวจสถานะ DB หลังยิง API (ถ้าครูตั้ง verifyDb ไว้) — รันบนไฟล์ .sqlite ที่เซิร์ฟเวอร์สร้างใน runDir
      let dbNote = ''
      let dbPassed: boolean | null = null
      if (t.verifyDb !== undefined) {
        if (httpPassed) {
          const check = await checkServerDatabase(runDir, t.verifyDb)
          dbPassed = check.passed
          dbNote = check.note
        } else {
          dbNote = 'ข้ามตรวจ DB (HTTP ยังไม่ผ่าน)'
        }
      }
      const allPassed = httpPassed && (dbPassed ?? true)
      const finalPassed = t.verifyDb !== undefined && httpPassed && dbPassed === null ? null : allPassed
      results.push({
        testId: t.testId,
        kind: t.kind,
        visibility: t.visibility,
        points: t.points,
        earned: finalPassed === true ? t.points : 0,
        passed: finalPassed,
        note: [detail, dbNote].filter(Boolean).join(' ').slice(0, 500),
        durationMs: Date.now() - t0
      })
    }
    return results
  } catch (err) {
    const results: GradeTestResult[] = tests.map((t) => ({
      testId: t.testId,
      kind: t.kind,
      visibility: t.visibility,
      points: t.points,
      earned: 0,
      passed: err instanceof Error && /runtime|spawn|ENOENT/i.test(err.message) ? null : false,
      note: `⛔ ตรวจไม่ได้: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
      durationMs: 0
    }))
    return results
  } finally {
    if (server) killProcessTree(server)
    teardownRunDir(runDir)
  }
}

/* ---------- หมวด Database / SQL ---------- */

export function resolveSeedSql(pkg: CodeExamPackage): string {
  const seedPath = pkg.database.seedSqlPath
  if (seedPath) {
    const found = pkg.entries.find((e) => e.kind === 'file' && e.path === seedPath)
    if (found?.content && found.encoding !== 'base64') return found.content
  }
  return ''
}

export function resolveStudentSql(pkg: CodeExamPackage, entries: VirtualEntry[]): string {
  const found = entries.find((e) => e.kind === 'file' && e.path === pkg.policy.entryPointPath)
  if (found?.content && found.encoding !== 'base64') return found.content
  // fallback: ไฟล์ .sql ไฟล์แรกของนักเรียน
  const first = entries.find((e) => e.kind === 'file' && e.path.endsWith('.sql') && e.encoding !== 'base64')
  return first?.content ?? ''
}

async function gradeSqlTests(
  pkg: CodeExamPackage,
  entries: VirtualEntry[],
  tests: SqlTestCase[]
): Promise<GradeTestResult[]> {
  const seedSql = resolveSeedSql(pkg)
  const studentSql = resolveStudentSql(pkg, entries)
  const results: GradeTestResult[] = []
  for (const t of tests) {
    const t0 = Date.now()
    try {
      // spawn ฐานข้อมูลจำลองลูกใหม่ทุก test (Master Seed ไม่ถูกแตะ — กัน DELETE/DROP ค้างข้ามข้อ)
      const r = await runSqliteTest(seedSql, studentSql, t)
      results.push({
        testId: t.testId,
        kind: t.kind,
        visibility: t.visibility,
        points: t.points,
        earned: r.passed === true ? t.points : 0,
        passed: r.passed,
        note: r.note.slice(0, 300),
        durationMs: Date.now() - t0
      })
    } catch (err) {
      results.push({
        testId: t.testId,
        kind: t.kind,
        visibility: t.visibility,
        points: t.points,
        earned: 0,
        passed: false,
        note: `⛔ SQL error: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
        durationMs: Date.now() - t0
      })
    }
  }
  return results
}

/* ---------- Inspector Probe: รันเซิร์ฟเวอร์นักเรียนชั่วคราวแล้วยิง 1 request ---------- */

export interface BackendProbeResult {
  ok: boolean
  status: number | null
  body: string
  note: string
}

/**
 * ครูกดยิง API ทดสอบเซิร์ฟเวอร์ของนักเรียนจาก Mirror Inspector:
 * spawn ชั่วคราวบน ephemeral port → ยิง 1 request → teardown ทันที
 * (ไม่ผ่านคิวตรวจ — รันตรงเพราะครูกดทีละครั้ง)
 */
export async function probeBackendServer(
  pkg: CodeExamPackage,
  entries: VirtualEntry[],
  probe: { method: string; path: string; bodyJson?: string; timeoutMs?: number },
  opts: { depsCache?: DepsCacheLayout | undefined; teacherWorkspaceRoot?: string | undefined } = {}
): Promise<BackendProbeResult> {
  const needed = runtimesForLanguage(pkg.language)
  if (needed.length > 0) {
    const checks = await Promise.all(needed.map((name) => checkRuntime(name).catch(() => ({ found: false as const }))))
    if (!checks.some((c) => c.found)) {
      return { ok: false, status: null, body: '', note: `⚠️ เครื่องแม่ไม่มี runtime ${needed.join('/')} — ติดตั้งก่อน` }
    }
  }
  const mat = materializeExecutionSandbox(entries, {
    teacherOriginals: teacherOriginalsOf(pkg),
    ...(opts.depsCache !== undefined ? { depsCache: opts.depsCache } : {})
  })
  const { runDir } = mat
  let server: ChildProcess | null = null
  try {
    assertOutsideVault(runDir, opts.teacherWorkspaceRoot)
    const env = buildSandboxEnv(runDir, mat.linkEnv)
    const spec = backendServerCommand(pkg.language, pkg.policy.entryPointPath, runDir)
    if (!spec) return { ok: false, status: null, body: '', note: `ภาษา ${pkg.language} ยัง probe ไม่ได้` }
    if (spec.build !== undefined) {
      const built = await spec.build(env)
      if (!built) return { ok: false, status: null, body: '', note: 'คอมไพล์เซิร์ฟเวอร์ไม่สำเร็จ' }
    }
    const port = await allocateEphemeralPort('127.0.0.1')
    server = spawnServer(
      spec.cmd,
      spec.args.map((a) => a.split('${PORT}').join(String(port))),
      { cwd: runDir, env, port, extraPathDirs: getRuntimePathEntries(runtimesForLanguage(pkg.language)) }
    )
    const ready = await waitForPort('127.0.0.1', port, 8000)
    if (!ready) return { ok: false, status: null, body: '', note: '❌ เซิร์ฟเวอร์ไม่เปิดพอร์ตใน 8 วิ (ตรวจ PORT env)' }
    const timeoutMs = probe.timeoutMs ?? 8000
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const init: RequestInit = {
        method: probe.method,
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal
      }
      if (probe.bodyJson !== undefined && probe.bodyJson.trim() !== '' && probe.method !== 'GET') {
        init.body = probe.bodyJson
      }
      const res = await fetch(`http://127.0.0.1:${port}${probe.path}`, init)
      const body = await res.text()
      return { ok: true, status: res.status, body: body.slice(0, 8000), note: `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, status: null, body: '', note: `⛔ ยิงไม่ติด: ${err instanceof Error ? err.message.slice(0, 160) : 'fetch failed'}` }
    } finally {
      clearTimeout(timer)
    }
  } finally {
    if (server) killProcessTree(server)
    teardownRunDir(runDir)
  }
}

/**
 * Bundle โปรเจกต์นักเรียนสำหรับ Live Preview ใน Inspector:
 * คืน HTML เอกสาร (entry .html หรือ shell) + JS ที่ bundle แล้ว
 */
export async function bundleForPreview(
  pkg: CodeExamPackage,
  entries: VirtualEntry[]
): Promise<{ ok: boolean; html: string; js: string; note: string }> {
  const { runDir } = materializeExecutionSandbox(entries, { teacherOriginals: teacherOriginalsOf(pkg) })
  try {
    assertOutsideVault(runDir, undefined)
    const absEntry = path.join(runDir, pkg.policy.entryPointPath)
    let bundled: Awaited<ReturnType<typeof bundleFrontend>>
    try {
      bundled = await bundleFrontend(absEntry, { absWorkingDir: runDir })
    } catch (err) {
      return { ok: false, html: '', js: '', note: `bundle ไม่สำเร็จ: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}` }
    }
    if (!bundled.ok || !bundled.outputJs) {
      return { ok: false, html: '', js: '', note: `bundle ไม่สำเร็จ: ${(bundled.errors ?? '').slice(0, 200)}` }
    }
    const html = findEntryHtml(entries, pkg.policy.entryPointPath, '/')
    return { ok: true, html: documentHtmlFor(html, pkg.title), js: bundled.outputJs.slice(0, 2_000_000), note: bundled.note }
  } finally {
    teardownRunDir(runDir)
  }
}

/** หาไฟล์ฐานข้อมูลที่เซิร์ฟเวอร์นักเรียนสร้างไว้ใน runDir (ข้าม node_modules/build) */
function findServerDatabaseFiles(runDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const c of children) {
      if (c.name === 'node_modules' || c.name === 'build' || c.name === '.git') continue
      const abs = path.join(dir, c.name)
      if (c.isDirectory()) walk(abs, depth + 1)
      else if (c.isFile() && /\.(sqlite|sqlite3|db)$/i.test(c.name)) out.push(abs)
    }
  }
  walk(runDir, 0)
  return out.slice(0, 5)
}

/**
 * ตรวจสถานะฐานข้อมูลหลังยิง API (verifyDb ของ test นั้น):
 * รัน query ตรวจบนไฟล์ .sqlite ที่เซิร์ฟเวอร์นักเรียนสร้างใน runDir
 * - ไม่เจอไฟล์ DB เลย → passed=null (ตรวจไม่ได้ — เซิร์ฟเวอร์อาจใช้ :memory:)
 */
async function checkServerDatabase(
  runDir: string,
  verifyDb: NonNullable<HttpApiTestCase['verifyDb']>
): Promise<{ passed: boolean | null; note: string }> {
  const files = findServerDatabaseFiles(runDir)
  if (files.length === 0) {
    return {
      passed: null,
      note: '⏳ ไม่พบไฟล์ .sqlite ของเซิร์ฟเวอร์ใน runDir — ข้ามตรวจสถานะ DB (เซิร์ฟเวอร์อาจใช้ :memory:)'
    }
  }
  try {
    // dynamic resolve ผ่าน createRequire — ไม่ผูก static import (แบบเดียวกับ frontend-runner)
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-require-imports
    const Database = req('better-sqlite3')
    const db = new Database(files[0], { readonly: true }) as {
      prepare: (sql: string) => { columns: () => Array<{ name: string }>; all: () => Array<Record<string, unknown>> }
      close: () => void
    }
    try {
      const stmt = db.prepare(verifyDb.query)
      const cols = stmt.columns().map((c) => c.name)
      const rows = stmt.all().map((r) => cols.map((c) => (r[c] === undefined ? null : r[c]) as string | number | null))
      const { passed, columnOk, rowOk } = compareSqlResult(
        verifyDb.expectedColumns,
        verifyDb.expectedRows,
        verifyDb.checkColumnOrder,
        verifyDb.checkRowOrder,
        cols,
        rows as unknown[][]
      )
      return {
        passed,
        note: passed
          ? '✅ สถานะ DB ตรง'
          : `❌ สถานะ DB ไม่ตรง (คอลัมน์ ${columnOk ? 'ถูก' : 'ผิด'} / แถว ${rowOk ? 'ถูก' : 'ผิด'})`
      }
    } finally {
      try {
        db.close()
      } catch {
        /* noop */
      }
    }
  } catch (err) {
    return {
      passed: null,
      note: `⏳ เปิด DB ตรวจไม่ได้: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown'}`
    }
  }
}

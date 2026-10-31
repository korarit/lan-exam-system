import { spawn } from 'node:child_process'
import path from 'node:path'
import { materializeExecutionSandbox, teardownRunDir } from '../workspace-materializer'
import { buildSandboxEnv, phpSandboxArgs, scanDestructiveCode } from '../anti-delete-guard'
import type { DepsCacheLayout } from '../code-deps-cache'
import { authorizedChildProcesses } from '../authorized-process-registry'
import { typedInputsToStdin, type CliTestCase, type SupportedCodeLanguage, type VirtualEntry } from '../../shared/code-schema'

/* Phase 9 (9.4.1) — CLI / Systems Multi-File Runner
 * คอมไพล์ (ถ้าต้อง) + รัน entry point กับ stdin ของแต่ละ test (typed inputs รวมเป็น stdin อัตโนมัติ)
 * ฆ่า process tree เมื่อ timeout + จำกัดขนาด output
 */

export interface CliRunResult {
  testId: string
  passed: boolean | null
  actualStdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  blockedReason?: string | undefined
  note: string
}

function stdinFor(t: CliTestCase): string {
  if ((t.inputs ?? []).length > 0) {
    const auto = typedInputsToStdin(t.inputs ?? [])
    // ถ้าครูพิมพ์ stdin ไว้ด้วยให้ใช้ stdin ตรง ๆ (override), ไม่งั้นใช้ auto
    if (t.stdin.trim() !== '') return t.stdin
    return auto
  }
  return t.stdin
}

/**
 * Cross-platform sandbox flags ต่อภาษา
 * - Node: permission model (read/write เฉพาะ runDir + offline libs, spawn ลูกถูกบล็อก)
 * - Python: ไม่โหลด user site-packages (-s) และไม่เขียน .pyc (-B)
 * - PHP: open_basedir + disable_functions (ใช้ helper เดิม)
 * คืน [] สำหรับภาษาที่ไม่มี flag เฉพาะ
 */
export function sandboxArgsFor(
  language: SupportedCodeLanguage,
  runDir: string,
  readPaths: readonly string[] = []
): string[] {
  switch (language) {
    case 'javascript':
    case 'node-backend': {
      const reads = [...new Set([runDir, ...readPaths].filter((p) => p.length > 0))]
      return ['--permission', ...reads.map((p) => `--allow-fs-read=${p}`), `--allow-fs-write=${runDir}`]
    }
    case 'python':
    case 'python-backend':
      return ['-B', '-s']
    case 'php':
    case 'php-backend':
      return phpSandboxArgs(runDir, runDir)
    default:
      return []
  }
}

function buildCommand(
  language: SupportedCodeLanguage,
  runDir: string,
  entryPoint: string,
  extraCp: string[] = [],
  readPaths: readonly string[] = []
): { cmd: string; args: string[]; cwd: string } | { error: string } {
  const absEntry = path.join(runDir, entryPoint)
  const sandbox = sandboxArgsFor(language, runDir, readPaths)
  switch (language) {
    case 'python': case 'python-backend':
      return { cmd: 'python', args: [...sandbox, absEntry], cwd: runDir }
    case 'javascript': case 'node-backend':
      return { cmd: 'node', args: ['--max-old-space-size=256', ...sandbox, absEntry], cwd: runDir }
    case 'typescript':
      // ใช้ node + ts transpile หน้างานไม่ได้ — ต้อง bundle ด้วย esbuild ก่อน (ดู frontend-runner)
      return { error: 'TypeScript ต้อง bundle ด้วย esbuild ก่อนรัน — หรือรันผ่าน tsx ถ้าติดตั้งในเครื่อง' }
    case 'java': case 'java-backend': {
      // คอมไพล์แยกก่อนรัน — ผู้เรียกต้อง javac ก่อน (ทำแบบ sync ใน runCliTest ด้านล่าง)
      const cp = [runDir, ...extraCp].join(path.delimiter)
      return { cmd: 'java', args: ['-Dfile.encoding=UTF-8', '-cp', cp, mainClassOf(entryPoint)], cwd: runDir }
    }
    case 'php': case 'php-backend':
      return { cmd: 'php', args: [...sandbox, absEntry], cwd: runDir }
    case 'c': case 'cpp': case 'rust': case 'go':
      return { error: `${language} ต้องคอมไพล์เป็นไบนารีก่อน (gcc/g++/rustc/go build) — ผูก runtime-locator แล้วรัน app.exe` }
    default:
      return { cmd: 'node', args: [absEntry], cwd: runDir }
  }
}

function mainClassOf(entryPoint: string): string {
  const base = entryPoint.split('/').pop() ?? entryPoint
  return base.replace(/\.java$/, '')
}

function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n').trim()
}

export async function runCliTest(
  entries: readonly VirtualEntry[],
  language: SupportedCodeLanguage,
  entryPoint: string,
  test: CliTestCase,
  opts: {
    teacherOriginals?: readonly VirtualEntry[]
    extraPathDirs?: string[] | undefined
    /** offline libs (junction + PYTHONPATH + jars) — undefined = ไม่มี */
    depsCache?: DepsCacheLayout | undefined
  } = {}
): Promise<CliRunResult> {
  // Guard: สแกนโค้ดลบไฟล์ก่อนรัน
  const hits = scanDestructiveCode(entries)
  if (hits.length > 0) {
    const h = hits[0]!
    return {
      testId: test.testId, passed: false, actualStdout: '', stderr: '',
      exitCode: null, timedOut: false,
      blockedReason: `🚫 [Runtime Guard] บล็อก ${h.path}:${h.line} (${h.pattern}) — File deletion is prohibited`,
      note: 'ถูกบล็อกโดย Anti-Delete Guard ก่อนรัน'
    }
  }

  const mat = materializeExecutionSandbox(entries, {
    ...(opts.teacherOriginals !== undefined ? { teacherOriginals: opts.teacherOriginals } : {}),
    ...(opts.depsCache !== undefined ? { depsCache: opts.depsCache } : {})
  })
  const { runDir } = mat
  try {
    const built = buildCommand(language, runDir, entryPoint, mat.javaCpExtras, [
      ...(opts.extraPathDirs ?? []),
      ...(mat.linkEnv.NODE_PATH ? mat.linkEnv.NODE_PATH.split(path.delimiter) : []),
      ...(mat.linkEnv.PYTHONPATH ? mat.linkEnv.PYTHONPATH.split(path.delimiter) : [])
    ])
    if ('error' in built) {
      return { testId: test.testId, passed: null, actualStdout: '', stderr: built.error, exitCode: null, timedOut: false, note: built.error }
    }
    const stdin = stdinFor(test)
    // Custom SDK path ที่ผู้ใช้เลือกเอง (Browse) ต้องมีผลตอนรันด้วย — เติมนำหน้า PATH
    const pathDelim = require('node:path').delimiter as string
    const pathExtra =
      opts.extraPathDirs !== undefined && opts.extraPathDirs.length > 0
        ? { PATH: [...opts.extraPathDirs, process.env.PATH ?? ''].filter((s) => s !== '').join(pathDelim) }
        : {}
    const result = await spawnWithTimeout(built.cmd, built.args, {
      cwd: built.cwd,
      // offline libs (PYTHONPATH/NODE_PATH) รวมเข้ากับ sandbox env ที่ล้างแล้ว
      env: buildSandboxEnv(runDir, { ...pathExtra, ...mat.linkEnv }),
      stdin,
      timeoutMs: test.timeoutMs,
      reason: `cli-run:${language}`
    })
    const actual = normalize(result.stdout)
    const expected = normalize(test.expectedStdout)
    const passed = expected === '' ? null : actual === expected
    return {
      testId: test.testId, passed, actualStdout: result.stdout.slice(0, 20_000),
      stderr: result.stderr.slice(0, 5000), exitCode: result.exitCode,
      timedOut: result.timedOut,
      note: expected === '' ? 'ไม่มี expected output — ตั้งโจทย์เฉย ๆ ไม่ตรวจอัตโนมัติ' : passed === true ? '✅ ผ่าน' : '❌ output ไม่ตรง expected'
    }
  } finally {
    teardownRunDir(runDir)
  }
}

function spawnWithTimeout(
  cmd: string, args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; reason?: string | undefined }
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const isWindows = process.platform === 'win32'
    let spawnCmd = cmd
    let spawnArgs = args
    if (!isWindows) {
      // จำกัดทรัพยากรระดับ process (CPU/ไฟล์/จำนวนโปรเซส) แบบ best-effort
      const cpuSeconds = Math.max(2, Math.ceil(opts.timeoutMs / 1000) + 2)
      const limits =
        'umask 077; ' +
        `ulimit -t ${cpuSeconds} 2>/dev/null; ` +
        'ulimit -f 65536 2>/dev/null; ' +
        'ulimit -u 64 2>/dev/null; ' +
        'exec "$@"'
      spawnCmd = 'sh'
      spawnArgs = ['-c', limits, '--', cmd, ...args]
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(spawnCmd, spawnArgs, {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        timeout: opts.timeoutMs,
        detached: !isWindows
      })
      // Phase 9.5: ลงทะเบียน pid ชั่วคราวให้ guard ข้ามการฟ้องโปรเซสลูกของ sandbox เอง
      if (child.pid !== undefined) {
        authorizedChildProcesses.register(child.pid, opts.reason ?? 'cli-run', opts.timeoutMs + 60_000)
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
      try {
        if (isWindows) {
          try { require('node:child_process').execSync(`taskkill /pid ${child.pid} /T /F`) } catch { child.kill('SIGKILL') }
        } else if (child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
        }
      } catch { /* noop */ }
    }, opts.timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (stdout.length > 200_000) { try { child.kill('SIGKILL') } catch { /* noop */ } }
    })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString().slice(0, 50_000) })
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
    } catch { /* noop */ }
  })
}

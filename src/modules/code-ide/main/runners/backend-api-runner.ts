import net from 'node:net'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { authorizedChildProcesses } from '../authorized-process-registry'

/* Phase 9 (9.4.3) — Backend Ephemeral Server Runner + HTTP Tester
 * ขอ port ว่างบน 127.0.0.1, รอ server พร้อม (TCP readiness), ยิง requests ตรวจ, ฆ่า process tree
 */

export interface HttpExpect {
  method: string
  path: string
  expectedStatus: number
  expectedBodyMatcher: 'exact-json' | 'json-subset' | 'regex' | 'custom-script'
  expectedBody: string
  headers?: Record<string, string>
  bodyJson?: string
}

export interface HttpTestResult {
  path: string
  passed: boolean
  actualStatus: number | null
  actualBody: string
  note: string
}

export function allocateEphemeralPort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, host, () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

export function waitForPort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  const started = Date.now()
  return new Promise((resolve) => {
    function attempt(): void {
      if (Date.now() - started > timeoutMs) { resolve(false); return }
      const s = new net.Socket()
      s.setTimeout(500)
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => { s.destroy(); setTimeout(attempt, 150) })
      s.once('timeout', () => { s.destroy(); setTimeout(attempt, 150) })
      s.connect(port, host)
    }
    attempt()
  })
}

export function killProcessTree(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) authorizedChildProcesses.unregister(child.pid)
    if (child.pid === undefined) return
    if (process.platform === 'win32') {
      try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { try { child.kill('SIGKILL') } catch { /* noop */ } }
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* noop */ } }
    }
  } catch { /* noop */ }
}

function matchBody(matcher: HttpExpect['expectedBodyMatcher'], expected: string, actual: string): boolean {
  try {
    if (matcher === 'regex') return new RegExp(expected, 's').test(actual)
    if (matcher === 'exact-json') return JSON.stringify(JSON.parse(actual)) === JSON.stringify(JSON.parse(expected))
    if (matcher === 'json-subset') {
      const a = JSON.parse(actual) as Record<string, unknown>
      const e = JSON.parse(expected) as Record<string, unknown>
      return Object.entries(e).every(([k, v]) => JSON.stringify(a[k]) === JSON.stringify(v))
    }
  } catch {
    return false
  }
  return actual.includes(expected)
}

export async function runHttpTests(baseUrl: string, tests: HttpExpect[], timeoutMs = 5000): Promise<HttpTestResult[]> {
  const out: HttpTestResult[] = []
  for (const t of tests) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const init: RequestInit = {
        method: t.method,
        headers: { 'content-type': 'application/json', ...(t.headers ?? {}) },
        signal: ctrl.signal
      }
      if (t.bodyJson !== undefined && t.method !== 'GET') init.body = t.bodyJson
      const res = await fetch(`${baseUrl}${t.path}`, init)
      const body = await res.text()
      const passed = res.status === t.expectedStatus && (t.expectedBody.trim() === '' || matchBody(t.expectedBodyMatcher, t.expectedBody, body))
      out.push({ path: t.path, passed, actualStatus: res.status, actualBody: body.slice(0, 5000), note: passed ? '✅ ผ่าน' : `❌ คาด ${t.expectedStatus} ได้ ${res.status}` })
    } catch (err) {
      out.push({ path: t.path, passed: false, actualStatus: null, actualBody: '', note: `⛔ ยิงไม่ติด: ${err instanceof Error ? err.message : 'fetch failed'}` })
    } finally {
      clearTimeout(timer)
    }
  }
  return out
}

export function spawnServer(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; port: number; extraPathDirs?: string[] | undefined }
): ChildProcess {
  const path = require('node:path') as typeof import('node:path')
  let env: NodeJS.ProcessEnv = { ...opts.env, PORT: String(opts.port) }
  if (opts.extraPathDirs !== undefined && opts.extraPathDirs.length > 0) {
    env = { ...env, PATH: [...opts.extraPathDirs, env.PATH ?? ''].filter((s) => s !== '').join(path.delimiter) }
  }
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env,
    windowsHide: true,
    detached: process.platform !== 'win32'
  })
  // Phase 9.5: ลงทะเบียน pid เซิร์ฟเวอร์ของนักเรียนชั่วคราว (10 นาที) ให้ guard ข้ามการฟ้อง
  if (child.pid !== undefined) {
    authorizedChildProcesses.register(child.pid, 'backend-server', 10 * 60_000)
  }
  return child
}

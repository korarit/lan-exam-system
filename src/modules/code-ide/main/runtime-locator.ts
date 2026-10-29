import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

/* Phase 9 (9.1) — External OS Runtime Detector (ไม่ดาวน์โหลดแยก)
 * ตรวจว่าหา compiler/runtime ในเครื่องเจอไหม ถ้าไม่เจอให้ผู้ใช้ติดตั้งเอง + Re-scan / Browse เอง
 */

const execFileAsync = promisify(execFile)

export interface RuntimeInfo {
  /** คีย์ภาษา เช่น 'java' | 'python' | 'node' | 'gcc' | 'go' | 'rust' | 'php' */
  name: string
  found: boolean
  version?: string | undefined
  path?: string | undefined
  /** คำแนะนำติดตั้งเมื่อไม่พบ */
  hint: string
}

const RUNTIME_SPECS: Array<{ name: string; probes: string[][]; hint: string }> = [
  { name: 'gcc', probes: [['gcc', '--version'], ['clang', '--version']], hint: 'ติดตั้ง MinGW-w64/MSYS2 (Windows) หรือ Xcode CLT (macOS) หรือ build-essential (Linux)' },
  { name: 'g++', probes: [['g++', '--version'], ['clang++', '--version']], hint: 'ติดตั้ง MinGW-w64/MSYS2 (Windows) หรือ Xcode CLT (macOS) หรือ build-essential (Linux)' },
  { name: 'rust', probes: [['rustc', '--version']], hint: 'ติดตั้งจาก https://rustup.rs แล้วเปิด terminal ใหม่' },
  { name: 'go', probes: [['go', 'version']], hint: 'ติดตั้งจาก https://go.dev/dl (ตรวจ GOROOT/PATH)' },
  { name: 'java', probes: [['javac', '-version'], ['java', '-version']], hint: 'ติดตั้ง JDK 17+ แล้วตั้ง JAVA_HOME/PATH' },
  { name: 'python', probes: [['python', '--version'], ['python3', '--version']], hint: 'ติดตั้ง Python 3.11+ จาก https://python.org แล้วติ๊ก Add to PATH' },
  { name: 'node', probes: [['node', '--version']], hint: 'ติดตั้ง Node.js LTS จาก https://nodejs.org' },
  { name: 'php', probes: [['php', '-v']], hint: 'ติดตั้ง PHP 8+ (XAMPP/Laragon หรือ php.net) แล้วเพิ่มเข้า PATH' }
]

async function probe(cmd: string, args: string[]): Promise<{ version: string } | null> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 8000, windowsHide: true })
    const out = `${stdout ?? ''}\n${stderr ?? ''}`.trim().split('\n')[0] ?? ''
    return { version: out.slice(0, 200) }
  } catch {
    return null
  }
}

/* ---------- Custom SDK path (ผู้ใช้กด Browse เลือกโฟลเดอร์เอง — เก็บใน main process) ---------- */

const customSdkDirs = new Map<string, string>()

/** ลงทะเบียนโฟลเดอร์ SDK ที่ผู้ใช้เลือกเอง (เช่น C:\Tools\jdk-17\bin) */
export function setCustomSdkPath(runtimeName: string, dirPath: string): void {
  customSdkDirs.set(runtimeName, dirPath)
}

export function getCustomSdkPath(runtimeName: string): string | undefined {
  return customSdkDirs.get(runtimeName)
}

export function clearCustomSdkPaths(): void {
  customSdkDirs.clear()
}

/** candidate ชื่อไฟล์ binary ในโฟลเดอร์ที่เลือก (Windows ต้องมี .exe/.cmd/.bat) */
function exeCandidates(dir: string, cmd: string): string[] {
  if (process.platform === 'win32') {
    return [path.join(dir, `${cmd}.exe`), path.join(dir, `${cmd}.cmd`), path.join(dir, `${cmd}.bat`), path.join(dir, cmd)]
  }
  return [path.join(dir, cmd)]
}

/** โฟลเดอร์ custom ที่ยังมีอยู่จริง — เอาไปเติมนำหน้า PATH ตอน spawn (ดู cli-runner) */
export function getRuntimePathEntries(runtimeNames: string[]): string[] {
  const out: string[] = []
  for (const name of runtimeNames) {
    const dir = customSdkDirs.get(name)
    if (dir === undefined) continue
    try {
      if (fs.statSync(dir).isDirectory() && !out.includes(dir)) out.push(dir)
    } catch {
      // โฟลเดอร์หายไปแล้ว — ข้าม
    }
  }
  return out
}

export async function checkRuntime(name: string): Promise<RuntimeInfo> {
  const spec = RUNTIME_SPECS.find((s) => s.name === name)
  if (spec === undefined) return { name, found: false, hint: 'ไม่รู้จัก runtime นี้' }
  // โฟลเดอร์ที่ผู้ใช้ Browse เองมาก่อนเสมอ (ติดตั้งแล้วแต่ไม่อยู่ใน PATH)
  const customDir = customSdkDirs.get(name)
  if (customDir !== undefined) {
    for (const [cmd, ...args] of spec.probes) {
      if (cmd === undefined) continue
      for (const full of exeCandidates(customDir, cmd)) {
        const hit = await probe(full, args)
        if (hit !== null) return { name, found: true, version: hit.version, path: full, hint: '' }
      }
    }
  }
  for (const [cmd, ...args] of spec.probes) {
    if (cmd === undefined) continue
    const hit = await probe(cmd, args)
    if (hit !== null) return { name, found: true, version: hit.version, path: cmd, hint: '' }
  }
  return { name, found: false, hint: spec.hint }
}

/** ตรวจทุก runtime (หรือเฉพาะภาษาที่ใช้จริง) — ไม่ throw, คืน map เสมอ */
export async function discoverRuntimes(names?: string[]): Promise<Record<string, RuntimeInfo>> {
  const targets = names === undefined ? RUNTIME_SPECS.map((s) => s.name) : names
  const out: Record<string, RuntimeInfo> = {}
  for (const n of targets) out[n] = await checkRuntime(n)
  return out
}

/** ภาษา code-ide → runtime ที่ต้องมี */
export function runtimesForLanguage(language: string): string[] {
  switch (language) {
    case 'c': return ['gcc']
    case 'cpp': return ['g++']
    case 'rust': return ['rust']
    case 'go': case 'go-backend': return ['go']
    case 'java': case 'java-backend': return ['java']
    case 'python': case 'python-backend': return ['python']
    case 'javascript': case 'typescript': case 'node-backend': case 'react': case 'html-css-js': return ['node']
    case 'php': case 'php-backend': return ['php']
    case 'sql-sqlite': return []
    case 'sql-mysql': return []
    default: return ['node']
  }
}

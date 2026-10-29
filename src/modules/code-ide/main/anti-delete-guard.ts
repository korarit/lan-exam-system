import path from 'node:path'
import type { VirtualEntry } from '../shared/code-schema'

/* Phase 9 (9.2) — Teacher & Student Runtime Anti-Delete File Guard
 * ชั้นที่ 1: แยก vault (เก็บงานจริง) ออกจาก runDir (โฟลเดอร์รันชั่วคราว) + ล้าง env
 * ชั้นที่ 2: flag ระดับภาษา (open_basedir/disable_functions/addaudithook/--import/javaagent/overlay)
 * ชั้นที่ 3: สแกนซอร์สก่อนรัน หาคำสั่งลบไฟล์/เรียก shell/พาธหลุด
 */

/** env ที่ส่งให้โปรเซสลูก — ตัดพาธอ่อนไหวออก, เก็บแค่ที่จำเป็นต่อการรัน */
export function buildSandboxEnv(runDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v)
  const env: NodeJS.ProcessEnv = {
    PATH: keep(process.env.PATH),
    SYSTEMROOT: keep(process.env.SYSTEMROOT),
    TEMP: keep(process.env.TEMP),
    TMP: keep(process.env.TMP),
    LANG: keep(process.env.LANG),
    TZ: keep(process.env.TZ),
    ZTCODE_RUN_DIR: runDir
  }
  // ห้ามส่งพาธ vault/โปรไฟล์จริงเข้าไป — ผู้เรียกต้องไม่ใส่ USERPROFILE/HOME เอง
  for (const [k, v] of Object.entries(extra)) env[k] = v
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
  if (env.PATH === undefined) delete env.PATH
  return env
}

/** กัน path traversal — ทุก entry ต้องอยู่ใต้ baseDir */
export function assertPathInside(baseDir: string, target: string): void {
  const resolved = path.resolve(baseDir, target)
  const base = path.resolve(baseDir) + path.sep
  if (resolved !== path.resolve(baseDir) && !resolved.startsWith(base)) {
    throw new Error(`Path traversal blocked: ${target}`)
  }
}

/* ---------- ชั้นที่ 3: Pre-Run Destructive Code Scanner ---------- */

const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bos\.remove\s*\(/, label: 'os.remove' },
  { re: /\bos\.unlink\s*\(/, label: 'os.unlink' },
  { re: /\bos\.rmdir\s*\(/, label: 'os.rmdir' },
  { re: /\bshutil\.rmtree\s*\(/, label: 'shutil.rmtree' },
  { re: /\bos\.system\s*\(/, label: 'os.system' },
  { re: /subprocess\.(Popen|call|run)\s*\(/, label: 'subprocess shell' },
  { re: /\bfs\.(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/, label: 'node fs delete' },
  { re: /child_process/, label: 'node child_process' },
  { re: /\bFiles\.delete\s*\(/, label: 'Java Files.delete' },
  { re: /Runtime\.getRuntime\(\)\.exec\s*\(/, label: 'Java Runtime.exec' },
  { re: /ProcessBuilder/, label: 'Java ProcessBuilder' },
  { re: /std::fs::(remove_file|remove_dir|remove_dir_all)/, label: 'rust fs remove' },
  { re: /std::process::Command/, label: 'rust Command' },
  { re: /\bos\.(Remove|RemoveAll|Rename)\s*\(/, label: 'go os.Remove' },
  { re: /os\/exec/, label: 'go os/exec' },
  { re: /\b(unlink|rmdir|rename|exec|shell_exec|system|passthru|popen|proc_open)\s*\(/, label: 'php dangerous fn' },
  { re: /\b(remove|unlink|rmdir|DeleteFile|RemoveDirectory)\s*\(/, label: 'c/c++ delete api' },
  { re: /system\s*\(\s*"/, label: 'c system()' },
  { re: /\.\.\//, label: 'parent path ../' },
  { re: /[A-Za-z]:\\/, label: 'absolute drive path' }
]

export interface DestructiveHit {
  path: string
  line: number
  pattern: string
  snippet: string
}

export function scanDestructiveCode(entries: readonly VirtualEntry[]): DestructiveHit[] {
  const hits: DestructiveHit[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || e.content === undefined) continue
    // ข้ามไฟล์ไบนารี base64
    if (e.encoding === 'base64') continue
    const lines = e.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      // ข้ามคอมเมนต์ SQL ตั้งต้น (seed) — อนุญาต DELETE/DROP ใน DB ได้
      if (e.path.endsWith('.sql') && /^\s*--/.test(line)) continue
      for (const p of DESTRUCTIVE_PATTERNS) {
        if (p.re.test(line)) {
          hits.push({ path: e.path, line: i + 1, pattern: p.label, snippet: line.trim().slice(0, 160) })
          break
        }
      }
    }
  }
  return hits
}

/* ---------- ชั้นที่ 2: flag ระดับภาษา ---------- */

export function phpSandboxArgs(runDir: string, depsCacheDir: string): string[] {
  return [
    '-n',
    '-d', `open_basedir=${runDir}${path.delimiter}${depsCacheDir}`,
    '-d', 'disable_functions=unlink,rmdir,rename,exec,shell_exec,system,passthru,popen,proc_open,pcntl_exec,chmod,chown,symlink,link'
  ]
}

export function nodeSandboxArgs(): string[] {
  // preload บล็อก fs.delete + child_process — ไฟล์จริงอยู่ที่ main/guard-preloads/
  return ['--import', './anti-delete-preload.mjs']
}

export function javaSandboxArgs(): string[] {
  return ['-javaagent:ztcode-fs-guard.jar', '-Dfile.encoding=UTF-8', '-Xmx256m']
}

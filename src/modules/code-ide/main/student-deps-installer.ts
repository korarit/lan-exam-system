import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { STUDENT_INSTALL_REGISTRIES } from '../shared/code-schema'
import {
  registerStudentDepsLayout,
  studentDepsCacheRoot,
  type DepsCacheLayout
} from './code-deps-cache'
import { checkRuntime, getRuntimePathEntries } from './runtime-locator'

/* ============================================================
 * เครื่องนักเรียนติดตั้งไลบรารีเอง (ครู opt-in ผ่าน installPolicy)
 * - ติดตั้งได้เฉพาะ exact name@version ที่ครูอนุมัติใน bundles (npm/pip เท่านั้น)
 * - pin registry ทางการเสมอ (ห้าม override จากฝั่งนักเรียน)
 * - ติดตั้งแบบ isolated ใต้ studentDepsCacheRoot/<packageId>/installed
 *   (ไม่แตะ system site-packages / global node_modules ของเครื่อง)
 * - รายงาน manifest กลับ host ผ่าน module-send action (host เก็บลง grading report)
 * ============================================================ */

const execFileAsync = promisify(execFile)

export const STUDENT_INSTALL_TIMEOUT_MS = 180_000
export const MAX_INSTALL_PACKAGES = 50

export interface ApprovedInstallPackage {
  ecosystem: 'npm' | 'pip'
  name: string
  version: string
}

export interface StudentInstallResult {
  ok: boolean
  installed: string[]
  note: string
  reason?: string | undefined
}

/** ชื่อแพ็กเกจต้องเป็น bare spec เท่านั้น (กัน URL / git / path / shell metachars) */
function validName(ecosystem: 'npm' | 'pip', name: string): boolean {
  if (name.length === 0 || name.length > 128) return false
  if (ecosystem === 'npm') {
    // รองรับ scoped (@scope/name) แต่ห้าม protocol/path traversal
    if (/[:\s$`;"'&|<>\\]/.test(name)) return false
    if (name.includes('..')) return false
    return /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name)
  }
  if (/[:\s$`;"'&|<>\\/]/.test(name)) return false
  if (name.includes('..')) return false
  return /^[a-zA-Z0-9_.-]+$/.test(name)
}

/** เวอร์ชันต้องเป็น version literal (ห้าม range ซับซ้อน/URL/tag) */
function validVersion(version: string): boolean {
  if (version.length === 0 || version.length > 64) return false
  if (/[:\s$`;"'&|<>\\/]/.test(version)) return false
  return /^[a-zA-Z0-9_.\-+~^<>=*]+$/.test(version)
}

function withRuntimePath(extraRuntime: string): NodeJS.ProcessEnv {
  const extra = getRuntimePathEntries([extraRuntime])
  if (extra.length === 0) return { ...process.env }
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ''].filter((s) => s !== '').join(path.delimiter) }
}

async function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: STUDENT_INSTALL_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  })
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
}

export async function installStudentPackages(input: {
  packageId: string
  packages: ApprovedInstallPackage[]
}): Promise<StudentInstallResult> {
  if (input.packages.length === 0) {
    return { ok: false, installed: [], note: '', reason: 'NO_PACKAGES' }
  }
  if (input.packages.length > MAX_INSTALL_PACKAGES) {
    return { ok: false, installed: [], note: '', reason: 'TOO_MANY_PACKAGES' }
  }
  for (const p of input.packages) {
    if ((p.ecosystem !== 'npm' && p.ecosystem !== 'pip') || !validName(p.ecosystem, p.name) || !validVersion(p.version)) {
      return { ok: false, installed: [], note: '', reason: `PACKAGE_REJECTED:${p.name}` }
    }
  }

  const targetRoot = path.join(studentDepsCacheRoot(), input.packageId, 'installed')
  fs.mkdirSync(targetRoot, { recursive: true })
  const installed: string[] = []
  const notes: string[] = []

  const npmPkgs = input.packages.filter((p) => p.ecosystem === 'npm')
  const pipPkgs = input.packages.filter((p) => p.ecosystem === 'pip')

  if (npmPkgs.length > 0) {
    const node = await checkRuntime('node')
    if (!node.found) {
      return { ok: false, installed, note: '', reason: 'NODE_NOT_FOUND' }
    }
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const specs = npmPkgs.map((p) => `${p.name}@${p.version}`)
    try {
      const r = await runCmd(
        npmCmd,
        ['install', '--prefix', targetRoot, '--no-audit', '--no-fund', '--registry', STUDENT_INSTALL_REGISTRIES.npm.indexUrl, ...specs],
        { cwd: targetRoot, env: withRuntimePath('node') }
      )
      installed.push(...npmPkgs.map((p) => `npm:${p.name}@${p.version}`))
      const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-3).join(' | ').slice(0, 300)
      if (tail.length > 0) notes.push(`npm: ${tail}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : 'NPM_FAILED'
      return { ok: false, installed, note: notes.join('\n'), reason: `NPM_INSTALL_FAILED:${msg}` }
    }
  }

  if (pipPkgs.length > 0) {
    const python = await checkRuntime('python')
    if (!python.found || python.path === undefined) {
      return { ok: false, installed, note: notes.join('\n'), reason: 'PYTHON_NOT_FOUND' }
    }
    const siteDir = path.join(targetRoot, 'site-packages')
    fs.mkdirSync(siteDir, { recursive: true })
    const specs = pipPkgs.map((p) => `${p.name}==${p.version}`)
    try {
      const r = await runCmd(
        python.path,
        ['-m', 'pip', 'install', '--target', siteDir, '--index-url', STUDENT_INSTALL_REGISTRIES.pip.indexUrl, '--no-input', '--disable-pip-version-check', ...specs],
        { cwd: targetRoot, env: withRuntimePath('python') }
      )
      installed.push(...pipPkgs.map((p) => `pip:${p.name}==${p.version}`))
      const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-3).join(' | ').slice(0, 300)
      if (tail.length > 0) notes.push(`pip: ${tail}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : 'PIP_FAILED'
      return { ok: false, installed, note: notes.join('\n'), reason: `PIP_INSTALL_FAILED:${msg}` }
    }
  }

  const layout: DepsCacheLayout = {
    root: targetRoot,
    sitePackagesDirs: [],
    jarFiles: [],
    unsupported: []
  }
  const nodeModules = path.join(targetRoot, 'node_modules')
  try {
    if (npmPkgs.length > 0 && fs.statSync(nodeModules).isDirectory()) layout.nodeModulesDir = nodeModules
  } catch {
    /* npm เขียนไม่สำเร็จ — run-cli จะใช้ runtime เครื่องล้วน */
  }
  const siteDir = path.join(targetRoot, 'site-packages')
  try {
    if (pipPkgs.length > 0 && fs.statSync(siteDir).isDirectory()) layout.sitePackagesDirs.push(siteDir)
  } catch {
    /* pip เขียนไม่สำเร็จ — รันด้วย runtime เครื่องล้วน */
  }
  registerStudentDepsLayout(input.packageId, layout)
  return { ok: true, installed, note: notes.join('\n') }
}

/* ============================================================
 * IsolationProbe (VULN-46/47)
 * - Linux: PID/mount/net namespace + container markers
 * - Windows/macOS/Linux: WSL / container env + utility-VM process names
 * ทำงานระดับ userland ล้วน (อ่าน /proc, env, process list)
 * ============================================================ */

export interface IsolationInputs {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** เนื้อหา /proc/self/status (Linux) */
  procStatus?: string | null
  /** เนื้อหา /proc/self/cgroup (Linux) */
  cgroup?: string | null
  /** มี /.dockerenv หรือ /run/.containerenv */
  dockerEnv?: boolean
  containerEnv?: boolean
  /** ชื่อโปรเซสทั้งระบบ (lowercase) — ใช้หา utility VM */
  processNames?: readonly string[]
}

export interface IsolationResult {
  isolated: boolean
  signals: string[]
}

const UTILITY_VM_PATTERNS = [
  /^vmmem(wsl)?$/,
  /^wslservice(\.exe)?$/,
  /^wslhost(\.exe)?$/,
  /^docker desktop(\.exe)?$/,
  /^com\.docker\./,
  /^vmwp(\.exe)?$/,
  /^vboxheadless(\.exe)?$/
]

const CONTAINER_CGROUP_RE = /(?:docker|kubepods|containerd|lxc|libpod|podman)/i

/** อ่านจำนวน layer ของ NSpid — มากกว่า 1 = อยู่ใน nested PID namespace */
export function countPidNamespaceLayers(procStatus: string | null | undefined): number {
  if (!procStatus) return 0
  const line = procStatus.split(/\r?\n/).find((entry) => /^NSpid:/i.test(entry.trim()))
  if (!line) return 0
  const value = line.slice(line.indexOf(':') + 1).trim()
  return value.length === 0 ? 0 : value.split(/\s+/).filter(Boolean).length
}

export function analyzeIsolation(input: IsolationInputs): IsolationResult {
  const signals: string[] = []
  const env = input.env

  if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) {
    signals.push('wsl-env')
  }
  if (
    env.CONTAINER !== undefined ||
    env.KUBERNETES_SERVICE_HOST !== undefined ||
    env.DOCKER_HOST !== undefined
  ) {
    signals.push('container-env')
  }
  if (input.dockerEnv === true) signals.push('container:docker-marker')
  if (input.containerEnv === true) signals.push('container:podman-marker')

  const pidLayers = countPidNamespaceLayers(input.procStatus)
  if (pidLayers > 1) signals.push(`namespace:pid-layers=${pidLayers}`)
  if (input.cgroup && CONTAINER_CGROUP_RE.test(input.cgroup)) {
    signals.push('container:cgroup')
  }

  for (const raw of input.processNames ?? []) {
    const name = raw.toLowerCase()
    if (UTILITY_VM_PATTERNS.some((pattern) => pattern.test(name))) {
      signals.push(`utility-vm:${name.slice(0, 60)}`)
      break
    }
  }

  return { isolated: signals.length > 0, signals }
}

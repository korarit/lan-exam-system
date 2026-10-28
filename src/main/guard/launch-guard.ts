/* ============================================================
 * Phase 4.3 โ€” Launch Guard & Environment Sanitizer
 * เธเธฑเธเธเนเธเธฑเธเธ•เธฃเธงเธเนเธเธ pure (เนเธกเน import Electron) โ€” เธ—เธ”เธชเธญเธ unit เนเธ”เนเธ•เธฃเธ เน
 * เธเธฒเธฃเธ•เธฑเธ”เธชเธดเธ: production = fail-closed เธเธเธดเน€เธชเธเนเธซเธกเธ”เธ—เธธเธเธญเธขเนเธฒเธเธ•เธฑเนเธเนเธ•เนเธเนเธญเธ app.whenReady()
 * ============================================================ */

export interface LaunchFinding {
  kind: 'cli-switch' | 'exec-arg' | 'env'
  name: string
  value: string | null
}

export interface LaunchGuardInput {
  argv: readonly string[]
  execArgv: readonly string[]
  env: NodeJS.ProcessEnv
  /** เธ•เธฃเธงเธเน€เธเธดเนเธกเน€เธ”เธดเธกเธเธฒเธ app.commandLine.hasSwitch (Chromium เธ–เธนเธเธเนเธญเธ flag เธ•เธฑเนเธเนเธ•เนเน€เธฃเธดเนเธก runtime) */
  hasChromiumSwitch?: (name: string) => boolean
}

/** เธฃเธฒเธขเธเธฒเธฃเธชเธงเธดเธ•เธเน CLI เธญเธฑเธเธ•เธฃเธฒเธข (เธซเนเธฒเธกเน€เธฃเธตเธขเธเนเธ”เนเธเธฒเธเธ เธฒเธขเธเธญเธเนเธ production) */
export const DANGEROUS_CLI_SWITCHES: readonly string[] = [
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--remote-allow-origins',
  '--inspect',
  '--inspect-brk',
  '--inspect-port',
  '--load-extension',
  '--disable-extensions-except',
  '--disable-web-security',
  '--allow-running-insecure-content',
  '--host-resolver-rules',
  '--proxy-server'
]

/** เธฃเธฒเธขเธเธฒเธฃ environment variables เธญเธฑเธเธ•เธฃเธฒเธข */
export const DANGEROUS_ENV_KEYS: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'ELECTRON_ENABLE_LOGGING',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'ELECTRON_RENDERER_URL'
]

/** เธชเนเธเธ argv เน€เธ”เธตเธขเธง โ€” เธเธฑเธเธ—เธฑเนเธเนเธเธ `--inspect` เนเธฅเธฐเนเธเธ `--remote-debugging-port=9222` */
function scanArgList(list: readonly string[], kind: LaunchFinding['kind']): LaunchFinding[] {
  const findings: LaunchFinding[] = []
  for (const raw of list) {
    if (!raw.startsWith('--')) continue
    const eq = raw.indexOf('=')
    const bare = eq === -1 ? raw : raw.slice(0, eq)
    const value = eq === -1 ? null : raw.slice(eq + 1)
    const matched = DANGEROUS_CLI_SWITCHES.find((candidate) => candidate === bare)
    if (matched) findings.push({ kind, name: matched, value })
  }
  return findings
}

/** เธ•เธฃเธงเธเธเธฃเธเธ—เธธเธเธเนเธญเธเธ—เธฒเธเธ—เธตเนเนเธเนเธ”เธ เธฒเธขเธเธญเธเธเนเธญเธเธ—เธฒเธเธเธ”ไพฆๅฏ favorite เนเธเธฃเนเธเธฃเธกเนเธ”เน */
export function inspectLaunch(input: LaunchGuardInput): LaunchFinding[] {
  const findings: LaunchFinding[] = [
    ...scanArgList(input.argv, 'cli-switch'),
    ...scanArgList(input.execArgv, 'exec-arg')
  ]
  if (input.hasChromiumSwitch) {
    for (const name of DANGEROUS_CLI_SWITCHES) {
      if (input.hasChromiumSwitch(name)) {
        findings.push({ kind: 'cli-switch', name, value: null })
      }
    }
  }
  for (const key of DANGEROUS_ENV_KEYS) {
    const value = input.env[key]
    if (typeof value === 'string' && value.length > 0) {
      findings.push({ kind: 'env', name: key, value: value.length > 120 ? value.slice(0, 120) : value })
    }
  }
  return findings
}

/** เธชเธดเนเธเธ—เธตเนเธขเธญเธกเนเธ”เนเน€เธเธเธฒเธฐเนเธซเธกเธ” dev (เธซเธเนเธฒเธ•เนเธฒเธ live reload เธเธญเธ electron-vite) */
export function isAllowedInDev(finding: LaunchFinding): boolean {
  return finding.kind === 'env' && finding.name === 'ELECTRON_RENDERER_URL'
}

export function describeFindings(findings: readonly LaunchFinding[]): string {
  return findings
    .map((f) => `${f.kind === 'env' ? 'env' : 'flag'} ${f.name}${f.value !== null ? `=${f.value}` : ''}`)
    .join(' | ')
}

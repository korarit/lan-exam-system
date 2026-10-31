/** อ่าน CLI flags ที่ส่งเข้ามาหลัง `--` เช่น --profile=host --role=student --windowed-kiosk */
export interface RuntimeArgs {
  profileId: string
  role: 'unselected' | 'host' | 'student'
  windowedKiosk: boolean
}

export interface RuntimeArgPolicy {
  /** true = release build (packaged) */
  production: boolean
  /** deployment opt-in when a non-standard window mode is required */
  allowWindowedKiosk?: boolean
  /** optional allowlist for profile ids in production */
  allowedProfiles?: readonly string[]
  /** optional allowlist for roles in production (unselected is always allowed) */
  allowedRoles?: readonly ('host' | 'student')[]
  /** force a single role for this deployment (student kiosk / teacher station) */
  lockedRole?: 'host' | 'student'
}

const ROLE_VALUES = new Set(['host', 'student'])

export function parseRuntimeArgs(argv: readonly string[]): RuntimeArgs {
  const args: RuntimeArgs = {
    profileId: 'default',
    role: 'unselected',
    windowedKiosk: false
  }
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue
    const eq = raw.indexOf('=')
    const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq)
    const value = eq === -1 ? undefined : raw.slice(eq + 1)
    switch (name) {
      case 'profile': {
        if (value && /^[a-zA-Z0-9_-]{1,64}$/.test(value)) args.profileId = value
        break
      }
      case 'role': {
        if (value && ROLE_VALUES.has(value)) args.role = value as RuntimeArgs['role']
        break
      }
      case 'windowed-kiosk': {
        args.windowedKiosk = true
        break
      }
      default:
        // ไม่รู้จัก flag ใด ๆ = ไม่ทำอะไร (launch guard จะเข้มขึ้นใน Phase 4)
        break
    }
  }
  return args
}

/**
 * ปรับค่าที่อ่านได้ตามนโยบายของ build
 * - release build: ปิด windowed kiosk เว้นแต่ deployment เปิด opt-in
 * - release build + allowlist: profile นอกรายการถูกตีกลับเป็นค่าเริ่มต้น
 * - release build + role policy: role นอกรายการถูกล้าง, lockedRole บังคับ role ของเครื่อง
 */
export function applyRuntimeArgPolicy(args: RuntimeArgs, policy: RuntimeArgPolicy): RuntimeArgs {
  if (!policy.production) return args
  const next: RuntimeArgs = { ...args }
  if (!policy.allowWindowedKiosk) next.windowedKiosk = false
  if (policy.allowedProfiles !== undefined) {
    if (!policy.allowedProfiles.includes(next.profileId)) next.profileId = 'default'
  }
  if (
    policy.allowedRoles !== undefined &&
    next.role !== 'unselected' &&
    !policy.allowedRoles.includes(next.role)
  ) {
    next.role = 'unselected'
  }
  if (policy.lockedRole !== undefined) next.role = policy.lockedRole
  return next
}

/** อ่าน CLI flags ที่ส่งเข้ามาหลัง `--` เช่น --profile=host --role=student --windowed-kiosk */
export interface RuntimeArgs {
  profileId: string
  role: 'unselected' | 'host' | 'student'
  windowedKiosk: boolean
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

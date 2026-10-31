import { app } from 'electron'
import type { IpcRouter } from './router'
import type { SelectRoleRequest, SelectRoleResponse, AppInfo } from '@shared/ipc-channels'
import { AppRoleSchema } from '@shared/types/role'

/** สถานะบทบาทปัจจุบันของแอป (แหล่งความจริงอยู่ที่ Main process เสมอ) */
export interface AppRuntimeState {
  profileId: string
  role: 'unselected' | 'host' | 'student'
  /** บทบาทที่ deployment ล็อกไว้ (ถ้ามี) — renderer เปลี่ยนไม่ได้ */
  lockedRole?: 'host' | 'student'
}

export function registerAppHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  hooks: {
    onRoleSelected: (role: 'host' | 'student') => void
    eventSender: (channel: string, payload: unknown) => void
  }
): void {
  router.register('app:select-role', (req: SelectRoleRequest): SelectRoleResponse => {
    // defense-in-depth: ยืนยัน schema อีกชั้น (router validate มาแล้ว)
    const role = AppRoleSchema.safeParse(req.role)
    if (!role.success || role.data === 'unselected') {
      throw new Error('Invalid role')
    }
    if (state.lockedRole !== undefined && role.data !== state.lockedRole) {
      throw new Error('ROLE_LOCKED')
    }
    state.role = role.data
    hooks.onRoleSelected(role.data)
    hooks.eventSender('app:role-changed', { role: role.data })
    return { ok: true, role: role.data }
  })

  router.register('app:get-app-info', (): AppInfo => {
    return {
      appVersion: process.env.npm_package_version ?? '1.0.0',
      platform: process.platform,
      profileId: state.profileId,
      role: state.role,
      isDev: !app.isPackaged
    }
  })
}

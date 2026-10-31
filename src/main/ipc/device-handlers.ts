import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { DeviceEnrollmentService } from '../host/device-enrollment'
import type { ListEnrolledDevicesResponse } from '@shared/ipc-channels'

export interface DeviceEnrollmentServices {
  getEnrollment(): DeviceEnrollmentService
}

/**
 * IPC ของ TOFU device enrollment (host เท่านั้น)
 * - ดูรายการ device ที่ join มาแล้ว (auto-accept)
 * - block/unblock หรือลบ device ออกจากรายการ
 * - การ enroll เองเกิดขึ้นใน attestation flow ไม่ใช่ IPC นี้
 */
export function registerDeviceEnrollmentHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  services: DeviceEnrollmentServices
): void {
  const requireHost = (): DeviceEnrollmentService => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    return services.getEnrollment()
  }

  router.register('host:list-enrolled-devices', (): ListEnrolledDevicesResponse => {
    return { devices: requireHost().list() }
  })

  router.register('host:set-enrolled-device-status', (req) => {
    return { ok: requireHost().setStatus(req.deviceId, req.status) }
  })

  router.register('host:remove-enrolled-device', (req) => {
    return { ok: requireHost().remove(req.deviceId) }
  })
}

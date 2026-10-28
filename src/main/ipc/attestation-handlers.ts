import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { AttestationHostService } from '../attestation/host-verifier'

/* ============================================================
 * Phase 4 — IPC ของ Attestation (ฝั่งเครื่องแม่เท่านั้น)
 * - อ่านสถานะตัวเเยกเอย (dev mode / การบังคับลายเซ็น)
 * - สวิตช์ "บังคับตรวจลายเซ็นจริง" จากหน้าตั้งค่าห้องสอบ
 * ============================================================ */

export interface AttestationServices {
  /** service ตรวจ attestation ของห้องปัจจุบัน (null = ยังไม่เริ่มสอบ) */
  getAttestationHost(): AttestationHostService | null
  isDev(): boolean
  strictToggle: { enforced: boolean }
}

export interface AttestationConfigResponse {
  devMode: boolean
  signatureEnforced: boolean
  platform: string
  trackedStudents: Array<{
    studentId: string
    manifestHash: string | null
    signed: boolean
  }>
}

export function registerAttestationHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  services: AttestationServices
): void {
  router.register('host:get-attestation-config', (): AttestationConfigResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const host = services.getAttestationHost()
    return {
      devMode: services.isDev(),
      signatureEnforced: services.strictToggle.enforced,
      platform: process.platform,
      trackedStudents: host === null
        ? []
        : host.studentsTracked.map((studentId) => {
            const status = host.getStatus(studentId)
            return {
              studentId,
              manifestHash: status.manifestHash,
              signed: status.signed
            }
          })
    }
  })

  router.register('host:set-attestation-enforce', (req) => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    services.strictToggle.enforced = req.enforced === true
    return { ok: true }
  })
}

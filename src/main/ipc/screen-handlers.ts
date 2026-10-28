import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { ScreenStreamController } from '../screen/stream-controller'
import type { ProctorViewService } from '../screen/proctor-view-service'
import type { OkResponse } from '@shared/ipc-channels'

export interface ScreenServices {
  /** ตัวควบคุมหน้าจอฝั่งนักเรียน (null บนเครื่องแม่) */
  getStreamController(): ScreenStreamController | null
  /** บริการดูหน้าจอฝั่งเครื่องแม่ (null บนเครื่องนักเรียน) */
  getProctorViewService(): ProctorViewService | null
}

/**
 * IPC ของ Screen Monitoring (Phase 3c):
 * - student: ขอรายการ display + ส่งเซกเมนต์/ภาพย่อขึ้น main
 * - host: สั่งดูสด/ย้อนหลัง, ดึงเซกเมนต์, Pin หลักฐาน
 */
export function registerScreenHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  services: ScreenServices
): void {
  /* ---------- Student ---------- */

  router.register('student:screen-get-sources', async () => {
    if (state.role !== 'student') throw new Error('STUDENT_ROLE_REQUIRED')
    return services.getStreamController()!.getSources()
  })

  router.register('student:screen-segment', (req): OkResponse => {
    if (state.role !== 'student') throw new Error('STUDENT_ROLE_REQUIRED')
    const ok = services.getStreamController()!.ingestSegment(req)
    return { ok }
  })

  router.register('student:screen-thumbnail', (req): OkResponse => {
    if (state.role !== 'student') throw new Error('STUDENT_ROLE_REQUIRED')
    const ok = services.getStreamController()!.ingestThumbnail(req)
    return { ok }
  })

  /* ---------- Host ---------- */

  router.register('host:screen-inspect', (req): OkResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const service = services.getProctorViewService()
    if (!service) return { ok: false, reason: 'HOST_SERVICE_NOT_READY' }
    if (req.mode === 'stop') {
      service.stopInspect(req.studentId)
      return { ok: true }
    }
    const result = service.startInspect(req.studentId, req.mode, req.displayId)
    return result
  })

  router.register('host:fetch-ring-segment', (req): OkResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const service = services.getProctorViewService()
    if (!service) return { ok: false, reason: 'HOST_SERVICE_NOT_READY' }
    const result = service.fetchSegment(req.studentId, req.segmentId)
    return result
  })

  router.register('host:pin-screen-buffer', (req): OkResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const service = services.getProctorViewService()
    if (!service) return { ok: false, reason: 'HOST_SERVICE_NOT_READY' }
    const result = service.pinBuffer(req.studentId, req.reason)
    return result
  })
}

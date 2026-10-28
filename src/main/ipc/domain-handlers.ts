import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { CoreSessionManager } from '../host/core-session-manager'
import type { DocPreviewController } from '../host/doc-preview'
import type { DomainAllowlistService } from '../host/domain-allowlist'
import type { ApproveDomainResponse, OkResponse } from '@shared/ipc-channels'

export interface DomainServices {
  getSessionManager(): CoreSessionManager
  getDocPreview(): DocPreviewController
  getAllowlist(): DomainAllowlistService
  /** roomId ของห้องที่เปิดอยู่ (null = ยังไม่เปิดห้อง) */
  getSessionId: () => string | null
}

/**
 * IPC ของ Doc Preview & Domain Allowlist (Phase 3a-plus):
 * - ครูเปิดเว็บเอกสารที่เครื่องแม่ (เฉพาะ lobby + Mode 2) → record โดเมนที่เว็บเรียกจริง
 * - ครูอนุมัติรายเดียว/ทั้งหมด → ถ้าสอบกำลังรัน push POLICY_UPDATE ให้ทุกเครื่องออนไลน์ทันที
 */
export function registerDomainHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  services: DomainServices
): void {
  router.register('host:open-doc-preview', (req) => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    return services.getDocPreview().open(req.url)
  })

  router.register('host:close-doc-preview', (): { ok: boolean } => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    return services.getDocPreview().close()
  })

  router.register('host:list-recorded-domains', () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const sessionId = services.getSessionId()
    if (!sessionId) return { records: [] }
    return {
      records: services.getAllowlist().list(sessionId).map((row) => ({
        domain: row.domain,
        topDomain: row.topDomain,
        hits: row.hits,
        source: row.source,
        approved: row.approved,
        lastSeenAtMs: row.lastSeenAtMs
      }))
    }
  })

  router.register('host:approve-domain', (req): ApproveDomainResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const sessionId = services.getSessionId()
    if (!sessionId) return { ok: false, reason: 'ROOM_NOT_OPEN' }
    const allowlist = services.getAllowlist()
    let updatedCount = 0
    if (req.domain === '*') {
      // อนุมัติ/ยกเลิกทั้งหมดที่รอตัดสิน (ครูตรวจแล้วเชื่อมั่นรายการครบ)
      updatedCount = allowlist.approveAll(sessionId)
    } else {
      updatedCount = allowlist.setApproved(sessionId, req.domain, req.approved) ? 1 : 0
      if (updatedCount === 0) return { ok: false, reason: 'DOMAIN_NOT_FOUND' }
    }
    // audit-ready log — ระบบไม่ขวาง แค่บันทึกการตัดสินของครู
    if (req.approved) {
      console.info(`[allowlist] DOMAIN_APPROVED_${req.domain}`)
    } else {
      console.info(`[allowlist] DOMAIN_REVOKED_${req.domain}`)
    }
    // อนุมัติเพิ่มกลางสอบ → เวอร์ชัน +1 เซ็นใหม่รายคน → POLICY_UPDATE ทุกเครื่องออนไลน์ทันที
    if (services.getSessionManager().examState === 'running' || services.getSessionManager().examState === 'collecting') {
      services.getSessionManager().pushPolicyUpdate()
    }
    return { ok: true, updatedCount }
  })

  router.register('host:set-domain-enforcement', (req): OkResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    services.getAllowlist().setEnforcementOverride(req.mode)
    return { ok: true }
  })
}

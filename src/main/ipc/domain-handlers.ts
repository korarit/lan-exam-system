import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { CoreSessionManager } from '../host/core-session-manager'
import type { DocPreviewController } from '../host/doc-preview'
import type { DomainAllowlistService } from '../host/domain-allowlist'
import type { ApproveDomainResponse, OkResponse } from '@shared/ipc-channels'
import { DEFAULT_FORBIDDEN_DOMAINS } from '@shared/policy-schema'

export interface DomainServices {
  getSessionManager(): CoreSessionManager
  getDocPreview(): DocPreviewController
  getAllowlist(): DomainAllowlistService
  /** roomId ของห้องที่เปิดอยู่ (null = ยังไม่เปิดห้อง) */
  getSessionId: () => string | null
  /**
   * R3: บันทึกการตัดสิน allowlist ลง audit chain (ระบุชื่อครู/เวลาใน summary + evidence)
   * - ถ้ายังไม่มีห้อง active (เช่น อยู่ช่วง lobby) ให้ fallback เป็น console.info แบบมี timestamp
   */
  recordAudit?: (eventCode: string, summaryText: string, evidence: Record<string, unknown>) => void
}

/** R1/R3: โดเมนชน AI ที่รู้จัก (suffix-match แบบเดียวกับฝั่ง renderer) */
export function isForbiddenDomain(domain: string): boolean {
  const host = domain.toLowerCase()
  return DEFAULT_FORBIDDEN_DOMAINS.some((f) => host === f || host.endsWith(`.${f}`))
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
      // R1: ห้าม approve-all ถ้ามีแถวชน AI domain ปนอยู่ — บังคับติกรายตัว
      const hasForbidden = allowlist.list(sessionId).some((row) => !row.approved && isForbiddenDomain(row.domain))
      if (hasForbidden) return { ok: false, reason: 'FORBIDDEN_DOMAIN_PRESENT' }
      // อนุมัติ/ยกเลิกทั้งหมดที่รอตัดสิน (ครูตรวจแล้วเชื่อมั่นรายการครบ)
      updatedCount = allowlist.approveAll(sessionId)
    } else {
      updatedCount = allowlist.setApproved(sessionId, req.domain, req.approved) ? 1 : 0
      if (updatedCount === 0) return { ok: false, reason: 'DOMAIN_NOT_FOUND' }
    }
    // R3: audit log ระบุชื่อครู/เวลา + หลักฐาน (ไม่พึ่งแค่ console.info)
    const decidedAt = new Date().toISOString()
    const aiRelated = req.domain === '*' ? false : isForbiddenDomain(req.domain)
    const summary =
      req.domain === '*'
        ? `ครู (HOST) อนุมัติโดเมนทั้งหมด ${updatedCount} รายการ เวลา ${decidedAt}`
        : `ครู (HOST) ${req.approved ? 'อนุมัติ' : 'เพิกถอน'}โดเมน ${req.domain}${aiRelated ? ' (ชน AI — รับทราบความเสี่ยงแล้ว)' : ''} เวลา ${decidedAt}`
    try {
      services.recordAudit?.(req.approved ? 'DOMAIN_ALLOWLIST_APPROVED' : 'DOMAIN_ALLOWLIST_REVOKED', summary, {
        domain: req.domain,
        approved: req.approved,
        updatedCount,
        aiRelated,
        decidedBy: 'HOST',
        decidedAt
      })
    } catch {
      /* audit เขียนไม่ได้ — คง console ด้านล่างไว้เป็นร่องรอยสุดท้าย */
    }
    console.info(`[allowlist] ${req.approved ? 'DOMAIN_APPROVED' : 'DOMAIN_REVOKED'}_${req.domain} decidedBy=HOST decidedAt=${decidedAt} updatedCount=${updatedCount}`)
    // อนุมัติเพิ่มกลางสอบ → เวอร์ชัน +1 เซ็นใหม่รายคน → POLICY_UPDATE ทุกเครื่องออนไลน์ทันที
    if (services.getSessionManager().examState === 'running' || services.getSessionManager().examState === 'collecting') {
      services.getSessionManager().pushPolicyUpdate()
    }
    return { ok: true, updatedCount }
  })

  router.register('host:clear-recorded-domains', (): OkResponse => {
    // R2: ล้างรายการ record ทั้งห้องเพื่อเริ่ม record ใหม่ (เฉพาะครู)
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const sessionId = services.getSessionId()
    if (!sessionId) return { ok: false, reason: 'ROOM_NOT_OPEN' }
    const removed = services.getAllowlist().clear(sessionId)
    const decidedAt = new Date().toISOString()
    try {
      services.recordAudit?.('DOMAIN_ALLOWLIST_CLEARED', `ครู (HOST) ล้างรายการโดเมนที่ record (${removed} แถว) เวลา ${decidedAt}`, {
        removed,
        decidedBy: 'HOST',
        decidedAt
      })
    } catch {
      /* ข้าม */
    }
    console.info(`[allowlist] DOMAIN_LIST_CLEARED decidedBy=HOST decidedAt=${decidedAt} removed=${removed}`)
    return { ok: true }
  })

  router.register('host:set-domain-enforcement', (req): OkResponse => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    services.getAllowlist().setEnforcementOverride(req.mode)
    return { ok: true }
  })
}

import { WebContentsView, type BrowserWindow } from 'electron'
import { evaluateUrlAgainstWhitelist } from './url-filter'
import type { DetectionEvent, DomainEnforcement } from '@shared/policy-schema'
import type { DocsUrlLogPayload } from '@shared/protocol-schema'

/* ============================================================
 * DocsViewController (Phase 5 — Mode 2)
 * - WebContentsView แยก sandbox/session (`nopersist:exam-docs-*`) แบ่งครึ่ง
 *   ด้านขวาของหน้าต่างนักเรียน (ใต้แถบ HUD) — ตัวแอปข้อสอบครอบครึ่งซ้าย
 * - ดักการนำทาง 3 ชั้น: setWindowOpenHandler → will-navigate/will-redirect
 *   → webRequest.onBeforeRequest (mainFrame + subFrame + XHR/fetch)
 * - เทียบกับ allowedDomains จาก Signed Policy แบบ default-deny:
 *   - อยู่ใน whitelist → บันทึกประวัติ DOCS_URL_LOG (ปกติ)
 *   - นอก whitelist → UNAUTHORIZED_DOCS_URL_ATTEMPT (critical) เสมอ;
 *     ถ้า enforcement = 'block' → preventDefault/cancel + โชว์หน้าเตือน
 * - หลุดเครื่องแม่ (frozen) → เข้า setHidden(true) ด้วย (fail-closed)
 * ============================================================ */

/**
 * ความสูงที่เว้นบนสุดให้เนื้อหา iframe เริ่ม
 * 56 = แถบ HudBar + 44 = แถบ URL ของ DocsToolbar (renderer) — ปรับคู่เลย์เอาต์
 */
export const DOCS_HUD_HEIGHT = 100

export interface DocsViewControllerOptions {
  getWindow: () => BrowserWindow | null
  /** policy ปัจจุบัน (allowedDomains + warn/block) — null = ยังไม่ได้รับนโยบาย */
  getPolicy: () => { allowedDomains: string[]; enforcement: DomainEnforcement } | null
  /** ปุ่มฟ้องเข้าท่อ GuardEngine (GUARD_EVENT) */
  emit: (event: DetectionEvent) => void
  /** ประวัติโดเมนอนุญาต → DOCS_URL_LOG ไปเครื่องแม่ */
  logUrl: (payload: DocsUrlLogPayload) => void
  /** push สถานะแผงเอกสารไป renderer ('exam:docs-state') */
  pushState: (state: DocsPanelState) => void
  now?: () => number
}

export interface DocsPanelState {
  open: boolean
  url: string | null
  allowedDomains: string[]
  enforcement: DomainEnforcement
  /** ลิงก์สุดท้ายที่โดนบล็อก (แสดงข้อความป้ายเตือนในแผง) */
  blockedUrl: string | null
}

const BLOCKED_PAGE_HTML = (url: string): string => `<!doctype html>
<html lang="th"><meta charset="utf-8"><body style="margin:0;font-family:sans-serif;background:#0f172a;color:#fda4af;display:flex;height:100vh">
<div style="margin:auto;max-width:32rem;padding:2rem">
<h1 style="font-size:1.25rem">ไม่อนุญาตให้เข้าถึงเว็บไซต์นี้ในการสอบ</h1>
<p style="color:#94a3b8">${url.replace(/</g, '&lt;').slice(0, 200)}</p>
<p style="color:#94a3b8">เครื่องแม่ได้รับการแจ้งเตือนหลักฐานเรียบร้อยแล้ว</p>
</div></body></html>`

/** หน้าแรกของแผงเอกสาร: รวมลิงก์โดเมนที่ครูอนุมัติ (default-deny) */
export const DOCS_HOME_URL = 'ztexam-docs:home'

const DOCS_HOME_HTML = (domains: string[]): string => `<!doctype html>
<html lang="th"><meta charset="utf-8"><body style="margin:0;font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem">
<h1 style="font-size:1.15rem;margin:0 0 .5rem">เอกสารที่อนุญาตของห้องนี้</h1>
<p style="color:#94a3b8">เปิดได้เฉพาะลิงก์ด้านล่าง (โดเมนนอกรายการถือว่าผิดกติกา)</p>
<ul style="margin-top:1rem;line-height:2">
${domains.length === 0 ? '<li style="color:#64748b">ครูยังไม่ได้อนุญาตโดเมนใด</li>' : domains.map((domain) =>
  `<li><a href="https://${domain}" style="color:#7dd3fc">${domain}</a></li>`
).join('\n')}
</ul></body></html>`

export class DocsViewController {
  private view: WebContentsView | null = null
  private sessionId: string | null = null
  private open = false
  private hidden = false
  private lastUrl: string | null = null
  /** ลิงก์ของหน้าเปิดครั้งแรกจากครู (ExamStarted docsUrl) */
  private preferredStartUrl: string | null = null
  private readonly now: () => number

  constructor(private readonly opts: DocsViewControllerOptions) {
    this.now = opts.now ?? Date.now
  }

  get isOpen(): boolean {
    return this.open
  }

  /** URL ที่ครูส่งมาตอน EXAM_STARTED — แผงจะเริ่มหน้านี้ครั้งแรกที่เปิด */
  setPreferredStartUrl(url: string | null): void {
    this.preferredStartUrl = url && url.trim() !== '' ? url : null
  }

  setSessionId(sessionId: string | null): void {
    if (this.sessionId === sessionId) return
    this.destroy()
    this.sessionId = sessionId
  }

  private ensureView(): WebContentsView | null {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view
    const view = new WebContentsView({
      webPreferences: {
        // session แยกส่วน ไม่ persist และ sandbox — แยกชั้นจากแอปข้อสอบเด็ดขาด
        partition: `nopersist:exam-docs-${this.sessionId ?? 'default'}`,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false,
        spellcheck: false
      }
    })
    this.view = view
    this.attachInterceptors(view)
    return view
  }

  private pushState(): void {
    const policy = this.opts.getPolicy()
    this.opts.pushState({
      open: this.open && !this.hidden,
      url: this.lastUrl,
      allowedDomains: policy?.allowedDomains ?? [],
      enforcement: policy?.enforcement ?? 'warn',
      blockedUrl: this.lastBlockedUrl
    })
  }

  /**
   * เปิด/ปิดแผงเอกสาร (โหมด Mode 2 เท่านั้น — ตรวจโดยผู้เรียก)
   * เปิดครั้งแรก → โหลดหน้าแรก (docsUrl ของครู ถ้ามี — เมื่อถูกตามกติกา)
   */
  toggle(open: boolean): { ok: boolean } {
    if (this.sessionId === null) return { ok: false }
    const window = this.opts.getWindow()
    const policy = this.opts.getPolicy()
    if (open && (!window || !policy)) return { ok: false }
    this.open = open
    if (open) {
      this.hidden = false
      const view = this.ensureView()
      if (view && window && !window.isDestroyed()) {
        window.contentView.addChildView(view)
        this.syncBounds(window)
        if (view.webContents.getURL() === '') {
          const startUrl = this.resolveHomeUrl(policy?.allowedDomains ?? [])
          void view.webContents.loadURL(startUrl)
        }
      }
      window?.on('resize', this.onResize)
    } else {
      const windowNow = window
      windowNow?.off('resize', this.onResize)
      if (this.view && windowNow && !windowNow.isDestroyed()) {
        windowNow.contentView.removeChildView(this.view)
      }
      this.lastBlockedUrl = null
    }
    this.pushState()
    return { ok: true }
  }

  /** จุดบังคับจาก main: หลุดการติดต่อ → ซ่อนเอกสาร (fail-closed) */
  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return
    this.hidden = hidden
    if (hidden && this.view) {
      const window = this.opts.getWindow()
      if (window && !window.isDestroyed()) window.contentView.removeChildView(this.view)
    } else if (!hidden && this.open && this.view) {
      const window = this.opts.getWindow()
      if (window && !window.isDestroyed()) {
        window.contentView.addChildView(this.view)
        this.syncBounds(window)
      }
    }
    this.pushState()
  }

  /** renderer: กดปุ่ม URL bar / Home / ลิงก์ home — ตรวจกับกติกาแล้วค่อยโหลด */
  navigate(url: string): { ok: boolean; reason?: 'not-open' | 'invalid-url' | 'off-whitelist' } {
    // ปุ่ม Home: กลับไปรายการโดเมนอนุญาต (data url เขียนเอง — ไม่ต้องผ่าน whitelist)
    if (url === DOCS_HOME_URL) {
      const policy = this.opts.getPolicy()
      if (policy === null) return { ok: false, reason: 'not-open' }
      const view = this.ensureView()
      if (view && this.open) {
        void view.webContents
          .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(DOCS_HOME_HTML(policy.allowedDomains))}`)
          .catch(() => undefined)
        return { ok: true }
      }
      return { ok: false, reason: 'not-open' }
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, reason: 'invalid-url' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'invalid-url' }
    }
    const policy = this.opts.getPolicy()
    if (policy === null) return { ok: false, reason: 'not-open' }
    const verdict = evaluateUrlAgainstWhitelist(parsed.toString(), policy.allowedDomains)
    if (verdict === 'allowed') {
      this.opts.logUrl({
        url: parsed.toString(),
        source: 'docs',
        topDomain: parsed.hostname,
        occurredAtMs: this.now()
      })
      const view = this.ensureView()
      if (view && this.open) void view.webContents.loadURL(parsed.toString())
      return { ok: true }
    }
    // นอกรายการ (หรือ IP ตรง) → เป็น event วิกฤต + แจ้งเครื่องแม่เสมอ
    this.opts.emit({
      eventId: `docs-url-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      code: 'UNAUTHORIZED_DOCS_URL_ATTEMPT',
      severity: 'critical',
      score: 40,
      detectorId: 'docs-filter',
      detail: {
        url: parsed.toString().slice(0, 400),
        verdict,
        mode: policy.enforcement
      },
      occurredAtMs: this.now()
    })
    if (policy.enforcement === 'block') {
      this.lastBlockedUrl = parsed.toString()
      const view = this.ensureView()
      if (view && this.open) {
        void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BLOCKED_PAGE_HTML(parsed.toString()))}`)
      }
    }
    return { ok: false, reason: 'off-whitelist' }
  }

  /** ตัดเปิดแผงครั้งแรกให้หน้าแรก — docsUrl จากครูต้องอยู่ใน whitelist ก่อนถึงจะโหลด */
  private resolveHomeUrl(allowedDomains: string[]): string {
    const preferred = this.preferredStartUrl
    this.preferredStartUrl = null
    if (preferred) {
      try {
        const parsed = new URL(preferred)
        const verdict = evaluateUrlAgainstWhitelist(preferred, allowedDomains)
        if (verdict === 'allowed') {
          // โดเมนที่เปิดในหน้าที่ครูเตรียม (docsUrl) ถึงนับเป็นการเข้าถึงตามตั้งใจของห้อง
          this.opts.logUrl({
            url: parsed.toString(),
            source: 'docs',
            topDomain: parsed.hostname,
            occurredAtMs: this.now()
          })
          return preferred
        }
      } catch {
        // URL เสีย → ไปหน้า home
      }
    }
    return `data:text/html;charset=utf-8,${encodeURIComponent(DOCS_HOME_HTML(allowedDomains))}`
  }

  private lastBlockedUrl: string | null = null

  private readonly onResize = (): void => {
    const window = this.opts.getWindow()
    if (window && !window.isDestroyed() && this.open) this.syncBounds(window)
  }

  private syncBounds(window: BrowserWindow): void {
    if (!this.view) return
    const body = window.getContentBounds()
    const half = Math.floor(body.width / 2)
    this.view.setBounds({
      x: half,
      y: DOCS_HUD_HEIGHT,
      width: body.width - half,
      height: Math.max(0, body.height - DOCS_HUD_HEIGHT)
    })
  }

  private isDocsHomeUrl(url: string): boolean {
    return url.startsWith('data:text/html') && url.includes('%E0%B9%80%E0%B8%AD%E0%B8%81%E0%B8%AA%E0%B8%B2%E0%B8%A3')
  }

  private attachInterceptors(view: WebContentsView): void {
    const contents = view.webContents
    /**
     * ตรวจคำขอ URL หนึ่งชิ้น:
     * - allowed → บันทึกประวัติ (เฉพาะ navigation ระดับหน้า เพื่อลดเสียงรบกวน XHR/CDN)
     * - นอกกรอบ → ฟ้อง UNAUTHORIZED_DOCS_URL_ATTEMPT เสมอ
     */
    const judge = (rawUrl: string, options: { logIfAllowed: boolean }): 'allowed' | 'denied' | 'direct-ip' => {
      let verdict: 'allowed' | 'denied' | 'direct-ip'
      let target = rawUrl
      let hostname = ''
      try {
        const parsed = new URL(rawUrl)
        target = parsed.toString()
        hostname = parsed.hostname
        verdict = evaluateUrlAgainstWhitelist(target, this.opts.getPolicy()?.allowedDomains ?? [])
      } catch {
        verdict = 'denied'
      }
      if (verdict === 'allowed') {
        if (options.logIfAllowed && hostname !== '') {
          this.logVisited(target, hostname)
        }
      } else {
        this.reportAttempt(target, verdict)
      }
      return verdict
    }

    // 1) ปฏิเสธการเด้งหน้าต่างใหม่เสมอ — ถ้า URL ใหม่อยู่ใน whitelist ให้โหลดในกรอบเดิม
    contents.setWindowOpenHandler(({ url }) => {
      const verdict = judge(url, { logIfAllowed: true })
      if (verdict === 'allowed') {
        void contents.loadURL(url).catch(() => undefined)
      }
      return { action: 'deny' }
    })

    // 2) การนำทางหน้าชั้นบน: บล็อกเมื่อ enforcement = block (+ โชว์หน้าเตือนในกรอบ)
    contents.on('will-navigate', (event, url) => {
      if (this.isDocsHomeUrl(url)) return
      const verdict = judge(url, { logIfAllowed: true })
      if (verdict !== 'allowed' && (this.opts.getPolicy()?.enforcement ?? 'warn') === 'block') {
        event.preventDefault()
        this.showBlockedPage(contents, url)
      }
    })
    contents.on('will-redirect', (event, url) => {
      const verdict = judge(url, { logIfAllowed: true })
      if (verdict !== 'allowed' && (this.opts.getPolicy()?.enforcement ?? 'warn') === 'block') {
        event.preventDefault()
      }
    })

    // 3) ทุก request ระดับ resource ถูกตรวจเสมอ (XHR/fetch/subFrame — ตาม whitelist)
    contents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        const verdict = judge(details.url, { logIfAllowed: details.resourceType === 'mainFrame' })
        if (verdict !== 'allowed' && (this.opts.getPolicy()?.enforcement ?? 'warn') === 'block') {
          callback({ cancel: true })
          return
        }
        callback({})
      }
    )

    contents.on('did-navigate', (_event, url) => {
      this.lastUrl = this.isDocsHomeUrl(url) ? null : url
      this.pushState()
    })
    contents.on('did-fail-load', () => {
      this.pushState()
    })
    contents.on('did-start-navigation', (_event, url) => {
      this.lastUrl = url
    })
  }

  private logVisited(target: string, hostname: string): void {
    this.opts.logUrl({
      url: target.slice(0, 2_048),
      source: 'docs',
      topDomain: hostname,
      occurredAtMs: this.now()
    })
  }

  private showBlockedPage(contents: { loadURL(url: string): Promise<void> }, url: string): void {
    this.lastBlockedUrl = url
    void contents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BLOCKED_PAGE_HTML(url))}`)
      .catch(() => undefined)
  }

  private reportAttempt(target: string, verdict: 'denied' | 'direct-ip'): void {
    const policy = this.opts.getPolicy()
    // data:/about: ปลายทางที่เราเขียนเอง — ไม่นับเป็นพยายามสู่เว็บ
    if (target.startsWith('data:') || target.startsWith('about:')) return
    this.opts.emit({
      eventId: `docs-url-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      code: 'UNAUTHORIZED_DOCS_URL_ATTEMPT',
      severity: 'critical',
      score: 40,
      detectorId: 'docs-filter',
      detail: {
        url: target.slice(0, 400),
        verdict,
        mode: policy?.enforcement ?? 'warn'
      },
      occurredAtMs: this.now()
    })
  }

  /** ใช้ตอนจบการสอบ/เปลี่ยนห้อง — ทิ้งเฟรมเอกสารและถอดออกจากหน้าต่าง */
  destroy(): void {
    if (this.view && !this.view.webContents.isDestroyed()) {
      try {
        this.view.webContents.close()
      } catch {
        // ปล่อย
      }
    }
    const window = this.opts.getWindow()
    if (this.view && window && !window.isDestroyed()) {
      window.contentView.removeChildView(this.view)
      window.off('resize', this.onResize)
    }
    this.view = null
    this.open = false
    this.hidden = false
    this.lastUrl = null
    this.lastBlockedUrl = null
  }
}

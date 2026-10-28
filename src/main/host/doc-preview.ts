import { BrowserWindow, WebContentsView } from 'electron'
import os from 'node:os'
import type { HostRoomManager } from '../network/host-room'
import type { DomainAllowlistService } from './domain-allowlist'
import { DomainRecorder, DomainRecorderHook, type RecordedDomainRecord } from './domain-recorder'

/* ============================================================
 * DocPreviewController (Phase 3a-plus) — หน้า "เตรียมเอกสาร" ของเครื่องแม่
 * - เปิดได้เฉพาะช่วง Lobby + Mode 2 (In-App Docs)
 * - ครูใช้เหมือนเบราว์เซอร์ปกติ (ไปหน้าอื่น/เปิดเว็บอื่นก็ได้)
 *   โดเมนทุก request ถูก record รวมกันในรายการเดียวต่อห้อง
 * - ปิดหน้าต่าง → detach + flush รายการค้างลง DB
 * ============================================================ */

export interface DocPreviewControllerOptions {
  getRoom: () => HostRoomManager | null
  allowlist: DomainAllowlistService
  /** push event ไป renderer ฝั่งครู (host:recorded-domains-updated) */
  sendHostEvent: (channel: string, payload: unknown) => void
}

export class DocPreviewController {
  private window: BrowserWindow | null = null
  private view: WebContentsView | null = null
  private recorder: DomainRecorder | null = null
  private sessionId: string | null = null

  constructor(private readonly opts: DocPreviewControllerOptions) {}

  get isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed()
  }

  /** เปิด/พาไปยัง URL (เปิดซ้ำได้ — ครูเปิดกี่เว็บก็ได้ โดเมนรวมกันในรายการเดียว) */
  open(url: string): { ok: boolean; reason?: string } {
    const room = this.opts.getRoom()
    if (!room?.room) return { ok: false, reason: 'ROOM_NOT_OPEN' }
    if (room.examMode !== 'in-app-docs') return { ok: false, reason: 'MODE_NOT_IN_APP_DOCS' }
    // Record ก่อนเริ่มสอบเท่านั้น — กันครูเผลอเปิดเว็บเสี่ยงระหว่างการคุมสอบ
    if (room.examStatus !== 'lobby') return { ok: false, reason: 'EXAM_NOT_IN_LOBBY' }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, reason: 'INVALID_URL' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'INVALID_URL' }
    }

    // เปิดครั้งแรกในห้องเดียวกัน → พาหน้าต่างเดิมไป URL ใหม่ (record ต่อในรายการเดียว)
    if (this.isOpen && this.view) {
      void this.view.webContents.loadURL(url)
      return { ok: true }
    }

    const roomId = room.room.roomId
    this.sessionId = roomId

    const recorder = new DomainRecorder({
      onFlush: (records) => this.onFlush(records),
      localAddresses: localMachineAddresses()
    })
    this.recorder = recorder

    const view = new WebContentsView({
      webPreferences: {
        // partition ต่อห้อง — แยก cache/cookies ออกจากตัวแอปและห้องอื่น
        partition: `doc-preview-${roomId}`,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false
      }
    })
    this.view = view

    // หน้าต่างครูสำหรับใช้เอกสาร (ปล่อยให้ใช้งานเหมือนเบราว์เซอร์ปกติ)
    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      title: 'ZT-Exam — เตรียมเอกสาร (record โดเมนที่เว็บเรียกใช้)',
      autoHideMenuBar: true,
      backgroundColor: '#0f172a'
    })
    this.window = win
    win.contentView.addChildView(view)
    const syncBounds = (): void => {
      view.setBounds({ x: 0, y: 0, width: win.getContentBounds().width, height: win.getContentBounds().height })
    }
    syncBounds()
    win.on('resize', syncBounds)

    // hook ทุก request ที่หน้าเว็บเรียกจริง (main frame + subresources + fetch/XHR)
    new DomainRecorderHook(() => {
      if (!this.view || this.view.webContents.isDestroyed()) return null
      return this.view.webContents.getURL() || null
    }).attachRecord(view.webContents.session, recorder)

    // โดเมนของ URL ชั้นบน = auto-approved (top-url)
    view.webContents.on('did-navigate', (_event, topUrl) => {
      recorder.recordTopUrl(topUrl)
      this.pushRecords()
    })

    win.on('closed', () => {
      // ปิด preview → detach (flush รายการค้างก่อนถอด)
      this.recorder?.detach()
      this.recorder = null
      this.view = null
      this.window = null
      this.pushRecords()
    })

    void view.webContents.loadURL(url)
    return { ok: true }
  }

  /** ปิด preview จากคำสั่ง IPC */
  close(): { ok: boolean } {
    if (!this.isOpen) {
      // แค่เคลียร์ค้างกรณี window ถูกปิดไปก่อนหน้า
      this.recorder?.detach()
      this.recorder = null
      return { ok: true }
    }
    this.window?.close() // 'closed' handler จะ detach + flush เอง
    return { ok: true }
  }

  private onFlush(records: RecordedDomainRecord[]): void {
    if (!this.sessionId || records.length === 0) return
    this.opts.allowlist.recordBatch(this.sessionId, records)
    this.pushRecords()
  }

  private pushRecords(): void {
    if (!this.sessionId) return
    // แปลงเป็น shape ของ RecordedDomainItem (ไม่รวม firstSeenMs — ใช้ภายใน)
    const records = this.opts.allowlist.list(this.sessionId).map((row) => ({
      domain: row.domain,
      topDomain: row.topDomain,
      hits: row.hits,
      source: row.source,
      approved: row.approved,
      lastSeenAtMs: row.lastSeenAtMs
    }))
    this.opts.sendHostEvent('host:recorded-domains-updated', { records })
  }
}

function localMachineAddresses(): string[] {
  const result: string[] = []
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.address) result.push(info.address.toLowerCase())
    }
  }
  return result
}

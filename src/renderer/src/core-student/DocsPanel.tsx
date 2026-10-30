import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpenText, Home, RotateCw, TriangleAlert } from 'lucide-react'
import { useDocsStore } from '../store/docs-store'
import { useAppStore } from '../store/app-store'

/* ============================================================
 * DocsToolbar + พื้นที่เอกสาร (Phase 5 — Mode 2)
 * - แถบด้านบนของครึ่งขวา: URL bar + Home + ปุ่มเปิด/ปิดแผง
 * - พื้นที่ด้านล่างเป็น "เฟรมเปล่า" — WebContentsView ของ main process
 *   มาวางทับตรงนี้ (view bounds = y จาก DOCS_HUD_HEIGHT ถึงล่างจอ)
 * ============================================================ */

const DOCS_HOME_URL = 'ztexam-docs:home'

/** R6: ตรวจว่า host ของ URL ปัจจุบันยังอยู่ใน allowedDomains (exact/subdomain) */
function isHostAllowed(host: string | null, allowedDomains: string[]): boolean {
  if (!host) return false
  const h = host.toLowerCase()
  return allowedDomains.some((a) => {
    const allowed = a.toLowerCase()
    return h === allowed || h.endsWith(`.${allowed}`)
  })
}

function hostnameOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

export default function DocsPanel(): React.JSX.Element {
  const docs = useDocsStore((s) => s.docs)
  const notify = useAppStore((s) => s.notify)
  const [urlDraft, setUrlDraft] = useState('')
  /* R8: สถานะปุ่ม "เปิดเอกสารอีกครั้ง" (loading ระหว่าง retry) */
  const [reopening, setReopening] = useState(false)

  // sync URL ปัจจุบันของแผงกับ URL bar (ตอนคลิกลิงก์ในเอกสารด้วย)
  useEffect(() => {
    if (docs?.url !== null && docs?.url !== undefined) setUrlDraft(docs.url)
    else setUrlDraft('')
  }, [docs?.url])

  if (!docs?.open) return <div className="flex-1" />

  const submitUrl = (): void => {
    const raw = urlDraft.trim()
    if (raw === '') return
    const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`
    void window.ztExam.docsNavigate({ url })
  }

  // R6: reload ได้เฉพาะ URL ที่ยังอยู่ในรายการอนุญาต — กัน reload URL ที่เพิ่งโดน revoke เงียบๆ
  // (url === null = หน้า home ที่ main เขียนเอง → โหลดซ้ำได้เสมอ)
  const reloadBlocked = docs.url !== null && !isHostAllowed(hostnameOf(docs.url), docs.allowedDomains)

  const reload = (): void => {
    if (reloadBlocked) {
      notify({ severity: 'warning', message: 'URL นี้ถูกเพิกถอนจากรายการอนุญาตแล้ว — โหลดซ้ำไม่ได้' })
      return
    }
    if (docs.url) void window.ztExam.docsNavigate({ url: docs.url })
    else void window.ztExam.docsNavigate({ url: DOCS_HOME_URL })
  }

  // R8: เปิดเอกสารอีกครั้งเมื่อ WebContentsView สร้างช้า/ล้มเหลว
  const reopenDocs = (): void => {
    setReopening(true)
    void window.ztExam
      .docsToggle({ open: true })
      .then((res) => {
        if (!res.ok) {
          notify({ severity: 'warning', message: 'เปิดแผงเอกสารไม่สำเร็จ — ลองอีกครั้ง' })
        }
      })
      .catch(() => {
        notify({ severity: 'critical', message: 'เปิดแผงเอกสารไม่สำเร็จ' })
      })
      .finally(() => setReopening(false))
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* แถบเครื่องมือ (สูง 44px — main อ้าง DOCS_HUD_HEIGHT=100 ที่ 56+44) */}
      <div className="flex h-11 items-center gap-2 border-b border-slate-800 bg-slate-950 px-3">
        <button
          type="button"
          title="กลับรายการโดเมนที่อนุญาต"
          onClick={() => void window.ztExam.docsNavigate({ url: DOCS_HOME_URL })}
          className="rounded-lg border border-slate-700 p-1.5 text-slate-300 hover:bg-slate-800"
        >
          <Home size={14} />
        </button>
        <form
          className="flex flex-1 items-center"
          onSubmit={(e) => {
            e.preventDefault()
            submitUrl()
          }}
        >
          <input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            spellCheck={false}
            placeholder="พิมพ์เว็บเอกสารที่อยู่ในรายการอนุญาต เช่น docs.python.org"
            className="h-7 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 font-mono text-xs text-slate-200 focus:border-sky-600 focus:outline-none"
          />
        </form>
        <button
          type="button"
          title={reloadBlocked ? 'URL นี้ถูกเพิกถอนแล้ว — โหลดซ้ำไม่ได้' : 'โหลดซ้ำ'}
          disabled={reloadBlocked}
          onClick={reload}
          className="rounded-lg border border-slate-700 p-1.5 text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateCw size={14} />
        </button>
        <button
          type="button"
          title="ปิดแผงเอกสาร"
          onClick={() => void window.ztExam.docsToggle({ open: false })}
          className="rounded-lg border border-slate-700 p-1.5 text-slate-300 hover:bg-slate-800"
        >
          <BookOpenText size={14} />
        </button>
      </div>

      {/* R6: คำอธิบายเมื่อปุ่ม reload ถูกปิด (URL เพิ่งโดน revoke กลางสอบ) */}
      {reloadBlocked && (
        <div className="border-b border-slate-800 bg-slate-900/80 px-3 py-1.5 text-[11px] text-slate-400">
          หน้านี้ถูกเพิกถอนจากรายการอนุญาตแล้ว — โหลดซ้ำไม่ได้ (กด Home เพื่อกลับรายการที่อนุญาต)
        </div>
      )}

      {/* ไฟล์/ลิงก์ถูกบล็อกล่าสุด (เหตุการณ์วิกฤตถูกฟ้องไปเครื่องแม่แล้ว) */}
      {docs.blockedUrl && (
        <div className="flex items-start gap-2 border-b border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-200">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span className="break-all">ไม่อนุญาตให้เข้าถึง: {docs.blockedUrl}</span>
        </div>
      )}

      {/* R4: โหมดตรวจจับอย่างเดียว — แบนเนอร์เหลืองเมื่ออยู่นอก allowlist (ไม่ใช่แค่แจ้งครูเงียบๆ) */}
      {!docs.blockedUrl && docs.enforcement === 'warn' && docs.warnUrl && (
        <div className="flex items-start gap-2 border-b border-amber-800/60 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span className="break-all">
            เว็บนี้อยู่นอกเอกสารที่อนุญาต ({docs.warnUrl}) — เปิดดูได้แต่ครูได้รับแจ้งเตือนแล้ว
          </span>
        </div>
      )}

      {/* R8: WebContentsView สร้างช้า/ล้มเหลว — โชว์สาเหตุ + ปุ่มเปิดอีกครั้ง */}
      {docs.viewError && (
        <div className="flex items-center gap-2 border-b border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-200">
          <TriangleAlert size={14} className="shrink-0" />
          <span className="flex-1">{docs.viewError}</span>
          <button
            type="button"
            disabled={reopening}
            onClick={reopenDocs}
            className="shrink-0 rounded-lg border border-red-700/60 px-2.5 py-1 text-xs text-red-100 transition hover:bg-red-900/60 disabled:opacity-40"
          >
            {reopening ? 'กำลังเปิด…' : 'เปิดเอกสารอีกครั้ง'}
          </button>
        </div>
      )}

      {/* พื้นที่ที่ main process วาง WebContentsView ทับ (ไม่เรนเดอร์อะไรข้างใน) */}
      <div
        className="flex-1 bg-slate-950"
        data-docs-space="reserved-for-webcontentsview"
      >
        <div className="flex h-full items-center justify-center p-6">
          <div className="text-center text-xs text-slate-600">
            <div className="mb-1 flex items-center justify-center gap-1 text-slate-500">
              <ArrowLeft size={12} />
              <ArrowRight size={12} />
            </div>
            หน้าเอกสารจะปรากฏตรงนี้ (โดเมนนอกรายการถือว่าผิดกติกา — เครื่องแม่รับแจ้งเตือนทันที)
            <div>
              <button
                type="button"
                disabled={reopening}
                onClick={reopenDocs}
                className="mt-2 rounded-lg border border-slate-800 px-2.5 py-1 text-[11px] text-slate-500 transition hover:border-slate-600 hover:text-slate-300 disabled:opacity-40"
              >
                {reopening ? 'กำลังเปิดเอกสาร…' : 'โหลดไม่ขึ้น? เปิดเอกสารอีกครั้ง'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

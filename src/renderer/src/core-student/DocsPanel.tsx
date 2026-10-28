import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpenText, Home, RotateCw, TriangleAlert } from 'lucide-react'
import { useDocsStore } from '../store/docs-store'

/* ============================================================
 * DocsToolbar + พื้นที่เอกสาร (Phase 5 — Mode 2)
 * - แถบด้านบนของครึ่งขวา: URL bar + Home + ปุ่มเปิด/ปิดแผง
 * - พื้นที่ด้านล่างเป็น "เฟรมเปล่า" — WebContentsView ของ main process
 *   มาวางทับตรงนี้ (view bounds = y จาก DOCS_HUD_HEIGHT ถึงล่างจอ)
 * ============================================================ */

const DOCS_HOME_URL = 'ztexam-docs:home'

export default function DocsPanel(): React.JSX.Element {
  const docs = useDocsStore((s) => s.docs)
  const [urlDraft, setUrlDraft] = useState('')

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
          title="โหลดซ้ำ"
          onClick={() => {
            if (docs.url) void window.ztExam.docsNavigate({ url: docs.url })
          }}
          className="rounded-lg border border-slate-700 p-1.5 text-slate-300 hover:bg-slate-800"
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

      {/* ไฟลล์/ลิงก์ถูกบล็อกล่าสุด (เหตุการณ์วิกฤตถูกฟ้องไปเครื่องแม่แล้ว) */}
      {docs.blockedUrl && (
        <div className="flex items-start gap-2 border-b border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-200">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span className="break-all">ไม่อนุญาตให้เข้าถึง: {docs.blockedUrl}</span>
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
          </div>
        </div>
      </div>
    </div>
  )
}

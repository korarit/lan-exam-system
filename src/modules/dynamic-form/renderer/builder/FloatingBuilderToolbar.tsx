import { useState } from 'react'
import {
  Eye,
  Save,
  FolderOpen,
  FilePlus2,
  Sigma,
  Type,
  Check,
  Plus,
  FileUp,
  ChevronDown,
  FileText,
  LayoutPanelTop,
  Image,
  Hash,
  Table2,
  Columns3,
  CalendarClock,
  Code2,
  Paperclip,
  AlignVerticalJustifyStart,
  ListChecks
} from 'lucide-react'
import type { FormItem } from '../../shared/form-schema'
import { useFormBuilderStore } from './form-builder-store'

/* ============================================================
 * Phase 6 (6.2.1) — แถบเครื่องมือลอยด้านขวาของหน้าสร้างฟอร์ม
 * - เพิ่มคำถามทั้ง 12 ชนิด + บล็อกคั่น/รูปประกอบ
 * - นำเข้าจาก CSV/JSON + พรีวิว + Save/Load .ztform + เริ่มใหม่
 * ============================================================ */

export interface FloatingBuilderToolbarProps {
  onPreview(): void
  onSave(encrypted: boolean): Promise<void>
  onLoad(password?: string): Promise<void>
  onImportCsv(): Promise<void>
  saving: boolean
  loading: boolean
}

interface QuestionMenuEntry {
  type: FormItem['inputType']
  label: string
  icon: React.ReactNode
}

const MENU: QuestionMenuEntry[] = [
  { type: 'mcq_single', label: 'เลือกเดียว (Radio Buttons)', icon: <Check size={14} /> },
  { type: 'checkbox_multi', label: 'เลือกได้หลายข้อ (Checkboxes)', icon: <ListChecks size={14} /> },
  { type: 'dropdown', label: 'ดรอปดาวน์', icon: <ChevronDown size={14} /> },
  { type: 'short_text', label: 'คำตอบสั้น', icon: <Type size={14} /> },
  { type: 'long_text', label: 'คำตอบยาว / เรียงความ', icon: <FileText size={14} /> },
  { type: 'numeric_param', label: 'ตัวเลข / พารามิเตอร์สุ่ม', icon: <Hash size={14} /> },
  { type: 'mcq_grid', label: 'ตารางเลือกเดียว (Grid)', icon: <Table2 size={14} /> },
  { type: 'checkbox_grid', label: 'ตารางหลายเลือก (Checkbox Grid)', icon: <Columns3 size={14} /> },
  { type: 'linear_scale', label: 'สเกลระดับคะแนน', icon: <AlignVerticalJustifyStart size={14} /> },
  { type: 'date_time', label: 'วันที่ / เวลา', icon: <CalendarClock size={14} /> },
  { type: 'code_snippet', label: 'กล่องพิมพ์โค้ด', icon: <Code2 size={14} /> },
  { type: 'file_upload', label: 'แนบไฟล์งาน', icon: <Paperclip size={14} /> },
  { type: 'section_header', label: 'แบ่งตอน (หัวข้อ)', icon: <LayoutPanelTop size={14} /> },
  { type: 'media_stimulus', label: 'รูป/สื่อประกอบโจทย์', icon: <Image size={14} /> }
]

export default function FloatingBuilderToolbar(props: FloatingBuilderToolbarProps): React.JSX.Element {
  const { onPreview, onSave, onLoad, onImportCsv, saving, loading } = props
  const addItem = useFormBuilderStore((s) => s.addItem)
  const resetForm = useFormBuilderStore((s) => s.resetForm)
  const [menuOpen, setMenuOpen] = useState(false)

  const actionClass =
    'flex w-full items-center gap-2 rounded-xl border border-slate-700 px-3.5 py-2 text-xs text-slate-200 transition hover:bg-slate-800 disabled:opacity-40'

  return (
    <aside className="sticky top-4 h-fit w-56 shrink-0 space-y-2 rounded-2xl border border-slate-800 bg-slate-900/80 p-3">
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-xl bg-sky-600 px-3.5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500"
        >
          <Plus size={15} className="mr-0 hidden" />
          + เพิ่มคำถาม / บล็อก
        </button>
        {menuOpen && (
          <div className="absolute left-0 top-full z-30 mt-1 w-64 space-y-0.5 rounded-xl border border-slate-700 bg-slate-900 p-1.5 shadow-xl">
            {MENU.map((entry) => (
              <button
                key={entry.type}
                type="button"
                onClick={() => {
                  addItem(entry.type)
                  setMenuOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800"
              >
                <span className="text-slate-400">{entry.icon}</span>
                {entry.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <button type="button" onClick={() => void onImportCsv()} className={actionClass}>
        <FileUp size={14} /> นำเข้าคำถามจาก CSV / JSON
      </button>
      <button type="button" onClick={onPreview} className={actionClass}>
        <Eye size={14} /> ทดลองทำในมุมมองนักเรียน
      </button>

      <div className="my-1 border-t border-slate-800" />

      <button type="button" disabled={saving} onClick={() => void onSave(false)} className={actionClass}>
        <Save size={14} /> {saving ? 'กำลังบันทึก…' : 'บันทึก .ztform (มาตรฐาน)'}
      </button>
      <button type="button" disabled={saving} onClick={() => void onSave(true)} className={`${actionClass} text-emerald-300`}>
        <Sigma size={14} /> บันทึกแบบเข้ารหัสรหัสผ่าน
      </button>
      <button type="button" disabled={loading} onClick={() => void onLoad()} className={actionClass}>
        <FolderOpen size={14} /> {loading ? 'กำลังเปิด…' : 'เปิดไฟล์ .ztform'}
      </button>
      <button
        type="button"
        onClick={() => {
          if (window.confirm('ล้างฟอร์มปัจจุบันแล้วเริ่มใหม่ทั้งหมด?')) resetForm()
        }}
        className={`${actionClass} text-red-300`}
      >
        <FilePlus2 size={14} /> สร้างฟอร์มใหม่ (ล้างทั้งหมด)
      </button>
    </aside>
  )
}

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
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import { Separator } from '@renderer/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { ScrollArea } from '@renderer/components/ui/scroll-area'

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
  const [resetOpen, setResetOpen] = useState(false)

  return (
    <Card className="sticky top-4 h-fit w-56 shrink-0 space-y-2 p-3">
      <div className="relative">
        <Button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          className="w-full"
        >
          <Plus size={15} />
          เพิ่มคำถาม / บล็อก
        </Button>
        {menuOpen && (
          <Card className="absolute left-0 top-full z-30 mt-1 w-64 p-1.5 shadow-xl">
            <ScrollArea className="max-h-72">
              {MENU.map((entry) => (
                <Button
                  key={entry.type}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    addItem(entry.type)
                    setMenuOpen(false)
                  }}
                  className="w-full justify-start"
                >
                  <span className="text-muted-foreground">{entry.icon}</span>
                  {entry.label}
                </Button>
              ))}
            </ScrollArea>
          </Card>
        )}
      </div>

      <Button type="button" variant="outline" size="sm" onClick={() => void onImportCsv()} className="w-full justify-start">
        <FileUp size={14} /> นำเข้าคำถามจาก CSV / JSON
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onPreview} className="w-full justify-start">
        <Eye size={14} /> ทดลองทำในมุมมองนักเรียน
      </Button>

      <Separator />

      <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void onSave(false)} className="w-full justify-start">
        <Save size={14} /> {saving ? 'กำลังบันทึก…' : 'บันทึก .ztform (มาตรฐาน)'}
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void onSave(true)} className="w-full justify-start">
        <Sigma size={14} /> บันทึกแบบเข้ารหัสรหัสผ่าน
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void onLoad()} className="w-full justify-start">
        <FolderOpen size={14} /> {loading ? 'กำลังเปิด…' : 'เปิดไฟล์ .ztform'}
      </Button>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => setResetOpen(true)}
        className="w-full justify-start"
      >
        <FilePlus2 size={14} /> สร้างฟอร์มใหม่ (ล้างทั้งหมด)
      </Button>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>สร้างฟอร์มใหม่</DialogTitle>
            <DialogDescription>ล้างฟอร์มปัจจุบันแล้วเริ่มใหม่ทั้งหมด? การกระทำนี้ย้อนกลับไม่ได้</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setResetOpen(false)}>ยกเลิก</Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                resetForm()
                setResetOpen(false)
              }}
            >
              ล้างทั้งหมด
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

import { useState } from 'react'
import { FolderOpen } from 'lucide-react'

/* Phase 8 (8.3.4) — TeacherWorkspaceFolderConfig
 * โฟลเดอร์หลักเก็บงานห้องสอบบนเครื่องครู
 * (<root>/<studentId>/ สร้างอัตโนมัติเมื่อนักเรียนส่งงาน/ซิงก์โค้ด) */

interface Props {
  value: string
  studentIds: string[]
  onPick: (folder: string) => void
}

export function defaultTeacherWorkspace(examTitle: string): string {
  const safe = examTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'Exam'
  return `D:/ExamWorkspace/${safe}/`
}

export default function TeacherWorkspaceFolderConfig(props: Props): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)

  async function handlePick(): Promise<void> {
    setError(null)
    try {
      const picker = (
        window as unknown as {
          showDirectoryPicker?: () => Promise<{ name: string }>
        }
      ).showDirectoryPicker
      if (typeof picker === 'function') {
        const dir = await picker()
        props.onPick(`<TeacherDisk>/${dir.name}/`)
      } else {
        setError('เบราว์เซอร์/Electron รุ่นนี้เลือกโฟลเดอร์โดยตรงไม่ได้ — พิมพ์พาธเองด้านล่าง')
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setError('เลือกโฟลเดอร์ไม่สำเร็จ')
      }
    }
  }

  const preview = props.studentIds.slice(0, 3)

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">📂 โฟลเดอร์หลักเก็บงานห้องสอบ (เครื่องครู)</h4>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handlePick()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:border-emerald-500"
        >
          <FolderOpen size={14} className="text-emerald-400" /> เลือกโฟลเดอร์
        </button>
        <input
          value={props.value}
          onChange={(e) => props.onPick(e.target.value)}
          placeholder="D:/ExamWorkspace/CS202_Final/"
          className="min-w-52 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs focus:border-emerald-500 focus:outline-none"
        />
      </div>
      {error !== null && <p className="mt-1 text-[11px] text-amber-300">{error}</p>}
      <div className="mt-2 font-mono text-[11px] text-slate-500">
        <p>Subfolder อัตโนมัติตามรหัสนักเรียน:</p>
        {preview.length === 0 ? (
          <p className="text-slate-600">(ยังไม่มีรายชื่อนักเรียน — จะสร้าง &lt;root&gt;/&lt;studentId&gt;/ ให้ตอนส่งงาน)</p>
        ) : (
          preview.map((id) => <p key={id}>{props.value}{id}/</p>)
        )}
        {props.studentIds.length > 3 && <p>… และอีก {props.studentIds.length - 3} คน</p>}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { FolderOpen } from 'lucide-react'

/* ============================================================
 * Phase 8 (8.2.1) — StudentWorkspaceFolderPicker
 * ให้นักเรียนเลือกโฟลเดอร์จริงบนเครื่องเก็บงานข้อนี้
 * (<StudentWorkspaceFolder>/Q<number>_<slug>/...) — เขียน real-time
 * ไม่เลือก = ใช้พาธมาตรฐาน Documents/LANExamWorkspace/<exam>_<student>/
 * ============================================================ */

interface Props {
  examId: string
  studentId: string
  value: string
  onPick: (folderPath: string) => void
}

export function defaultWorkspaceFolder(examId: string, studentId: string): string {
  return `Documents/LANExamWorkspace/${examId}_${studentId}/`
}

export default function StudentWorkspaceFolderPicker(props: Props): React.JSX.Element {
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handlePick(): Promise<void> {
    setPicking(true)
    setError(null)
    try {
      const picker = (
        window as unknown as {
          showDirectoryPicker?: () => Promise<{ name: string }>
        }
      ).showDirectoryPicker
      if (typeof picker === 'function') {
        const dir = await picker()
        props.onPick(`<SelectedFolder>/${dir.name}/`)
      } else {
        // Fallback: Electron sandbox ไม่มี File System Access API — ใช้พาธมาตรฐาน
        props.onPick(defaultWorkspaceFolder(props.examId, props.studentId))
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // ผู้ใช้กดยกเลิก — ไม่ถือเป็น error
      } else {
        setError('เลือกโฟลเดอร์ไม่สำเร็จ — ใช้โฟลเดอร์มาตรฐานแทน')
        props.onPick(defaultWorkspaceFolder(props.examId, props.studentId))
      }
    } finally {
      setPicking(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void handlePick()}
        disabled={picking}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 transition hover:border-sky-500 disabled:opacity-40"
      >
        <FolderOpen size={14} className="text-sky-400" />
        {picking ? 'กำลังเลือก…' : '📂 เลือกโฟลเดอร์เก็บงาน'}
      </button>
      <code className="max-w-full truncate font-mono text-[11px] text-slate-400" title={props.value}>
        {props.value}
      </code>
      {error !== null && <span className="text-[11px] text-amber-300">{error}</span>}
    </div>
  )
}

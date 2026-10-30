import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'

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
  const [dialogOpen, setDialogOpen] = useState(false)
  const [manualPath, setManualPath] = useState('')

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
        // Fallback: Electron sandbox ไม่มี File System Access API — ให้กรอกพาธเองใน Dialog
        setManualPath(defaultWorkspaceFolder(props.examId, props.studentId))
        setDialogOpen(true)
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void handlePick()}
        disabled={picking}
      >
        <FolderOpen size={14} />
        {picking ? 'กำลังเลือก…' : 'เลือกโฟลเดอร์เก็บงาน'}
      </Button>
      <code className="max-w-full truncate font-mono text-[11px] tabular-nums text-muted-foreground" title={props.value}>
        {props.value}
      </code>
      {error !== null && <span className="text-[11px] text-destructive">{error}</span>}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>โฟลเดอร์เก็บงาน</DialogTitle>
            <DialogDescription>เบราว์เซอร์รุ่นนี้เลือกโฟลเดอร์โดยตรงไม่ได้ — พิมพ์พาธเองหรือใช้ค่ามาตรฐาน</DialogDescription>
          </DialogHeader>
          <Input value={manualPath} onChange={(e) => setManualPath(e.target.value)} className="font-mono text-xs" aria-label="พาธโฟลเดอร์" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>ยกเลิก</Button>
            <Button
              type="button"
              onClick={() => {
                props.onPick(manualPath.trim() || defaultWorkspaceFolder(props.examId, props.studentId))
                setDialogOpen(false)
              }}
            >
              ใช้พาธนี้
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

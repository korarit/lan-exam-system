import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'

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
    // Phase 10: เลือกผ่าน dialog ของ Main process ได้พาธจริงบนเครื่องครู + ผูก backend ทันที
    try {
      const api = window.ztExam
      if (typeof api?.setCodeWorkspaceRoot === 'function') {
        const res = await api.setCodeWorkspaceRoot()
        if (res.ok && res.rootPath) {
          props.onPick(res.rootPath)
          return
        }
        if (res.reason !== 'CANCELLED') {
          setError(`เลือกโฟลเดอร์ไม่สำเร็จ: ${res.reason ?? 'unknown'}`)
          return
        }
        return
      }
    } catch {
      /* IPC ยังไม่พร้อม — fallback ด้านล่าง */
    }
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
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">โฟลเดอร์หลักเก็บงานห้องสอบ (เครื่องครู)</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handlePick()}
          >
            <FolderOpen size={14} /> เลือกโฟลเดอร์
          </Button>
          <Input
            value={props.value}
            onChange={(e) => props.onPick(e.target.value)}
            placeholder="D:/ExamWorkspace/CS202_Final/"
            className="min-w-52 flex-1 font-mono text-xs"
            aria-label="โฟลเดอร์เก็บงาน"
          />
        </div>
        {error !== null && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
        <div className="mt-2 font-mono text-[11px] text-muted-foreground">
          <p>Subfolder อัตโนมัติตามรหัสนักเรียน:</p>
          {preview.length === 0 ? (
            <p>(ยังไม่มีรายชื่อนักเรียน — จะสร้าง &lt;root&gt;/&lt;studentId&gt;/ ให้ตอนส่งงาน)</p>
          ) : (
            preview.map((id) => <p key={id}>{props.value}{id}/</p>)
          )}
          {props.studentIds.length > 3 && <p>… และอีก {props.studentIds.length - 3} คน</p>}
        </div>
      </CardContent>
    </Card>
  )
}

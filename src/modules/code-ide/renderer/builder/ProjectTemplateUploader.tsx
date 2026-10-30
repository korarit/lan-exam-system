import { useState } from 'react'
import { FolderOpen, FileArchive } from 'lucide-react'
import type { VirtualEntry } from '../../shared/code-schema'
import { isJunkPath, normalizeProjectPath } from '../../shared/project-tree'
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import { cn } from '@renderer/lib/utils'

/* Phase 8 (8.3.2) — Upload โปรเจกต์ตั้งต้น (Folder/.zip) + Starter/Reference views
 * อ่านโฟลเดอร์ผ่าน File System Access / webkitdirectory, กรอง junk อัตโนมัติ,
 * แยก node_modules/.venv/lib*.jar เข้า Dependency Bundle (suggestion) */

export type TemplateView = 'starter' | 'reference'

interface Props {
  view: TemplateView
  onViewChange: (v: TemplateView) => void
  onImportEntries: (entries: VirtualEntry[], target: TemplateView, notices: string[]) => void
}

export default function ProjectTemplateUploader(props: Props): React.JSX.Element {
  const [dragOver, setDragOver] = useState(false)
  const [lastNotices, setLastNotices] = useState<string[]>([])

  async function readFolderFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files)
    const entries: VirtualEntry[] = []
    const notices: string[] = []
    const folderPaths = new Set<string>()
    let junkSkipped = 0
    let vendorSuggested = 0

    for (const f of list) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
      const p = normalizeProjectPath(rel.split('/').slice(1).join('/') || rel)
      if (p.length === 0) continue
      if (isJunkPath(p)) {
        junkSkipped++
        continue
      }
      if (/^(node_modules|\.venv|venv|vendor|\.cargo)(\/|$)/.test(p) || /\.jar$/i.test(p) || /\.whl$/i.test(p)) {
        vendorSuggested++
        continue
      }
      const parentParts = p.split('/').slice(0, -1)
      for (let i = 1; i <= parentParts.length; i++) {
        const folderPath = parentParts.slice(0, i).join('/')
        if (!folderPaths.has(folderPath)) {
          folderPaths.add(folderPath)
          entries.push({ path: folderPath, kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false })
        }
      }
      const text = f.size > 500_000 ? '' : await f.text()
      entries.push({ path: p, kind: 'file', content: text, encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false })
    }
    if (junkSkipped > 0) notices.push(`กรองโฟลเดอร์ขยะออก ${junkSkipped} รายการ (.git/dist/build/__pycache__)`)
    if (vendorSuggested > 0) notices.push(`แยก ${vendorSuggested} รายการเข้า Dependency Bundle (node_modules/.venv/*.jar/*.whl) — เลือกใน OfflineDependencyManager`)
    notices.push(`นำเข้า ${entries.filter((e) => e.kind === 'file').length} ไฟล์ / ${entries.filter((e) => e.kind === 'folder').length} โฟลเดอร์`)
    setLastNotices(notices)
    props.onImportEntries(entries, props.view, notices)
  }

  return (
    <div>
      <div className="mb-2 flex gap-1 text-xs">
        {(['starter', 'reference'] as TemplateView[]).map((v) => (
          <Button
            key={v}
            type="button"
            variant={props.view === v ? 'default' : 'outline'}
            size="sm"
            onClick={() => props.onViewChange(v)}
            title={v === 'starter' ? 'สิ่งที่นักเรียนจะเห็นตอนเริ่มสอบ' : 'โปรเจกต์เฉลยของอาจารย์ (ไม่ส่งถึงนักเรียน)'}
          >
            {v === 'starter' ? 'Starter Project (นักเรียนเห็น)' : 'Reference Solution (เฉลย)'}
          </Button>
        ))}
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files.length > 0) void readFolderFiles(e.dataTransfer.files)
        }}
        className={cn('rounded-md border-2 border-dashed p-4 text-center transition', dragOver ? 'border-primary bg-primary/10' : 'border-border bg-muted/30')}
      >
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" asChild>
            <label className="cursor-pointer">
              <FolderOpen size={15} /> Upload โฟลเดอร์โปรเจกต์
              <input
                type="file"
                /* @ts-expect-error webkitdirectory ไม่ได้อยู่ใน lib DOM มาตรฐาน */
                webkitdirectory=""
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files !== null && e.target.files.length > 0) void readFolderFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
          </Button>
          <Button type="button" variant="outline" asChild>
            <label className="cursor-pointer">
              <FileArchive size={15} /> ไฟล์ .zip
              <input
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(e) => {
                  if ((e.target.files?.length ?? 0) > 0) {
                    setLastNotices(['ไฟล์ .zip จะถูกแตกใน Phase 9 (ต้องมี zip parser) — ตอนนี้ให้ upload เป็นโฟลเดอร์แทน'])
                  }
                  e.target.value = ''
                }}
              />
            </label>
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">ลากโฟลเดอร์มาวางตรงนี้ก็ได้ — ระบบกรอง .git/dist/build ให้อัตโนมัติ</p>
      </div>

      {lastNotices.length > 0 && (
        <Card className="mt-2 bg-muted/40">
          <ul className="space-y-0.5 p-2 text-[11px] text-muted-foreground">
            {lastNotices.map((n, i) => <li key={i}>• {n}</li>)}
          </ul>
        </Card>
      )}
    </div>
  )
}


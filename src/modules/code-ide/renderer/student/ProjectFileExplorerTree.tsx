import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FilePlus2, FolderPlus, FileCode2, Folder, Lock, Package } from 'lucide-react'
import type { DependencyBundle, VirtualEntry } from '../../shared/code-schema'
import { buildExplorerTree, type ProjectTreeNode } from '../../shared/project-tree'

/* ============================================================
 * Phase 8 (8.2.1) — ProjectFileExplorerTree
 * Collapsible tree + ไอคอนตามนามสกุล + 🔒 readOnly
 * + New File / New Folder / Rename / Delete / Duplicate
 * + Installed Libraries Inspector
 * ============================================================ */

interface Props {
  entries: readonly VirtualEntry[]
  selectedPath: string | null
  canCreate: boolean
  canDeleteRename: boolean
  allowUpload: boolean
  libraries: DependencyBundle[] | Array<{ ecosystem: string; packages: Array<{ name: string; version: string }> }>
  onSelectFile: (path: string) => void
  onCreateFile: (path: string) => void
  onCreateFolder: (path: string) => void
  onRename: (oldPath: string, newPath: string) => void
  onDelete: (path: string) => void
  onUploadFiles?: (files: FileList) => void
}

const FILE_ICON_COLOR: Record<string, string> = {
  java: 'text-orange-400',
  py: 'text-yellow-300',
  ts: 'text-sky-400',
  tsx: 'text-sky-300',
  js: 'text-yellow-400',
  html: 'text-orange-500',
  css: 'text-blue-400',
  sql: 'text-emerald-300',
  json: 'text-slate-300'
}

function iconColorFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return FILE_ICON_COLOR[ext] ?? 'text-slate-400'
}

export default function ProjectFileExplorerTree(props: Props): React.JSX.Element {
  const roots = useMemo(() => buildExplorerTree(props.entries), [props.entries])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(props.entries.filter((e) => e.kind === 'folder').map((e) => e.path)))
  const [newName, setNewName] = useState('')
  const [creatingIn, setCreatingIn] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  function toggle(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function submitCreate(kind: 'file' | 'folder'): void {
    const name = newName.trim()
    if (name.length === 0 || creatingIn === undefined) return
    const full = creatingIn !== null && creatingIn.length > 0 ? `${creatingIn}/${name}` : name
    if (kind === 'file') props.onCreateFile(full)
    else props.onCreateFolder(full)
    setNewName('')
    setCreatingIn(null)
  }

  function submitRename(oldPath: string): void {
    const v = renameValue.trim()
    if (v.length === 0) return
    const parent = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : ''
    props.onRename(oldPath, parent.length > 0 ? `${parent}/${v}` : v)
    setRenameTarget(null)
    setRenameValue('')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-slate-800 px-2 py-1.5">
        <span className="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Project files</span>
        <span className="flex-1" />
        {props.canCreate && (
          <>
            <button
              type="button"
              title="+ New File"
              onClick={() => setCreatingIn('')}
              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            >
              <FilePlus2 size={14} />
            </button>
            <button
              type="button"
              title="+ New Folder"
              onClick={() => setCreatingIn('')}
              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            >
              <FolderPlus size={14} />
            </button>
          </>
        )}
      </div>

      {creatingIn !== null && (
        <div className="flex gap-1 border-b border-slate-800 p-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCreate('file')
              if (e.key === 'Escape') setCreatingIn(null)
            }}
            placeholder="components/cards/UserCard.tsx"
            className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs focus:border-sky-500 focus:outline-none"
          />
          <button type="button" onClick={() => submitCreate('file')} className="rounded bg-sky-700 px-2 py-1 text-xs hover:bg-sky-600">ไฟล์</button>
          <button type="button" onClick={() => submitCreate('folder')} className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600">โฟลเดอร์</button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {roots.map((n) => (
          <TreeNodeView
            key={n.path}
            node={n}
            depth={0}
            expanded={expanded}
            selectedPath={props.selectedPath}
            canDeleteRename={props.canDeleteRename}
            renameTarget={renameTarget}
            renameValue={renameValue}
            onToggle={toggle}
            onSelectFile={props.onSelectFile}
            onStartRename={(p) => {
              setRenameTarget(p)
              setRenameValue(p.split('/').pop() ?? p)
            }}
            onSubmitRename={submitRename}
            onRenameChange={setRenameValue}
            onDelete={props.onDelete}
            onCreateInside={(dir) => setCreatingIn(dir)}
          />
        ))}
        {roots.length === 0 && <p className="p-3 text-xs text-slate-500">ไม่มีไฟล์ — สร้างไฟล์แรกด้วย + New File</p>}
      </div>

      <div className="border-t border-slate-800 p-2">
        <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <Package size={12} /> Libraries ({props.libraries.length})
        </div>
        {props.libraries.length === 0 ? (
          <p className="text-[11px] text-slate-600">โจทย์ข้อนี้ไม่มีไลบรารีเสริม</p>
        ) : (
          <ul className="max-h-24 space-y-0.5 overflow-y-auto">
            {props.libraries.map((lib, i) => (
              <li key={i} className="font-mono text-[11px] text-slate-400">
                <span className="text-slate-600">[{lib.ecosystem}]</span>{' '}
                {lib.packages.map((p) => `${p.name}@${p.version}`).join(', ') || '(bundle)'}
              </li>
            ))}
          </ul>
        )}
        {props.allowUpload && (
          <label className="mt-2 block cursor-pointer rounded border border-dashed border-slate-700 px-2 py-1.5 text-center text-[11px] text-slate-400 hover:border-sky-500 hover:text-sky-300">
            📤 Upload ไฟล์เข้าโปรเจกต์
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files !== null) props.onUploadFiles?.(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
        )}
      </div>
    </div>
  )
}

function TreeNodeView(props: {
  node: ProjectTreeNode
  depth: number
  expanded: Set<string>
  selectedPath: string | null
  canDeleteRename: boolean
  renameTarget: string | null
  renameValue: string
  onToggle: (path: string) => void
  onSelectFile: (path: string) => void
  onStartRename: (path: string) => void
  onSubmitRename: (path: string) => void
  onRenameChange: (v: string) => void
  onDelete: (path: string) => void
  onCreateInside: (dir: string) => void
}): React.JSX.Element {
  const { node } = props
  const isOpen = props.expanded.has(node.path)
  const locked = node.entry.readOnly
  const isRenaming = props.renameTarget === node.path

  if (node.entry.kind === 'folder') {
    return (
      <div>
        <div
          className="group flex items-center gap-1 rounded px-1 py-0.5 text-[13px] text-slate-300 hover:bg-slate-800/60"
          style={{ paddingLeft: `${props.depth * 12 + 4}px` }}
        >
          <button type="button" onClick={() => props.onToggle(node.path)} className="rounded p-0.5 text-slate-500 hover:text-slate-200">
            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          <Folder size={14} className="shrink-0 text-amber-400/80" />
          <span className="truncate font-medium">{node.name}</span>
          {locked && <Lock size={11} className="shrink-0 text-slate-500" />}
          {props.canDeleteRename && !locked && (
            <span className="ml-auto hidden gap-0.5 group-hover:flex">
              <button type="button" title="สร้างไฟล์ข้างใน" onClick={() => props.onCreateInside(node.path)} className="rounded px-1 text-[11px] text-slate-500 hover:text-sky-300">+</button>
              <button type="button" title="เปลี่ยนชื่อ" onClick={() => props.onStartRename(node.path)} className="rounded px-1 text-[11px] text-slate-500 hover:text-slate-200">✎</button>
              <button type="button" title="ลบ" onClick={() => props.onDelete(node.path)} className="rounded px-1 text-[11px] text-slate-500 hover:text-red-300">🗑</button>
            </span>
          )}
        </div>
        {isRenaming && (
          <RenameBox value={props.renameValue} onChange={props.onRenameChange} onSubmit={() => props.onSubmitRename(node.path)} depth={props.depth} />
        )}
        {isOpen && node.children.map((c) => (
          <TreeNodeView key={c.path} {...props} node={c} depth={props.depth + 1} />
        ))}
      </div>
    )
  }

  return (
    <div>
      <div
        className={`group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[13px] ${
          props.selectedPath === node.path ? 'bg-sky-950/60 text-sky-200' : 'text-slate-300 hover:bg-slate-800/60'
        }`}
        style={{ paddingLeft: `${props.depth * 12 + 20}px` }}
      >
        <button type="button" onClick={() => props.onSelectFile(node.path)} className="flex min-w-0 flex-1 items-center gap-1.5">
          <FileCode2 size={14} className={`shrink-0 ${iconColorFor(node.path)}`} />
          <span className="truncate font-mono text-xs">{node.name}</span>
          {locked && <Lock size={11} className="shrink-0 text-slate-500" />}
        </button>
        {props.canDeleteRename && !locked && (
          <span className="hidden gap-0.5 group-hover:flex">
            <button type="button" title="เปลี่ยนชื่อ" onClick={() => props.onStartRename(node.path)} className="rounded px-1 text-[11px] text-slate-500 hover:text-slate-200">✎</button>
            <button type="button" title="ลบ" onClick={() => props.onDelete(node.path)} className="rounded px-1 text-[11px] text-slate-500 hover:text-red-300">🗑</button>
          </span>
        )}
      </div>
      {isRenaming && (
        <RenameBox value={props.renameValue} onChange={props.onRenameChange} onSubmit={() => props.onSubmitRename(node.path)} depth={props.depth} />
      )}
    </div>
  )
}

function RenameBox(props: { value: string; onChange: (v: string) => void; onSubmit: () => void; depth: number }): React.JSX.Element {
  return (
    <div className="py-0.5" style={{ paddingLeft: `${props.depth * 12 + 20}px` }}>
      <input
        autoFocus
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onSubmit()
        }}
        className="w-full rounded border border-sky-600 bg-slate-950 px-1 py-0.5 font-mono text-xs focus:outline-none"
      />
    </div>
  )
}

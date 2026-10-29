import { useRef, useState } from 'react'
import { Plus, Trash2, Paperclip } from 'lucide-react'
import type { DependencyBundle } from '../../shared/code-schema'

/** ไฟล์ lib จริงที่ครูแนบ (ฝังเป็น base64 blob ใน .ztcode — key = archiveRelativePath) */
export interface LibFileAttachment {
  blobPath: string
  fileName: string
  dataBase64: string
  sizeBytes: number
}

const MAX_LIB_FILE_BYTES = 24 * 1024 * 1024

/* Phase 8 (8.3.3) — OfflineDependencyManager: presets พร้อมใช้ + custom upload
 * อาจารย์ติ๊กเลือก → ฝังเป็น DependencyBundle ใน .ztcode (offline 100% ตอนสอบ) */

interface Preset {
  ecosystem: DependencyBundle['ecosystem']
  name: string
  version: string
  group: string
}

export const BUILT_IN_PRESETS: Preset[] = [
  // Frontend / React
  { ecosystem: 'frontend-vendor', name: 'lucide-react', version: '0.460.0', group: 'Frontend / React' },
  { ecosystem: 'frontend-vendor', name: 'clsx', version: '2.1.1', group: 'Frontend / React' },
  { ecosystem: 'frontend-vendor', name: 'dayjs', version: '1.11.13', group: 'Frontend / React' },
  { ecosystem: 'frontend-vendor', name: 'zod', version: '3.23.8', group: 'Frontend / React' },
  // Node / TS Backend
  { ecosystem: 'npm', name: 'express', version: '4.19.2', group: 'Node / TS Backend' },
  { ecosystem: 'npm', name: 'fastify', version: '5.1.0', group: 'Node / TS Backend' },
  { ecosystem: 'npm', name: 'hono', version: '4.6.0', group: 'Node / TS Backend' },
  { ecosystem: 'npm', name: 'cors', version: '2.8.5', group: 'Node / TS Backend' },
  { ecosystem: 'npm', name: 'better-sqlite3', version: '11.8.1', group: 'Node / TS Backend' },
  { ecosystem: 'npm', name: 'jsonwebtoken', version: '9.0.2', group: 'Node / TS Backend' },
  { ecosystem: 'npm', name: 'bcryptjs', version: '2.4.3', group: 'Node / TS Backend' },
  // Python
  { ecosystem: 'pip', name: 'pytest', version: '8.3.4', group: 'Python' },
  { ecosystem: 'pip', name: 'pydantic', version: '2.10.0', group: 'Python' },
  { ecosystem: 'pip', name: 'flask', version: '3.1.0', group: 'Python' },
  { ecosystem: 'pip', name: 'fastapi', version: '0.115.0', group: 'Python' },
  // Java
  { ecosystem: 'maven-jar', name: 'junit-platform-console-standalone.jar', version: '1.10.0', group: 'Java' },
  { ecosystem: 'maven-jar', name: 'gson.jar', version: '2.10.1', group: 'Java' },
  { ecosystem: 'maven-jar', name: 'sqlite-jdbc.jar', version: '3.47.0', group: 'Java' }
]

interface Props {
  bundles: DependencyBundle[]
  onChange: (bundles: DependencyBundle[]) => void
  files: LibFileAttachment[]
  onChangeFiles: (files: LibFileAttachment[]) => void
}

function ecosystemForFile(name: string): DependencyBundle['ecosystem'] {
  if (/\.jar$/i.test(name)) return 'maven-jar'
  if (/\.whl$/i.test(name)) return 'pip'
  if (/\.(h|cpp|hpp|a|so|lib)$/i.test(name)) return 'c-cpp-headers-libs'
  return 'npm'
}

function presetKey(p: Preset): string {
  return `${p.ecosystem}:${p.name}`
}

export default function OfflineDependencyManager(props: Props): React.JSX.Element {
  const [customName, setCustomName] = useState('')
  const [customVersion, setCustomVersion] = useState('')
  const selected = new Set(props.bundles.flatMap((b) => b.packages.map((p) => `${b.ecosystem}:${p.name}`)))
  const groups = [...new Set(BUILT_IN_PRESETS.map((p) => p.group))]

  function togglePreset(p: Preset): void {
    const key = presetKey(p)
    if (selected.has(key)) {
      const next = props.bundles
        .map((b) => (b.ecosystem === p.ecosystem
          ? { ...b, packages: b.packages.filter((x) => x.name !== p.name) }
          : b))
        .filter((b) => b.packages.length > 0)
      props.onChange(next)
    } else {
      const existing = props.bundles.find((b) => b.ecosystem === p.ecosystem)
      if (existing !== undefined) {
        props.onChange(props.bundles.map((b) => (b.ecosystem === p.ecosystem
          ? { ...b, packages: [...b.packages, { name: p.name, version: p.version }] }
          : b)))
      } else {
        props.onChange([...props.bundles, {
          bundleId: `bundle-${p.ecosystem}-${Date.now().toString(36)}`,
          ecosystem: p.ecosystem,
          packages: [{ name: p.name, version: p.version }],
          archiveRelativePath: `vendor/${p.ecosystem}/${p.name}.bundle`
        }])
      }
    }
  }

  function addCustom(): void {
    const name = customName.trim()
    if (name.length === 0) return
    const version = customVersion.trim() || '1.0.0'
    let fileName = name
    let ecosystem: DependencyBundle['ecosystem'] = 'npm'
    if (/\.jar$/i.test(name)) ecosystem = 'maven-jar'
    else if (/\.whl$/i.test(name)) ecosystem = 'pip'
    else fileName = name
    void fileName
    const existing = props.bundles.find((b) => b.ecosystem === ecosystem)
    if (existing !== undefined) {
      props.onChange(props.bundles.map((b) => (b.ecosystem === ecosystem
        ? { ...b, packages: [...b.packages, { name, version }] }
        : b)))
    } else {
      props.onChange([...props.bundles, {
        bundleId: `bundle-custom-${Date.now().toString(36)}`,
        ecosystem,
        packages: [{ name, version }],
        archiveRelativePath: `vendor/${ecosystem}/${name}.bundle`
      }])
    }
    setCustomName('')
    setCustomVersion('')
  }

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g}>
          <h5 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g}</h5>
          <div className="flex flex-wrap gap-1.5">
            {BUILT_IN_PRESETS.filter((p) => p.group === g).map((p) => {
              const on = selected.has(presetKey(p))
              return (
                <button
                  key={presetKey(p)}
                  type="button"
                  onClick={() => togglePreset(p)}
                  className={`rounded-full border px-2.5 py-1 font-mono text-[11px] transition ${
                    on ? 'border-emerald-500/70 bg-emerald-950/40 text-emerald-200' : 'border-slate-800 text-slate-400 hover:border-slate-600 hover:text-slate-200'
                  }`}
                >
                  {on ? '✓ ' : '+ '}{p.name}@{p.version}
                </button>
              )
            })}
          </div>
        </div>
      ))}

      <div>
        <h5 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          อัปโหลด Custom Library (.jar / .whl / .tgz / node_modules)
        </h5>
        <AttachRealFile
          files={props.files}
          onChangeFiles={props.onChangeFiles}
          bundles={props.bundles}
          onChangeBundles={props.onChange}
        />
        <div className="flex gap-1.5">
          <input
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder="gson-2.10.jar / numpy-2.0.whl / express-4.19.tgz"
            className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs focus:border-sky-500 focus:outline-none"
          />
          <input
            value={customVersion}
            onChange={(e) => setCustomVersion(e.target.value)}
            placeholder="version"
            className="w-24 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs focus:border-sky-500 focus:outline-none"
          />
          <button type="button" onClick={addCustom} className="inline-flex items-center gap-1 rounded bg-sky-700 px-2.5 py-1.5 text-xs font-medium hover:bg-sky-600">
            <Plus size={13} /> เพิ่ม
          </button>
        </div>
        <p className="mt-1 text-[11px] text-slate-600">ไฟล์ binary จริงจะถูกฝังเป็น base64 blob ใน .ztcode ตอนกดบันทึก (Phase 8 เก็บ metadata + path; เนื้อหาไฟล์แนบตอน Save)</p>
      </div>

      {props.files.length > 0 && (
        <div className="mt-2 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-2">
          <h5 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-300/80">
            ไฟล์จริงที่แนบ ({props.files.length}) — ฝังใน .ztcode แล้ว
          </h5>
          {props.files.map((f) => (
            <div key={f.blobPath} className="flex items-center gap-2 py-0.5 font-mono text-[11px] text-slate-200">
              <Paperclip size={11} className="text-emerald-400" />
              <span className="flex-1 truncate">{f.fileName} ({(f.sizeBytes / 1024).toFixed(0)} KB → {f.blobPath})</span>
            </div>
          ))}
        </div>
      )}

      {props.bundles.length > 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
          <h5 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Bundles ที่เลือก ({props.bundles.length})</h5>
          {props.bundles.map((b) => (
            <div key={b.bundleId} className="flex items-center gap-2 py-0.5 font-mono text-[11px] text-slate-300">
              <span className="text-slate-500">[{b.ecosystem}]</span>
              <span className="flex-1 truncate">{b.packages.map((p) => `${p.name}@${p.version}`).join(', ')}</span>
              <button
                type="button"
          onClick={() => props.onChange(props.bundles.filter((x) => x.bundleId !== b.bundleId))}
              className="rounded p-0.5 text-slate-500 hover:text-red-300"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        </div>
      )}
    </div>
  )
}

/** แนบไฟล์ lib จริง (.jar/.whl/.zip) — อ่านเป็น base64 ฝัง blob + สร้าง bundle 1:1 */
function AttachRealFile(props: {
  files: LibFileAttachment[]
  onChangeFiles: (files: LibFileAttachment[]) => void
  bundles: DependencyBundle[]
  onChangeBundles: (bundles: DependencyBundle[]) => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onPick(list: FileList | null): Promise<void> {
    if (!list || list.length === 0) return
    setError(null)
    setBusy(true)
    try {
      const nextFiles = [...props.files]
      let nextBundles = [...props.bundles]
      for (const f of Array.from(list)) {
        if (f.size === 0) {
          setError(`ข้ามไฟล์ว่าง: ${f.name}`)
          continue
        }
        if (f.size > MAX_LIB_FILE_BYTES) {
          setError(`${f.name} ใหญ่เกิน 24MB — แยกเป็น .zip หลายส่วนหรือใช้ห้อง lab ที่ลง lib ไว้แล้ว`)
          continue
        }
        const buf = await f.arrayBuffer()
        const bytes = new Uint8Array(buf)
        let bin = ''
        for (let i = 0; i < bytes.length; i += 8192) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
        }
        const ecosystem = ecosystemForFile(f.name)
        const blobPath = `vendor/${ecosystem}/${f.name}`
        if (nextFiles.some((x) => x.blobPath === blobPath)) {
          setError(`แนบ ${f.name} ไว้แล้ว — ลบของเดิมก่อนถ้าจะแทนที่`)
          continue
        }
        nextFiles.push({ blobPath, fileName: f.name, dataBase64: btoa(bin), sizeBytes: f.size })
        nextBundles = [
          ...nextBundles,
          {
            bundleId: `bundle-file-${Date.now().toString(36)}-${nextBundles.length}`,
            ecosystem,
            packages: [{ name: f.name, version: 'bundled' }],
            archiveRelativePath: blobPath
          }
        ]
      }
      props.onChangeFiles(nextFiles)
      props.onChangeBundles(nextBundles)
    } catch {
      setError('อ่านไฟล์ไม่สำเร็จ')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  function removeFile(blobPath: string): void {
    props.onChangeFiles(props.files.filter((f) => f.blobPath !== blobPath))
    props.onChangeBundles(props.bundles.filter((b) => b.archiveRelativePath !== blobPath))
  }

  return (
    <div className="mb-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:border-emerald-500 disabled:opacity-40"
        >
          <Paperclip size={13} className="text-emerald-400" />
          {busy ? 'กำลังอ่านไฟล์…' : 'แนบไฟล์ lib จริง (.jar / .whl / .zip)'}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".jar,.whl,.zip,.sqlite,.sql,.d.ts"
          className="hidden"
          onChange={(e) => void onPick(e.target.files)}
        />
        <span className="text-[11px] text-slate-600">สูงสุดไฟล์ละ 24MB · ฝังใน .ztcode สอบออฟไลน์ได้เลย</span>
      </div>
      {error !== null && <p className="mt-1 text-[11px] text-amber-300">{error}</p>}
      {props.files.map((f) => (
        <div key={f.blobPath} className="mt-1 flex items-center gap-2 font-mono text-[11px] text-slate-300">
          <span className="flex-1 truncate">📦 {f.fileName} ({(f.sizeBytes / 1024).toFixed(0)} KB)</span>
          <button type="button" onClick={() => removeFile(f.blobPath)} className="text-slate-500 hover:text-red-300">
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { DependencyBundle } from '../../shared/code-schema'

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
        <h5 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">อัปโหลด Custom Library (.jar / .whl / .tgz / node_modules)</h5>
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

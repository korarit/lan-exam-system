import {
  CATEGORY_LANGUAGES,
  PROJECT_CATEGORY_LABELS,
  SUPPORTED_LANGUAGE_LABELS,
  ProjectCategorySchema,
  type ProjectCategory,
  type SupportedCodeLanguage
} from '../../shared/code-schema'

/* Phase 8 (8.3.1) — ขั้นที่ 1-3: เลือกประเภทโจทย์ → ภาษา/สแต็ก → ออปชันเสริม */

interface Props {
  category: ProjectCategory
  language: SupportedCodeLanguage
  enableDatabase: boolean
  onChangeCategory: (c: ProjectCategory) => void
  onChangeLanguage: (l: SupportedCodeLanguage) => void
  onToggleDatabase: (v: boolean) => void
}

export default function TrackAndLanguageSelector(props: Props): React.JSX.Element {
  const languages = CATEGORY_LANGUAGES[props.category]

  return (
    <div className="space-y-3">
      <div>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">ขั้นที่ 1 — ประเภทโจทย์</h4>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {ProjectCategorySchema.options.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                props.onChangeCategory(c)
                const first = CATEGORY_LANGUAGES[c][0]
                if (first !== undefined && !CATEGORY_LANGUAGES[c].includes(props.language)) {
                  props.onChangeLanguage(first)
                }
              }}
              className={`rounded-lg border px-2.5 py-2 text-left text-[13px] transition ${
                props.category === c
                  ? 'border-emerald-500/70 bg-emerald-950/30 text-emerald-200'
                  : 'border-slate-800 bg-slate-950/40 text-slate-300 hover:border-slate-600'
              }`}
            >
              {PROJECT_CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">ขั้นที่ 2 — ภาษา/สแต็ก</h4>
        <div className="flex flex-wrap gap-1.5">
          {languages.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => props.onChangeLanguage(l)}
              className={`rounded-full border px-3 py-1 font-mono text-xs transition ${
                props.language === l
                  ? 'border-sky-500/70 bg-sky-950/40 text-sky-200'
                  : 'border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-600 hover:text-slate-200'
              }`}
            >
              {SUPPORTED_LANGUAGE_LABELS[l]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">ขั้นที่ 3 — ออปชันเสริม</h4>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2 text-[13px] text-slate-300">
          <input
            type="checkbox"
            checked={props.enableDatabase}
            onChange={(e) => props.onToggleDatabase(e.target.checked)}
            className="h-4 w-4 accent-emerald-500"
          />
          เปิดใช้งานฐานข้อมูลในโจทย์ข้อนี้ (SQLite seed .sql/.sqlite + Ephemeral Respawn หรือ MySQL/MariaDB ภายนอก)
        </label>
      </div>
    </div>
  )
}

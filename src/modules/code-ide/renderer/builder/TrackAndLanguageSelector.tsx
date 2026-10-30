import {
  CATEGORY_LANGUAGES,
  PROJECT_CATEGORY_LABELS,
  SUPPORTED_LANGUAGE_LABELS,
  ProjectCategorySchema,
  type ProjectCategory,
  type SupportedCodeLanguage
} from '../../shared/code-schema'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'

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
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">ขั้นที่ 1 — ประเภทโจทย์</h4>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {ProjectCategorySchema.options.map((c) => (
            <Button
              key={c}
              type="button"
              variant={props.category === c ? 'default' : 'outline'}
              onClick={() => {
                props.onChangeCategory(c)
                const first = CATEGORY_LANGUAGES[c][0]
                if (first !== undefined && !CATEGORY_LANGUAGES[c].includes(props.language)) {
                  props.onChangeLanguage(first)
                }
              }}
              className="justify-start text-[13px]"
            >
              {PROJECT_CATEGORY_LABELS[c]}
            </Button>
          ))}
        </div>
      </div>

      <div>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">ขั้นที่ 2 — ภาษา/สแต็ก</h4>
        <div className="flex flex-wrap gap-1.5">
          {languages.map((l) => (
            <Badge
              key={l}
              variant={props.language === l ? 'default' : 'outline'}
              className={cn('cursor-pointer font-mono')}
            >
              <button type="button" onClick={() => props.onChangeLanguage(l)}>
                {SUPPORTED_LANGUAGE_LABELS[l]}
              </button>
            </Badge>
          ))}
        </div>
      </div>

      <div>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">ขั้นที่ 3 — ออปชันเสริม</h4>
        <Label className="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-[13px]">
          <input
            type="checkbox"
            checked={props.enableDatabase}
            onChange={(e) => props.onToggleDatabase(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          เปิดใช้งานฐานข้อมูลในโจทย์ข้อนี้ (SQLite seed .sql/.sqlite + Ephemeral Respawn หรือ MySQL/MariaDB ภายนอก)
        </Label>
      </div>
    </div>
  )
}

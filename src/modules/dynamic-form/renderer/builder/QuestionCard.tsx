import { useRef } from 'react'
import type { FormItem, FormQuestion, FormChoice, GridRow, GridColumn } from '../../shared/form-schema'
import {
  DYNAMIC_FORM_INPUT_TYPES,
  INPUT_TYPE_LABELS,
  AnswerKeySchema,
  FormChoiceSchema,
  GridColumnSchema,
  GridRowSchema
} from '../../shared/form-schema'
import { assetDataUrl, attachImageAsset } from './builder-assets'
import type { FormAssetMap } from '../../shared/form-schema'
import { AnswerKeyEditor } from './AnswerKeyEditor'

/* ============================================================
 * Phase 6 (6.2.1) — การ์ดคำถามแบบ Google Forms (ย่อ/ขยายแก้ไข)
 * - เปลี่ยนชนิด Input ได้ (โจทย์ไม่หาย)
 * - แนบรูปประกอบโจทย์/ตัวเลือก (ย่อขนาด + asset Content-Addressed)
 * - ตั้งกฎ Validation + เฉลย (AnswerKeyEditor) + คะแนน/สลับลำดับ
 * ============================================================ */

export interface QuestionCardProps {
  item: FormItem
  index: number
  expanded: boolean
  assets: FormAssetMap
  onToggleExpand(): void
  onChange(item: FormItem): void
  onRemove(): void
  onDuplicate(): void
  onMove(direction: 'up' | 'down'): void
  onFirst: boolean
  onLast: boolean
  onAssetAdded(assetId: string, mimeType: string, dataBase64: string): void
}

export function QuestionCard(props: QuestionCardProps): React.JSX.Element {
  const { item, index, expanded, assets, onToggleExpand, onChange, onRemove, onDuplicate, onMove, onFirst, onLast, onAssetAdded } = props
  const image = assetDataUrl(assets, item.inputType !== 'section_header' ? item.imageAssetId : undefined)

  if (item.inputType === 'section_header') {
    return (
      <section
        onClick={onToggleExpand}
        className="cursor-pointer rounded-2xl border border-indigo-800/40 bg-indigo-950/20 p-4"
      >
        {expanded ? (
          <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
            <input
              value={item.title}
              maxLength={200}
              onChange={(e) => onChange({ ...item, title: e.target.value })}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-semibold text-slate-100"
              placeholder="ชื่อส่วน (Section)"
            />
            <textarea
              value={item.description}
              maxLength={2000}
              rows={2}
              onChange={(e) => onChange({ ...item, description: e.target.value })}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              placeholder="คำชี้แจงของส่วนนี้"
            />
            <CardFooter onRemove={onRemove} onDuplicate={onDuplicate} onMove={onMove} onFirst={onFirst} onLast={onLast} />
          </div>
        ) : (
          <>
            <h3 className="font-semibold text-indigo-200">📑 {index + 1}. {item.title}</h3>
            {item.description.length > 0 && <p className="mt-1 text-sm text-slate-400">{item.description}</p>}
          </>
        )}
      </section>
    )
  }

  if (item.inputType === 'media_stimulus') {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">🖼️ สื่อประกอบโจทย์</span>
          {expanded ? (
            <div onClick={(e) => e.stopPropagation()}>
              <p className="mb-2 text-xs text-slate-400">คำอธิบายใต้ภาพ:</p>
              <input
                value={item.caption}
                maxLength={1000}
                onChange={(e) => onChange({ ...item, caption: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              />
              <CardFooter onRemove={onRemove} onDuplicate={onDuplicate} onMove={onMove} onFirst={onFirst} onLast={onLast} />
            </div>
          ) : (
            <button type="button" onClick={onToggleExpand} className="text-xs text-sky-300 hover:text-sky-200">
              แก้ไข
            </button>
          )}
        </div>
        {image ? <img src={image} alt="" className="mt-2 max-h-56 rounded-xl border border-slate-700" /> : <p className="mt-2 text-xs text-red-300">ภาพหาย (asset ไม่พบ)</p>}
      </section>
    )
  }

  return (
    <section
      className={`rounded-2xl border p-5 transition ${expanded ? 'border-sky-700/60 bg-slate-900/80' : 'border-slate-800 bg-slate-900/50 hover:border-slate-700'}`}
    >
      {!expanded && (
        <button type="button" onClick={onToggleExpand} className="w-full">
          <div className="flex flex-wrap items-center gap-2 text-left">
            <span className="text-xs text-slate-500">ข้อ {index + 1}</span>
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">{INPUT_TYPE_LABELS[item.inputType]}</span>
            <span className="rounded-full border border-amber-800/60 bg-amber-950/40 px-2 py-0.5 text-[10px] text-amber-300">{item.points} คะแนน</span>
            {item.validation.required && <span className="text-[10px] text-red-300">จำเป็นต้องตอบ</span>}
            <KeyBadge item={item} />
          </div>
          <p className="mt-2 truncate text-left text-sm text-slate-200">{promptOrPlaceholder(item as FormQuestion)}</p>
        </button>
      )}

      {expanded && (
        <div className="space-y-4" onClick={(e) => e.stopPropagation()}>
          <textarea
            value={item.prompt}
            rows={2}
            maxLength={4000}
            onChange={(e) => onChange({ ...item, prompt: e.target.value })}
            placeholder="พิมพ์โจทย์ข้อนี้ (รองรับ {{a}} {{b}} ในข้อตัวเลข)"
            className="w-full resize-y rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm"
          />
          <TypeSelector item={item} onChange={onChange} />
          {image && (
            <div className="flex items-center gap-3">
              <img src={image} alt="" className="max-h-32 rounded-lg border border-slate-700" />
              <button
                type="button"
                onClick={() => onChange({ ...item, imageAssetId: undefined })}
                className="text-xs text-red-300 hover:text-red-200"
              >
                ลบรูปประกอบโจทย์
              </button>
            </div>
          )}
          {item.imageAssetId === undefined && <AttachImageButton onAttached={(assetId, mime, data) => onAssetAdded(assetId, mime, data)} />}
          <BodyEditor item={item} onChange={onChange} assets={assets} onAssetAdded={onAssetAdded} />
          <ValidationEditor item={item} onChange={onChange} />
          <AnswerKeyEditor item={item as FormQuestion} onChange={(key) => onChange({ ...item, answerKey: key })} />
          <PerQuestionOptions item={item} onChange={onChange} />
          <CardFooter onRemove={onRemove} onDuplicate={onDuplicate} onMove={onMove} onFirst={onFirst} onLast={onLast} />
        </div>
      )}
    </section>
  )
}

function promptOrPlaceholder(item: FormQuestion): string {
  return item.prompt.length > 0 ? item.prompt : '(โจทย์ — ยังไม่ได้พิมพ์)'
}

function KeyBadge(props: { item: FormItem }): React.JSX.Element | null {
  const item = props.item
  if (item.inputType === 'section_header' || item.inputType === 'media_stimulus') return null
  const parsed = AnswerKeySchema.safeParse(item.answerKey)
  if (!parsed.success) return <span className="rounded-full bg-red-950/60 px-2 py-0.5 text-[10px] text-red-300">เฉลยไม่ถูกต้อง</span>
  const key = parsed.data
  if (key.gradingType === 'ungraded') return <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">ไม่คิดคะแนน</span>
  if (key.gradingType === 'manual_rubric') {
    return <span className="rounded-full bg-violet-950/60 px-2 py-0.5 text-[10px] text-violet-300">รอครูตรวจ (Rubric)</span>
  }
  return <span className="rounded-full bg-emerald-950/60 px-2 py-0.5 text-[10px] text-emerald-300">เฉลยพร้อมตรวจ</span>
}

/* ---------- เลือกชนิด Input (เปลี่ยนได้ไม่หายข้อมูล) ---------- */

function TypeSelector(props: { item: FormItem; onChange(item: FormItem): void }): React.JSX.Element {
  const { item, onChange } = props
  const current: typeof item.inputType = item.inputType
  return (
    <select
      value={current}
      onChange={(e) => {
        const nextType = e.target.value as typeof item.inputType
        if (nextType === item.inputType) return
        onChange(migrateItemToType(item, nextType))
      }}
      className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
    >
      {DYNAMIC_FORM_INPUT_TYPES.map((t) => (
        <option key={t} value={t}>
          {INPUT_TYPE_LABELS[t]}
        </option>
      ))}
      <option value="section_header">📑 แบ่งตอน (หัวข้อ)</option>
      <option value="media_stimulus">🖼️ รูป/สื่อประกอบ</option>
    </select>
  )
}

/** เปลี่ยนชนิดโดยรักษา prompt/points ไว้ แล้วเติมฟิลด์เริ่มต้นตามชนิดใหม่ */
function migrateItemToType(item: FormItem, nextType: FormItem['inputType']): FormItem {
  if (nextType === item.inputType) return item
  const itemId = item.itemId
  if (nextType === 'section_header') {
    const wasBlock = item.inputType === 'section_header' || item.inputType === 'media_stimulus'
    const title = wasBlock
      ? item.inputType === 'section_header'
        ? item.title
        : item.caption
      : (item as FormQuestion).prompt
    return { inputType: 'section_header', itemId, title: title.length > 0 ? title : 'ส่วนใหม่', description: '' }
  }
  if (nextType === 'media_stimulus') {
    if (item.inputType === 'section_header') {
      return { inputType: 'media_stimulus', itemId, imageAssetId: 'MISSING', caption: '' }
    }
    return { inputType: 'media_stimulus', itemId, imageAssetId: item.imageAssetId ?? 'MISSING', caption: '' }
  }
  const wasBlock = item.inputType === 'section_header' || item.inputType === 'media_stimulus'
  const base = {
    itemId,
    prompt: wasBlock
      ? item.inputType === 'section_header'
        ? item.title
        : item.caption
      : (item as FormQuestion).prompt,
    points: wasBlock ? 1 : (item as FormQuestion).points,
    shuffleChoices: false,
    validation: { required: wasBlock ? true : (item as FormQuestion).validation.required },
    answerKey: wasBlock ? ({ gradingType: 'ungraded' } as FormItem extends never ? never : FormQuestion['answerKey']) : (item as FormQuestion).answerKey
  }
  switch (nextType) {
    case 'mcq_single':
    case 'checkbox_multi':
    case 'dropdown': {
      const oldChoices = !wasBlock && 'choices' in item ? item.choices : undefined
      return { ...base, inputType: nextType, choices: oldChoices ?? fallbackChoices() } as FormItem
    }
    case 'short_text':
      return { ...base, inputType: 'short_text' } as FormItem
    case 'long_text':
      return { ...base, inputType: 'long_text' } as FormItem
    case 'numeric_param':
      return { ...base, inputType: 'numeric_param', unit: !wasBlock && 'unit' in item ? item.unit : '' } as FormItem
    case 'mcq_grid':
    case 'checkbox_grid': {
      const oldRows = !wasBlock && 'rows' in item ? item.rows : undefined
      const oldColumns = !wasBlock && 'columns' in item ? item.columns : undefined
      return { ...base, inputType: nextType, rows: oldRows ?? [GridRowSchema.parse({ rowId: 'r1', label: 'แถว 1' }), GridRowSchema.parse({ rowId: 'r2', label: 'แถว 2' })], columns: oldColumns ?? [GridColumnSchema.parse({ columnId: 'c1', label: 'หัวข้อ 1' }), GridColumnSchema.parse({ columnId: 'c2', label: 'หัวข้อ 2' })] } as FormItem
    }
    case 'linear_scale':
      return { ...base, inputType: 'linear_scale', scaleMin: 1, scaleMax: 5 } as FormItem
    case 'date_time':
      return { ...base, inputType: 'date_time', mode: 'date' as const } as FormItem
    case 'code_snippet':
      return { ...base, inputType: 'code_snippet', language: 'python' as const, starterCode: '' } as FormItem
    case 'file_upload':
      return { ...base, inputType: 'file_upload', acceptMultiple: false } as FormItem
  }
}

function fallbackChoices() {
  return [
    FormChoiceSchema.parse({ choiceId: 'c1', text: 'ตัวเลือก 1' }),
    FormChoiceSchema.parse({ choiceId: 'c2', text: 'ตัวเลือก 2' })
  ]
}

/* ---------- Body: กาาแก According แอปแนวตามชนิด ---------- */

function BodyEditor(props: {
  item: FormItem
  onChange(item: FormItem): void
  assets: FormAssetMap
  onAssetAdded(assetId: string, mimeType: string, dataBase64: string): void
}): React.JSX.Element | null {
  const { item, onChange, assets, onAssetAdded } = props
  switch (item.inputType) {
    case 'mcq_single':
    case 'checkbox_multi':
    case 'dropdown':
      return (
        <ChoicesEditor
          choices={item.choices}
          onChange={(choices) => onChange({ ...item, choices })}
          assets={assets}
          onAssetAdded={onAssetAdded}
        />
      )
    case 'mcq_grid':
    case 'checkbox_grid':
      return (
        <GridDefinitionEditor
          rows={item.rows}
          columns={item.columns}
          onRows={(rows) => onChange({ ...item, rows })}
          onColumns={(columns) => onChange({ ...item, columns })}
        />
      )
    case 'linear_scale': {
      const setMin = (scaleMin: number): void => onChange({ ...item, scaleMin: Math.min(scaleMin, item.scaleMax - 1) })
      const setMax = (scaleMax: number): void => onChange({ ...item, scaleMax: Math.max(scaleMax, item.scaleMin + 1) })
      return (
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <label>จาก <input type="number" min={0} max={99} value={item.scaleMin} onChange={(e) => setMin(Number(e.target.value))} className="w-16 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-right font-mono" /></label>
          <label>ถึง <input type="number" min={1} max={100} value={item.scaleMax} onChange={(e) => setMax(Number(e.target.value))} className="w-16 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-right font-mono" /></label>
          <input value={item.leftLabel ?? ''} placeholder="ป้ายซ้าย" onChange={(e) => onChange(item.inputType === 'linear_scale' ? { ...item, leftLabel: labelOrUndefined(e.target.value) } : item)} className="w-36 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs" />
          <input value={item.rightLabel ?? ''} placeholder="ป้ายขวา" onChange={(e) => onChange(item.inputType === 'linear_scale' ? { ...item, rightLabel: labelOrUndefined(e.target.value) } : item)} className="w-36 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs" />
        </div>
      )
    }
    case 'date_time':
      return (
        <label className="flex items-center gap-2 text-xs text-slate-400">
          รูปแบบ:
          <select
            value={item.mode}
            onChange={(e) => onChange(item.inputType === 'date_time' ? { ...item, mode: e.target.value as 'date' | 'time' | 'datetime' } : item)}
            className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
          >
            <option value="date">วันที่</option>
            <option value="time">เวลา</option>
            <option value="datetime">วันที่+เวลา</option>
          </select>
        </label>
      )
    case 'numeric_param': {
      const params = item.parameters ?? {}
      return (
        <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            หน่วยกำกับ:
            <input value={item.unit} onChange={(e) => onChange(item.inputType === 'numeric_param' ? { ...item, unit: e.target.value.slice(0, 30) } : item)} className="w-24 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1" placeholder="เช่น บาท, m/s" />
          </div>
          <p className="text-xs text-slate-500">{'ตัวแปรสุ่มที่จะถูกแทนค่าในโจทย์ เช่น ใช้ {{a}} ในโจทย์แล้วใส่สูตรเฉลย "a * 2 + 1"'}</p>
          {Object.keys(params).map((name) => (
            <div key={name} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-sky-300">{name}</span>
              <label>จาก <input type="number" value={params[name]?.min ?? 0} onChange={(e) => onChange(item.inputType === 'numeric_param' ? { ...item, parameters: { ...params, [name]: { min: Number(e.target.value), max: params[name]?.max ?? 10, step: params[name]?.step ?? 1 } } } : item)} className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono" /></label>
              <label>ถึง <input type="number" value={params[name]?.max ?? 10} onChange={(e) => onChange(item.inputType === 'numeric_param' ? { ...item, parameters: { ...params, [name]: { min: params[name]?.min ?? 0, max: Number(e.target.value), step: params[name]?.step ?? 1 } } } : item)} className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono" /></label>
              <label>ก้าว <input type="number" min={1} value={params[name]?.step ?? 1} onChange={(e) => onChange(item.inputType === 'numeric_param' ? { ...item, parameters: { ...params, [name]: { min: params[name]?.min ?? 0, max: params[name]?.max ?? 10, step: Math.max(1, Number(e.target.value)) } } } : item)} className="w-14 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono" /></label>
              <button
                type="button"
                className="text-red-300 hover:text-red-200"
                onClick={() => {
                  const { [name]: _drop, ...rest } = params
                  onChange(item.inputType === 'numeric_param' ? { ...item, parameters: Object.keys(rest).length > 0 ? rest : undefined } : item)
                }}
              >
                ลบ
              </button>
            </div>
          ))}
          <button
            type="button"
            className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-800"
            onClick={() => {
              const name = `p${Object.keys(params).length + 1}`
              onChange(item.inputType === 'numeric_param' ? { ...item, parameters: { ...params, [name]: { min: 1, max: 10, step: 1 } } } : item)
            }}
          >
            + เพิ่มตัวแปรสุ่ม
          </button>
        </div>
      )
    }
    case 'code_snippet':
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            ภาษา:
            <select
              value={item.language}
              onChange={(e) => onChange(item.inputType === 'code_snippet' ? { ...item, language: e.target.value as 'python' | 'c' | 'cpp' | 'java' | 'sql' | 'js' } : item)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
            >
              {['python', 'c', 'cpp', 'java', 'sql', 'js'].map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
          <textarea
            value={item.starterCode}
            rows={4}
            spellCheck={false}
            placeholder="Starter Code ตั้งต้น (แสดงในกล่องคำตอบของนักเรียน)"
            onChange={(e) => onChange(item.inputType === 'code_snippet' ? { ...item, starterCode: e.target.value.slice(0, 20000) } : item)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-emerald-100"
          />
        </div>
      )
    case 'file_upload': {
      const exts = item.validation.allowedExtensions ?? []
      return (
        <div className="space-y-1.5 text-xs text-slate-400">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={item.acceptMultiple} onChange={(e) => onChange(item.inputType === 'file_upload' ? { ...item, acceptMultiple: e.target.checked } : item)} />
            อนุญาตหลายไฟล์
          </label>
          <input
            value={exts.join(', ')}
            placeholder="นามสกุลที่รับ เช่น .py, .pdf, .zip"
            onChange={(e) =>
              onChange(
                item.inputType === 'file_upload'
                  ? {
                      ...item,
                      validation: { ...item.validation, allowedExtensions: splitExtensions(e.target.value) }
                    }
                  : item
              )
            }
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5"
          />
          <label className="flex items-center gap-2">
            ขนาดสูงสุด (MB):
            <input
              type="number"
              min={1}
              max={64}
              value={Math.round((item.validation.maxFileSizeBytes ?? 10 * 1024 * 1024) / 1024 / 1024)}
              onChange={(e) =>
                onChange(
                  item.inputType === 'file_upload'
                    ? {
                        ...item,
                        validation: { ...item.validation, maxFileSizeBytes: Math.min(64, Math.max(1, Number(e.target.value) || 1)) * 1024 * 1024 }
                      }
                    : item
                )
              }
              className="w-20 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-right font-mono"
            />
          </label>
        </div>
      )
    }
    default:
      return null
  }
}

function labelOrUndefined(value: string): string | undefined {
  return value.trim().length > 0 ? value : undefined
}

function splitExtensions(raw: string): Array<string> | undefined {
  const list = raw.split(',').map((e) => e.trim()).filter((e) => e.length > 1).map((e) => (e.startsWith('.') ? e : `.${e}`)).slice(0, 20)
  return list.length > 0 ? list : undefined
}

/* ---------- Choices editor ---------- */

function ChoicesEditor(props: {
  choices: FormChoice[]
  onChange(choices: FormChoice[]): void
  assets: FormAssetMap
  onAssetAdded(assetId: string, mimeType: string, dataBase64: string): void
}): React.JSX.Element {
  const { choices, onChange, assets, onAssetAdded } = props
  return (
    <div className="space-y-2">
      {choices.map((choice, idx) => {
        const img = assetDataUrl(assets, choice.imageAssetId)
        return (
          <div key={choice.choiceId} className="flex items-center gap-2">
            <input
              value={choice.text}
              maxLength={500}
              onChange={(e) => {
                const copy = [...choices]
                copy[idx] = { ...choice, text: e.target.value }
                onChange(copy)
              }}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />
            {img ? (
              <>
                <img src={img} alt="" className="max-h-10 rounded border border-slate-700" />
                <button
                  type="button"
                  className="text-xs text-red-300"
                  onClick={() => {
                    const copy = [...choices]
                    copy[idx] = { choiceId: choice.choiceId, text: choice.text }
                    onChange(copy)
                  }}
                >
                  ลบรูป
                </button>
              </>
            ) : (
              <AttachImageButton
                small
                onAttached={(assetId, mimeType, dataBase64) => {
                  const copy = [...choices]
                  copy[idx] = { ...choice, imageAssetId: assetId }
                  onChange(copy)
                  onAssetAdded(assetId, mimeType, dataBase64)
                }}
              />
            )}
            <button
              type="button"
              className="text-sm text-slate-500 hover:text-red-300"
              onClick={() => onChange(choices.filter((_, i) => i !== idx))}
              disabled={choices.length <= 2}
            >
              ✕
            </button>
          </div>
        )
      })}
      <button
        type="button"
        onClick={() => onChange([...choices, FormChoiceSchema.parse({ choiceId: `c${choices.length + 1}${Math.random().toString(36).slice(2, 4)}`, text: `ตัวเลือก ${choices.length + 1}` })])}
        disabled={choices.length >= 20}
        className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-40"
      >
        + เพิ่มตัวเลือก
      </button>
    </div>
  )
}

/* ---------- Grid rows/columns editor ---------- */

function GridDefinitionEditor(props: {
  rows: GridRow[]
  columns: GridColumn[]
  onRows(rows: GridRow[]): void
  onColumns(cols: GridColumn[]): void
}): React.JSX.Element {
  const { rows, columns, onRows, onColumns } = props
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <p className="text-xs text-slate-500">แถว (คำถามย่อย)</p>
        {rows.map((r, idx) => (
          <div key={r.rowId} className="flex items-center gap-1.5">
            <input
              value={r.label}
              onChange={(e) => {
                const copy = [...rows]
                copy[idx] = { ...r, label: e.target.value }
                onRows(copy)
              }}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm"
            />
            <button type="button" className="text-slate-500 hover:text-red-300" onClick={() => onRows(rows.filter((_, i) => i !== idx))}>✕</button>
          </div>
        ))}
        <button type="button" onClick={() => onRows([...rows, GridRowSchema.parse({ rowId: `r${rows.length + 1}${Math.random().toString(36).slice(2, 4)}`, label: `แถว ${rows.length + 1}` })])} disabled={rows.length >= 12} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-800">+ แถว</button>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs text-slate-500">คอลัมน์ (ตัวเลือก)</p>
        {columns.map((c, idx) => (
          <div key={c.columnId} className="flex items-center gap-1.5">
            <input
              value={c.label}
              onChange={(e) => {
                const copy = [...columns]
                copy[idx] = { ...c, label: e.target.value }
                onColumns(copy)
              }}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm"
            />
            <button type="button" className="text-slate-500 hover:text-red-300" onClick={() => onColumns(columns.filter((_, i) => i !== idx))}>✕</button>
          </div>
        ))}
        <button type="button" onClick={() => onColumns([...columns, GridColumnSchema.parse({ columnId: `c${columns.length + 1}${Math.random().toString(36).slice(2, 4)}`, label: `หัวข้อ ${columns.length + 1}` })])} disabled={columns.length >= 12} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-800">+ คอลัมน์</button>
      </div>
    </div>
  )
}

/* ---------- Validation editor ---------- */

function ValidationEditor(props: { item: FormItem; onChange(item: FormItem): void }): React.JSX.Element | null {
  const { item, onChange } = props
  if (item.inputType === 'section_header' || item.inputType === 'media_stimulus') return null
  const onChangeRule = (patch: Partial<FormQuestion['validation']>): void => {
    onChange({ ...item, validation: { ...item.validation, ...patch } })
  }
  const v = item.validation
  const isText = item.inputType === 'short_text' || item.inputType === 'long_text'
  const isMulti = item.inputType === 'checkbox_multi' || item.inputType === 'checkbox_grid'
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2.5 text-xs text-slate-400">
      <label className="flex items-center gap-1.5 text-red-300">
        <input type="checkbox" checked={v.required} onChange={(e) => onChangeRule({ required: e.target.checked })} />
        จำเป็นต้องตอบ
      </label>
      {isText && (
        <>
          <label>ต่ำสุด <input type="number" min={0} value={v.minLength ?? ''} placeholder="—" onChange={(e) => onChangeRule({ minLength: optionalNumber(e.target.value) })} className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono" /></label>
          <label>สูงสุด <input type="number" min={0} value={v.maxLength ?? ''} placeholder="—" onChange={(e) => onChangeRule({ maxLength: optionalNumber(e.target.value) })} className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono" /></label>
        </>
      )}
      {item.inputType === 'long_text' && (
        <>
          <label>คำขั้นต่ำ <input type="number" min={0} value={v.minWords ?? ''} placeholder="—" onChange={(e) => onChangeRule({ minWords: optionalNumber(e.target.value) })} className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono" /></label>
          <label>คำขั้นสูงสุด <input type="number" min={0} value={v.maxWords ?? ''} placeholder="—" onChange={(e) => onChangeRule({ maxWords: optionalNumber(e.target.value) })} className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono" /></label>
        </>
      )}
      {isMulti && (
        <>
          <label>เลือกน้อย <input type="number" min={0} value={v.minSelect ?? ''} placeholder="—" onChange={(e) => onChangeRule({ minSelect: optionalNumber(e.target.value) })} className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono" /></label>
          <label>เลือกมาก <input type="number" min={0} value={v.maxSelect ?? ''} placeholder="—" onChange={(e) => onChangeRule({ maxSelect: optionalNumber(e.target.value) })} className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono" /></label>
        </>
      )}
      {(isText || item.inputType === 'numeric_param') && (
        <label>Regex <input value={v.regexPattern ?? ''} placeholder="มี # แนบเช่น ^\d+$" onChange={(e) => onChangeRule({ regexPattern: e.target.value.length > 0 ? e.target.value : undefined })} className="w-40 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono" /></label>
      )}
    </div>
  )
}

function optionalNumber(raw: string): number | undefined {
  if (raw.trim().length === 0) return undefined
  const v = Number(raw)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined
}

/* ---------- Per-question options ---------- */

function PerQuestionOptions(props: { item: FormItem; onChange(item: FormItem): void }): React.JSX.Element | null {
  const { item, onChange } = props
  if (item.inputType === 'section_header' || item.inputType === 'media_stimulus') return null
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
      <label className="flex items-center gap-1.5">
        คะแนน:
        <input
          type="number"
          min={0.5}
          step={0.5}
          value={item.points}
          onChange={(e) => onChange({ ...item, points: Math.max(0.5, Number(e.target.value) || 1) })}
          className="w-16 rounded-lg border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono"
        />
      </label>
      {'choices' in item || 'rows' in item || item.inputType === 'linear_scale' ? (
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={item.shuffleChoices}
            onChange={(e) => onChange({ ...item, shuffleChoices: e.target.checked })}
          />
          สลับลำดับ{('choices' in item ? 'ตัวเลือก' : item.inputType === 'linear_scale' ? 'สเกล' : 'แถว')}รายคน
        </label>
      ) : null}
      {item.inputType === 'numeric_param' && 'parameters' in item && item.parameters !== undefined && (
        <span className="text-[10px] text-slate-600">(คะแนนและตัวแปรจะใช้ตรวจสูตรเฉลยตาม seed ของนักเรียนจริง)</span>
      )}
    </div>
  )
}

/* ---------- Attach image button ---------- */

function AttachImageButton(props: { onAttached(assetId: string, mimeType: string, dataBase64: string): void; small?: boolean }): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const { onAttached, small = false } = props
  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className={`rounded-lg border border-dashed border-slate-600 text-slate-400 transition hover:border-sky-600 hover:text-sky-200 ${small ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1.5 text-xs'}`}
      >
        🖼️ แนบรูป (ลดขนาดอัตโนมัติ)
      </button>
      <input
        hidden
        ref={ref}
        type="file"
        accept="image/*"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (file === undefined) return
          try {
            const asset = await attachImageAsset(file)
            onAttached(asset.assetId, asset.mimeType, asset.dataBase64)
          } catch {
            /* ignore */
          }
          e.target.value = ''
        }}
      />
    </>
  )
}

/* ---------- footer ---------- */

function CardFooter(props: { onRemove(): void; onDuplicate(): void; onMove(d: 'up' | 'down'): void; onFirst: boolean; onLast: boolean }): React.JSX.Element {
  const { onRemove, onDuplicate, onMove, onFirst, onLast } = props
  return (
    <div className="flex items-center gap-2 border-t border-slate-800 pt-3 text-xs">
      <button type="button" onClick={() => onMove('up')} disabled={onFirst} className="rounded px-2 py-1 hover:bg-slate-800 disabled:opacity-30">▲</button>
      <button type="button" onClick={() => onMove('down')} disabled={onLast} className="rounded px-2 py-1 hover:bg-slate-800 disabled:opacity-30">▼</button>
      <button type="button" onClick={onDuplicate} className="rounded px-2 py-1 hover:bg-slate-800">ซ้ำ</button>
      <button type="button" onClick={onRemove} className="rounded px-2 py-1 text-red-300 hover:bg-red-950/40">ลบข้อ</button>
    </div>
  )
}

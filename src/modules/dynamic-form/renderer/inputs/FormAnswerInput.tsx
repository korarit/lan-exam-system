import { useRef } from 'react'
import type { StudentFormItem, FormAssetMap } from '../../shared/form-schema'
import type { FormAnswerValue } from '../../shared/form-validate'
import { assetDataUrl } from '../builder/builder-assets'

/* ============================================================
 * Phase 6 (6.2.4 / พร้อม Phase 7) — ตัวเรนเดอร์คำตอบของทั้ง 12 ชนิด
 * ใช้ในหน้าพรีวิว (ครู) และจะถูก reuse ในหน้านักเรียนของ Phase 7
 * ============================================================ */

export interface FormAnswerInputProps {
  item: StudentFormItem
  value: FormAnswerValue
  onChange(value: FormAnswerValue): void
  assets: FormAssetMap
  disabled?: boolean
}

export function FormAnswerInput(props: FormAnswerInputProps): React.JSX.Element {
  const { item, value, onChange, assets, disabled = false } = props
  const itemImage = assetDataUrl(assets, item.imageAssetId)
  return (
    <div className="space-y-3">
      {itemImage && <img src={itemImage} alt="" className="max-h-64 rounded-xl border border-slate-700" />}
      {renderValueInput(item, value, onChange, assets, disabled)}
    </div>
  )
}

function renderValueInput(
  item: StudentFormItem,
  value: FormAnswerValue,
  onChange: (v: FormAnswerValue) => void,
  assets: FormAssetMap,
  disabled: boolean
): React.JSX.Element {
  switch (item.inputType) {
    case 'mcq_single':
      return <ChoiceList item={item} single value={value} onChange={onChange} assets={assets} disabled={disabled} />
    case 'checkbox_multi':
      return <ChoiceList item={item} single={false} value={value} onChange={onChange} assets={assets} disabled={disabled} />
    case 'dropdown':
      return <DropdownInput item={item} value={value} onChange={onChange} disabled={disabled} />
    case 'short_text':
      return <ShortTextInput item={item} value={value} onChange={onChange} disabled={disabled} />
    case 'long_text':
      return <LongTextInput item={item} value={value} onChange={onChange} disabled={disabled} />
    case 'numeric_param':
      return <NumericInput item={item} value={value} onChange={onChange} disabled={disabled} />
    case 'mcq_grid':
      return <GridInput item={item} single value={value} onChange={onChange} disabled={disabled} />
    case 'checkbox_grid':
      return <GridInput item={item} single={false} value={value} onChange={onChange} disabled={disabled} />
    case 'linear_scale':
      return <ScaleInput item={item} value={value} onChange={onChange} disabled={disabled} />
    case 'date_time':
      return <DateTimeInput item={item} value={value} onChange={onChange} disabled={disabled} />
    case 'code_snippet':
      return <CodeInput item={item} value={value} onChange={onChange} disabled={disabled} />
    case 'file_upload':
      return <FileUploadInput item={item} value={value} onChange={onChange} assets={assets} disabled={disabled} />
  }
}

/* ---------- Choices (radio / checkboxes) ---------- */

function ChoiceList(props: {
  item: Extract<StudentFormItem, { inputType: 'mcq_single' | 'checkbox_multi' | 'dropdown' }>
  single: boolean
  value: FormAnswerValue
  onChange(v: FormAnswerValue): void
  assets: FormAssetMap
  disabled: boolean
}): React.JSX.Element {
  const { item, single, value, onChange, assets, disabled } = props
  const selectedIds = single
    ? value.kind === 'choice'
      ? [value.choiceId]
      : []
    : value.kind === 'multi'
      ? value.choiceIds
      : []
  const isSame = (choiceId: string): boolean => selectedIds.includes(choiceId)
  return (
    <div className="space-y-2">
      {item.choices.map((choice) => {
        const checked = isSame(choice.choiceId)
        const image = assetDataUrl(assets, choice.imageAssetId)
        const toggle = (): void => {
          if (disabled) return
          if (single) {
            onChange({ kind: 'choice', choiceId: choice.choiceId })
            return
          }
          const next = checked
            ? selectedIds.filter((id) => id !== choice.choiceId)
            : [...selectedIds, choice.choiceId]
          onChange({ kind: 'multi', choiceIds: next })
        }
        return (
          <label
            key={choice.choiceId}
            className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
              checked ? 'border-sky-600 bg-sky-950/40' : 'border-slate-700 bg-slate-950/60 hover:border-slate-600'
            }`}
          >
            <input
              type={single ? 'radio' : 'checkbox'}
              className={`h-4 w-4 ${single ? '' : 'rounded'}`}
              checked={checked}
              onChange={toggle}
              disabled={disabled}
            />
            <span className="text-sm text-slate-200">{choice.text}</span>
            {image && <img src={image} alt="" className="ml-auto max-h-20 rounded-lg border border-slate-700" />}
          </label>
        )
      })}
    </div>
  )
}

/* ---------- Dropdown ---------- */

function DropdownInput(props: {
  item: Extract<StudentFormItem, { inputType: 'dropdown' }>
  value: FormAnswerValue
  onChange(v: FormAnswerValue): void
  disabled: boolean
}): React.JSX.Element {
  const { item, value, onChange, disabled } = props
  const selected = value.kind === 'choice' ? value.choiceId : ''
  return (
    <select
      className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm focus:border-sky-500 focus:outline-none"
      value={selected}
      disabled={disabled}
      onChange={(e) =>
        e.target.value === '' ? onChange({ kind: 'choice', choiceId: '' }) : onChange({ kind: 'choice', choiceId: e.target.value })
      }
    >
      <option value="">— เลือกตัวเลือก —</option>
      {item.choices.map((c) => (
        <option key={c.choiceId} value={c.choiceId}>
          {c.text}
        </option>
      ))}
    </select>
  )
}

/* ---------- Text inputs ---------- */

function ShortTextInput(props: {
  item: Extract<StudentFormItem, { inputType: 'short_text' }>
  value: FormAnswerValue
  onChange(v: FormAnswerValue): void
  disabled: boolean
}): React.JSX.Element {
  const { item, value, onChange, disabled } = props
  const text = value.kind === 'text' ? value.text : ''
  return (
    <input
      type="text"
      value={text}
      disabled={disabled}
      maxLength={item.validation?.maxLength ?? 200}
      onChange={(e) => onChange({ kind: 'text', text: e.target.value })}
      className="w-full max-w-xl rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm focus:border-sky-500 focus:outline-none"
    />
  )
}

function LongTextInput(props: {
  item: Extract<StudentFormItem, { inputType: 'long_text' }>
  value: FormAnswerValue
  onChange(v: FormAnswerValue): void
  disabled: boolean
}): React.JSX.Element {
  const { value, onChange, disabled } = props
  const text = value.kind === 'text' ? value.text : ''
  return (
    <textarea
      value={text}
      disabled={disabled}
      rows={6}
      onChange={(e) => onChange({ kind: 'text', text: e.target.value })}
      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm focus:border-sky-500 focus:outline-none"
    />
  )
}

/* ---------- Numeric ---------- */

function NumericInput(props: {
  item: Extract<StudentFormItem, { inputType: 'numeric_param' }>
  value: FormAnswerValue
  onChange(v: FormAnswerValue): void
  disabled: boolean
}): React.JSX.Element {
  const { item, value, onChange, disabled } = props
  const text: string = value.kind === 'numeric' ? String(value.numeric) : ''
  return (
    <div className="flex items-center gap-2">
      <input
        inputMode="decimal"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          const parsed = Number(e.target.value)
          onChange(
            e.target.value.trim().length === 0 || !Number.isFinite(parsed)
              ? { kind: 'numeric', numeric: Number.NaN }
              : { kind: 'numeric', numeric: parsed }
          )
        }}
        className="w-40 rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm font-mono focus:border-sky-500 focus:outline-none"
      />
      {item.unit.length > 0 && <span className="text-sm text-slate-400">{item.unit}</span>}
    </div>
  )
}

/* ---------- Grids ---------- */

function GridInput(props: {
  item: Extract<StudentFormItem, { inputType: 'mcq_grid' | 'checkbox_grid' }>
  single: boolean
  value: FormAnswerValue
  onChange(v: FormAnswerValue): void
  disabled: boolean
}): React.JSX.Element {
  const { item, single, value, onChange, disabled } = props
  const rowAnswers: Record<string, string | string[]> =
    value.kind === 'rows' ? value.rowAnswers : {}
  const setRow = (rowId: string, given: string | string[]): void => {
    onChange({ kind: 'rows', rowAnswers: { ...rowAnswers, [rowId]: given } })
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[560px] border-separate border-spacing-x-2 text-sm">
        <thead>
          <tr>
            <th className="w-40 text-left text-xs font-normal text-slate-500" />
            {item.columns.map((col) => (
              <th key={col.columnId} className="px-1 pb-1 text-xs font-medium text-slate-300">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {item.rows.map((row) => (
            <tr key={row.rowId}>
              <td className="w-40 pr-2 align-middle text-slate-200">{row.label}</td>
              {item.columns.map((col) => {
                const cellChecked =
                  single
                    ? rowAnswers[row.rowId] === col.columnId
                    : Array.isArray(rowAnswers[row.rowId]) && (rowAnswers[row.rowId] as string[]).includes(col.columnId)
                return (
                  <td key={col.columnId} className="px-1 py-1.5 text-center">
                    <input
                      type={single ? 'radio' : 'checkbox'}
                      className={`h-4 w-4 ${single ? '' : 'rounded'}`}
                      checked={cellChecked}
                      disabled={disabled}
                      onChange={() => {
                        if (single) setRow(row.rowId, col.columnId)
                        else {
                          const current = Array.isArray(rowAnswers[row.rowId]) ? (rowAnswers[row.rowId] as string[]) : []
                          setRow(
                            row.rowId,
                            cellChecked ? current.filter((c) => c !== col.columnId) : [...current, col.columnId]
                          )
                        }
                      }}
                    />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------- Linear scale ---------- */

function ScaleInput(props: {
  item: Extract<StudentFormItem, { inputType: 'linear_scale' }>
  value: FormAnswerValue
  onChange(v: FormAnswerValue): void
  disabled: boolean
}): React.JSX.Element {
  const { item, value, onChange, disabled } = props
  const { scaleMin, scaleMax } = item
  const values: number[] = []
  for (let v = scaleMin; v <= scaleMax; v++) values.push(v)
  const selected = value.kind === 'scale' ? value.value : undefined
  return (
    <div className="flex items-center gap-3">
      {item.leftLabel !== undefined && <span className="text-xs text-slate-400">{item.leftLabel}</span>}
      <div className="flex gap-1.5">
        {values.map((v) => (
          <label
            key={v}
            className={`flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border text-sm transition ${
              selected === v ? 'border-sky-500 bg-sky-950/60 text-sky-200' : 'border-slate-700 bg-slate-950 text-slate-300'
            }`}
          >
            <input
              type="radio"
              className="sr-only"
              checked={selected === v}
              disabled={disabled}
              onChange={() => onChange({ kind: 'scale', value: v })}
            />
            {v}
          </label>
        ))}
      </div>
      {item.rightLabel !== undefined && <span className="text-xs text-slate-400">{item.rightLabel}</span>}
    </div>
  )
}

/* ---------- Date / time ---------- */

function DateTimeInput(props: {
  item: Extract<StudentFormItem, { inputType: 'date_time' }>
  value: FormAnswerValue
  onChange(v: FormAnswerValue): void
  disabled: boolean
}): React.JSX.Element {
  const { item, value, onChange, disabled } = props
  const current = value.kind === 'text' ? value.text : ''
  const inputType = item.mode === 'date' ? 'date' : item.mode === 'time' ? 'time' : 'datetime-local'
  return (
    <input
      type={inputType}
      value={current.replace(' ', 'T')}
      disabled={disabled}
      onChange={(e) => onChange({ kind: 'text', text: e.target.value.replace('T', ' ') })}
      className="w-full max-w-xs rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm focus:border-sky-500 focus:outline-none"
    />
  )
}

/* ---------- Code box ---------- */

function CodeInput(props: {
  item: Extract<StudentFormItem, { inputType: 'code_snippet' }>
  value: FormAnswerValue
  onChange(v: FormAnswerValue): void
  disabled: boolean
}): React.JSX.Element {
  const { item, value, onChange, disabled } = props
  const text = value.kind === 'text' ? value.text : ''
  const lineCount = Math.max(1, text.split('\n').length)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5 text-xs text-slate-500">
        <span className="rounded bg-slate-900 px-2 py-0.5 font-mono">{item.language}</span>
        <span>{lineCount} บรรทัด · Tab ย่อหน้าได้</span>
      </div>
      <div className="flex">
        <div className="select-none border-r border-slate-800 px-2 py-2 text-right font-mono text-xs leading-6 text-slate-600">
          {Array.from({ length: Math.max(lineCount, item.starterCode.split('\n').length > lineCount ? item.starterCode.split('\n').length : lineCount) }, (_, i) => i + 1).join('\n')}
        </div>
        <textarea
          ref={textareaRef}
          value={text || item.starterCode}
          disabled={disabled}
          spellCheck={false}
          rows={Math.max(6, lineCount)}
          onChange={(e) => onChange({ kind: 'text', text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== 'Tab') return
            e.preventDefault()
            const el = e.currentTarget
            const pos = el.selectionStart
            const textValue = el.value
            const next = `${textValue.slice(0, pos)}    ${textValue.slice(el.selectionEnd)}`
            onChange({ kind: 'text', text: next })
            requestAnimationFrame(() => {
              el.selectionStart = el.selectionEnd = pos + 4
            })
          }}
          className="min-w-0 flex-1 resize-y bg-transparent px-3 py-2 font-mono text-sm leading-6 text-emerald-100 focus:outline-none"
        />
      </div>
    </div>
  )
}

/* ---------- File upload ---------- */

function FileUploadInput(props: {
  item: Extract<StudentFormItem, { inputType: 'file_upload' }>
  value: FormAnswerValue
  onChange(v: FormAnswerValue): void
  assets: FormAssetMap
  disabled: boolean
}): React.JSX.Element {
  const { item, value, onChange, disabled = false } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const fileNames = value.kind === 'files' ? value.fileNames : []
  const exts = item.validation?.allowedExtensions ?? []
  const maxSizeMb = Math.round((item.validation?.maxFileSizeBytes ?? 10 * 1024 * 1024) / 1024 / 1024)
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-2 rounded-xl border border-dashed border-slate-600 px-4 py-3 text-sm text-slate-300 transition hover:border-sky-600 hover:text-sky-200"
      >
        เลือกไฟล์งาน{item.acceptMultiple ? ' (หลายไฟล์ได้)' : ''}
      </button>
      <p className="text-xs text-slate-500">
        {exts.length > 0 ? `รับเฉพาะ: ${exts.join(', ')} · ` : ''}ขนาดไม่เกิน {maxSizeMb} MB ต่อไฟล์
      </p>
      {fileNames.length > 0 && (
        <ul className="space-y-1">
          {fileNames.map((name, idx) => (
            <li key={`${name}-${idx}`} className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-1.5 text-sm">
              <span className="truncate text-slate-200">{name}</span>
              <button
                type="button"
                className="ml-auto text-xs text-red-300 hover:text-red-200"
                onClick={() => onChange({ kind: 'files', fileNames: fileNames.filter((_, i) => i !== idx) })}
              >
                เอาออก
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        hidden
        type="file"
        multiple={item.acceptMultiple}
        accept={exts.join(',')}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length === 0) return
          onChange({ kind: 'files', fileNames: item.acceptMultiple ? [...fileNames, ...files.map((f) => f.name)].slice(0, 10) : files.slice(0, 1).map((f) => f.name) })
          e.target.value = ''
        }}
      />
    </div>
  )
}

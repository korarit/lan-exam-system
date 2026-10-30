import { useRef } from 'react'
import { Paperclip, X } from 'lucide-react'
import type { StudentFormItem, FormAssetMap } from '../../shared/form-schema'
import type { FormAnswerValue } from '../../shared/form-validate'
import { assetDataUrl } from '../builder/builder-assets'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Card } from '@renderer/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import { cn } from '@renderer/lib/utils'

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
      {itemImage && <img src={itemImage} alt="" className="max-h-64 rounded-md border" />}
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
            className={cn(
              'flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 transition',
              checked ? 'border-primary bg-primary/10' : 'hover:border-muted-foreground/50'
            )}
          >
            <input
              type={single ? 'radio' : 'checkbox'}
              className="h-4 w-4 accent-primary"
              checked={checked}
              onChange={toggle}
              disabled={disabled}
            />
            <span className="text-sm">{choice.text}</span>
            {image && <img src={image} alt="" className="ml-auto max-h-20 rounded-md border" />}
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
    <Select
      value={selected}
      onValueChange={(v) => onChange({ kind: 'choice', choiceId: v })}
      disabled={disabled}
    >
      <SelectTrigger className="w-full max-w-md text-sm"><SelectValue placeholder="— เลือกตัวเลือก —" /></SelectTrigger>
      <SelectContent>
        {item.choices.map((c) => (
          <SelectItem key={c.choiceId} value={c.choiceId}>{c.text}</SelectItem>
        ))}
      </SelectContent>
    </Select>
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
    <Input
      type="text"
      value={text}
      disabled={disabled}
      maxLength={item.validation?.maxLength ?? 200}
      onChange={(e) => onChange({ kind: 'text', text: e.target.value })}
      className="w-full max-w-xl text-sm"
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
      className="w-full rounded-md border border-input bg-background px-4 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      <Input
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
        className="w-40 font-mono tabular-nums"
      />
      {item.unit.length > 0 && <span className="text-sm text-muted-foreground">{item.unit}</span>}
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
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-40" />
            {item.columns.map((col) => (
              <TableHead key={col.columnId} className="px-1 text-center">{col.label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {item.rows.map((row) => (
            <TableRow key={row.rowId}>
              <TableCell className="w-40 pr-2 align-middle">{row.label}</TableCell>
              {item.columns.map((col) => {
                const cellChecked =
                  single
                    ? rowAnswers[row.rowId] === col.columnId
                    : Array.isArray(rowAnswers[row.rowId]) && (rowAnswers[row.rowId] as string[]).includes(col.columnId)
                return (
                  <TableCell key={col.columnId} className="px-1 py-1.5 text-center">
                    <input
                      type={single ? 'radio' : 'checkbox'}
                      className="h-4 w-4 accent-primary"
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
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
      {item.leftLabel !== undefined && <span className="text-xs text-muted-foreground">{item.leftLabel}</span>}
      <div className="flex gap-1.5">
        {values.map((v) => (
          <label
            key={v}
            className={cn(
              'flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border text-sm tabular-nums transition',
              selected === v ? 'border-primary bg-primary/10 text-primary' : ''
            )}
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
      {item.rightLabel !== undefined && <span className="text-xs text-muted-foreground">{item.rightLabel}</span>}
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
    <Input
      type={inputType}
      value={current.replace(' ', 'T')}
      disabled={disabled}
      onChange={(e) => onChange({ kind: 'text', text: e.target.value.replace('T', ' ') })}
      className="w-full max-w-xs text-sm"
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
  return (
    <Card>
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
        <Badge variant="secondary" className="font-mono">{item.language}</Badge>
        <span className="tabular-nums">{lineCount} บรรทัด · Tab ย่อหน้าได้</span>
      </div>
      <div className="flex">
        <div aria-hidden className="select-none overflow-hidden border-r px-2 py-2 text-right font-mono text-xs leading-6 text-muted-foreground">
          {Array.from({ length: Math.max(lineCount, item.starterCode.split('\n').length > lineCount ? item.starterCode.split('\n').length : lineCount) }, (_, i) => i + 1).join('\n')}
        </div>
        <textarea
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
          className="min-w-0 flex-1 resize-y bg-transparent px-3 py-2 font-mono text-sm leading-6 outline-none"
        />
      </div>
    </Card>
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
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="border-dashed"
      >
        <Paperclip size={14} />
        เลือกไฟล์งาน{item.acceptMultiple ? ' (หลายไฟล์ได้)' : ''}
      </Button>
      <p className="text-xs text-muted-foreground tabular-nums">
        {exts.length > 0 ? `รับเฉพาะ: ${exts.join(', ')} · ` : ''}ขนาดไม่เกิน {maxSizeMb} MB ต่อไฟล์
      </p>
      {fileNames.length > 0 && (
        <ul className="space-y-1">
          {fileNames.map((name, idx) => (
            <li key={`${name}-${idx}`} className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
              <span className="truncate">{name}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto text-destructive"
                onClick={() => onChange({ kind: 'files', fileNames: fileNames.filter((_, i) => i !== idx) })}
              >
                <X size={13} /> เอาออก
              </Button>
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

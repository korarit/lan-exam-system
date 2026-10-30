import { useRef } from 'react'
import { ArrowDown, ArrowUp, Copy, ImagePlus, Trash2, X } from 'lucide-react'
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
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Separator } from '@renderer/components/ui/separator'
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
      <Card className="cursor-pointer border-primary/30" onClick={onToggleExpand}>
        <CardContent className="pt-4">
          {expanded ? (
            <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
              <Input
                value={item.title}
                maxLength={200}
                onChange={(e) => onChange({ ...item, title: e.target.value })}
                className="font-semibold"
                placeholder="ชื่อส่วน (Section)"
                aria-label="ชื่อส่วน"
              />
              <textarea
                value={item.description}
                maxLength={2000}
                rows={2}
                onChange={(e) => onChange({ ...item, description: e.target.value })}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="คำชี้แจงของส่วนนี้"
                aria-label="คำชี้แจงของส่วน"
              />
              <CardFooter onRemove={onRemove} onDuplicate={onDuplicate} onMove={onMove} onFirst={onFirst} onLast={onLast} />
            </div>
          ) : (
            <>
              <h3 className="font-semibold text-primary">{index + 1}. {item.title}</h3>
              {item.description.length > 0 && <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>}
            </>
          )}
        </CardContent>
      </Card>
    )
  }

  if (item.inputType === 'media_stimulus') {
    return (
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">สื่อประกอบโจทย์</span>
            {expanded ? (
              <div onClick={(e) => e.stopPropagation()}>
                <p className="mb-2 text-xs text-muted-foreground">คำอธิบายใต้ภาพ:</p>
                <Input
                  value={item.caption}
                  maxLength={1000}
                  onChange={(e) => onChange({ ...item, caption: e.target.value })}
                  aria-label="คำอธิบายใต้ภาพ"
                />
                <CardFooter onRemove={onRemove} onDuplicate={onDuplicate} onMove={onMove} onFirst={onFirst} onLast={onLast} />
              </div>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={onToggleExpand}>
                แก้ไข
              </Button>
            )}
          </div>
          {image ? <img src={image} alt="" className="mt-2 max-h-56 rounded-md border" /> : <p className="mt-2 text-xs text-destructive">ภาพหาย (asset ไม่พบ)</p>}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={expanded ? 'border-primary/60' : 'hover:border-muted-foreground/40'}>
      <CardContent className="pt-5">
        {!expanded && (
          <button type="button" onClick={onToggleExpand} className="w-full">
            <div className="flex flex-wrap items-center gap-2 text-left">
              <span className="text-xs text-muted-foreground tabular-nums">ข้อ {index + 1}</span>
              <Badge variant="secondary">{INPUT_TYPE_LABELS[item.inputType]}</Badge>
              <Badge variant="outline" className="tabular-nums">{item.points} คะแนน</Badge>
              {item.validation.required && <span className="text-[10px] text-destructive">จำเป็นต้องตอบ</span>}
              <KeyBadge item={item} />
            </div>
            <p className="mt-2 truncate text-left text-sm">{promptOrPlaceholder(item as FormQuestion)}</p>
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
              className="w-full resize-y rounded-md border border-input bg-background px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="โจทย์"
            />
            <TypeSelector item={item} onChange={onChange} />
            {image && (
              <div className="flex items-center gap-3">
                <img src={image} alt="" className="max-h-32 rounded-md border" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange({ ...item, imageAssetId: undefined })}
                  className="text-destructive"
                >
                  ลบรูปประกอบโจทย์
                </Button>
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
      </CardContent>
    </Card>
  )
}

function promptOrPlaceholder(item: FormQuestion): string {
  return item.prompt.length > 0 ? item.prompt : '(โจทย์ — ยังไม่ได้พิมพ์)'
}

function KeyBadge(props: { item: FormItem }): React.JSX.Element | null {
  const item = props.item
  if (item.inputType === 'section_header' || item.inputType === 'media_stimulus') return null
  const parsed = AnswerKeySchema.safeParse(item.answerKey)
  if (!parsed.success) return <Badge variant="destructive">เฉลยไม่ถูกต้อง</Badge>
  const key = parsed.data
  if (key.gradingType === 'ungraded') return <Badge variant="secondary">ไม่คิดคะแนน</Badge>
  if (key.gradingType === 'manual_rubric') {
    return <Badge variant="outline">รอครูตรวจ (Rubric)</Badge>
  }
  return <Badge>เฉลยพร้อมตรวจ</Badge>
}

/* ---------- เลือกชนิด Input (เปลี่ยนได้ไม่หายข้อมูล) ---------- */

function TypeSelector(props: { item: FormItem; onChange(item: FormItem): void }): React.JSX.Element {
  const { item, onChange } = props
  const current: typeof item.inputType = item.inputType
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label className="text-xs">ชนิดข้อ</Label>
      <Select
        value={current}
        onValueChange={(v) => {
          const nextType = v as typeof item.inputType
          if (nextType === item.inputType) return
          onChange(migrateItemToType(item, nextType))
        }}
      >
        <SelectTrigger className="w-64 text-sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          {DYNAMIC_FORM_INPUT_TYPES.map((t) => (
            <SelectItem key={t} value={t}>{INPUT_TYPE_LABELS[t]}</SelectItem>
          ))}
          <SelectItem value="section_header">แบ่งตอน (หัวข้อ)</SelectItem>
          <SelectItem value="media_stimulus">รูป/สื่อประกอบ</SelectItem>
        </SelectContent>
      </Select>
      <Input
        type="number"
        min={0.5}
        step={0.5}
        value={'points' in item ? item.points : 1}
        onChange={(e) => {
          if ('points' in item) onChange({ ...item, points: Math.max(0.5, Number(e.target.value) || 1) })
        }}
        className="w-20 text-right font-mono tabular-nums"
        aria-label="คะแนนข้อนี้"
      />
      <span className="text-xs text-muted-foreground">คะแนน</span>
    </div>
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

/* ---------- Body: แก้ตามชนิด ---------- */

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
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <Label>จาก <Input type="number" min={0} max={99} value={item.scaleMin} onChange={(e) => setMin(Number(e.target.value))} className="w-16 text-right font-mono tabular-nums" /></Label>
          <Label>ถึง <Input type="number" min={1} max={100} value={item.scaleMax} onChange={(e) => setMax(Number(e.target.value))} className="w-16 text-right font-mono tabular-nums" /></Label>
          <Input value={item.leftLabel ?? ''} placeholder="ป้ายซ้าย" onChange={(e) => onChange(item.inputType === 'linear_scale' ? { ...item, leftLabel: labelOrUndefined(e.target.value) } : item)} className="w-36 text-xs" />
          <Input value={item.rightLabel ?? ''} placeholder="ป้ายขวา" onChange={(e) => onChange(item.inputType === 'linear_scale' ? { ...item, rightLabel: labelOrUndefined(e.target.value) } : item)} className="w-36 text-xs" />
        </div>
      )
    }
    case 'date_time':
      return (
        <Label className="flex items-center gap-2 text-xs text-muted-foreground">
          รูปแบบ:
          <Select
            value={item.mode}
            onValueChange={(v) => onChange(item.inputType === 'date_time' ? { ...item, mode: v as 'date' | 'time' | 'datetime' } : item)}
          >
            <SelectTrigger className="w-40 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="date">วันที่</SelectItem>
              <SelectItem value="time">เวลา</SelectItem>
              <SelectItem value="datetime">วันที่+เวลา</SelectItem>
            </SelectContent>
          </Select>
        </Label>
      )
    case 'numeric_param': {
      const params = item.parameters ?? {}
      return (
        <Card className="bg-muted/40">
          <CardContent className="space-y-2 pt-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              หน่วยกำกับ:
              <Input value={item.unit} onChange={(e) => onChange(item.inputType === 'numeric_param' ? { ...item, unit: e.target.value.slice(0, 30) } : item)} className="w-24" placeholder="เช่น บาท, m/s" />
            </div>
            <p className="text-xs text-muted-foreground">{'ตัวแปรสุ่มที่จะถูกแทนค่าในโจทย์ เช่น ใช้ {{a}} ในโจทย์แล้วใส่สูตรเฉลย "a * 2 + 1"'}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ตัวแปร</TableHead>
                  <TableHead>จาก</TableHead>
                  <TableHead>ถึง</TableHead>
                  <TableHead>ก้าว</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.keys(params).map((name) => (
                  <TableRow key={name}>
                    <TableCell className="font-mono text-primary">{name}</TableCell>
                    <TableCell><Input type="number" value={params[name]?.min ?? 0} onChange={(e) => onChange(item.inputType === 'numeric_param' ? { ...item, parameters: { ...params, [name]: { min: Number(e.target.value), max: params[name]?.max ?? 10, step: params[name]?.step ?? 1 } } } : item)} className="w-16 text-right font-mono tabular-nums" /></TableCell>
                    <TableCell><Input type="number" value={params[name]?.max ?? 10} onChange={(e) => onChange(item.inputType === 'numeric_param' ? { ...item, parameters: { ...params, [name]: { min: params[name]?.min ?? 0, max: Number(e.target.value), step: params[name]?.step ?? 1 } } } : item)} className="w-16 text-right font-mono tabular-nums" /></TableCell>
                    <TableCell><Input type="number" min={1} value={params[name]?.step ?? 1} onChange={(e) => onChange(item.inputType === 'numeric_param' ? { ...item, parameters: { ...params, [name]: { min: params[name]?.min ?? 0, max: params[name]?.max ?? 10, step: Math.max(1, Number(e.target.value)) } } } : item)} className="w-14 text-right font-mono tabular-nums" /></TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const { [name]: _drop, ...rest } = params
                          onChange(item.inputType === 'numeric_param' ? { ...item, parameters: Object.keys(rest).length > 0 ? rest : undefined } : item)
                        }}
                      >
                        ลบ
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const name = `p${Object.keys(params).length + 1}`
                onChange(item.inputType === 'numeric_param' ? { ...item, parameters: { ...params, [name]: { min: 1, max: 10, step: 1 } } } : item)
              }}
            >
              + เพิ่มตัวแปรสุ่ม
            </Button>
          </CardContent>
        </Card>
      )
    }
    case 'code_snippet':
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Label>ภาษา:</Label>
            <Select
              value={item.language}
              onValueChange={(v) => onChange(item.inputType === 'code_snippet' ? { ...item, language: v as 'python' | 'c' | 'cpp' | 'java' | 'sql' | 'js' } : item)}
            >
              <SelectTrigger className="w-36 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {['python', 'c', 'cpp', 'java', 'sql', 'js'].map((l) => (
                  <SelectItem key={l} value={l}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <textarea
            value={item.starterCode}
            rows={4}
            spellCheck={false}
            placeholder="Starter Code ตั้งต้น (แสดงในกล่องคำตอบของนักเรียน)"
            onChange={(e) => onChange(item.inputType === 'code_snippet' ? { ...item, starterCode: e.target.value.slice(0, 20000) } : item)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Starter Code"
          />
        </div>
      )
    case 'file_upload': {
      const exts = item.validation.allowedExtensions ?? []
      return (
        <div className="space-y-1.5 text-xs text-muted-foreground">
          <Label className="flex items-center gap-2">
            <input type="checkbox" checked={item.acceptMultiple} onChange={(e) => onChange(item.inputType === 'file_upload' ? { ...item, acceptMultiple: e.target.checked } : item)} />
            อนุญาตหลายไฟล์
          </Label>
          <Input
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
          />
          <Label className="flex items-center gap-2">
            ขนาดสูงสุด (MB):
            <Input
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
              className="w-20 text-right font-mono tabular-nums"
            />
          </Label>
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
            <Input
              value={choice.text}
              maxLength={500}
              onChange={(e) => {
                const copy = [...choices]
                copy[idx] = { ...choice, text: e.target.value }
                onChange(copy)
              }}
              className="flex-1 text-sm"
              aria-label={`ตัวเลือกที่ ${idx + 1}`}
            />
            {img ? (
              <>
                <img src={img} alt="" className="max-h-10 rounded border" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const copy = [...choices]
                    copy[idx] = { choiceId: choice.choiceId, text: choice.text }
                    onChange(copy)
                  }}
                >
                  ลบรูป
                </Button>
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
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onChange(choices.filter((_, i) => i !== idx))}
              disabled={choices.length <= 2}
              aria-label="ลบตัวเลือก"
            >
              <X size={14} />
            </Button>
          </div>
        )
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...choices, FormChoiceSchema.parse({ choiceId: `c${choices.length + 1}${Math.random().toString(36).slice(2, 4)}`, text: `ตัวเลือก ${choices.length + 1}` })])}
        disabled={choices.length >= 20}
      >
        + เพิ่มตัวเลือก
      </Button>
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
        <p className="text-xs text-muted-foreground">แถว (คำถามย่อย)</p>
        {rows.map((r, idx) => (
          <div key={r.rowId} className="flex items-center gap-1.5">
            <Input
              value={r.label}
              onChange={(e) => {
                const copy = [...rows]
                copy[idx] = { ...r, label: e.target.value }
                onRows(copy)
              }}
              className="flex-1 text-sm"
              aria-label={`แถวที่ ${idx + 1}`}
            />
            <Button type="button" variant="ghost" size="icon" onClick={() => onRows(rows.filter((_, i) => i !== idx))} aria-label="ลบแถว"><X size={14} /></Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onRows([...rows, GridRowSchema.parse({ rowId: `r${rows.length + 1}${Math.random().toString(36).slice(2, 4)}`, label: `แถว ${rows.length + 1}` })])} disabled={rows.length >= 12}>+ แถว</Button>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">คอลัมน์ (ตัวเลือก)</p>
        {columns.map((c, idx) => (
          <div key={c.columnId} className="flex items-center gap-1.5">
            <Input
              value={c.label}
              onChange={(e) => {
                const copy = [...columns]
                copy[idx] = { ...c, label: e.target.value }
                onColumns(copy)
              }}
              className="flex-1 text-sm"
              aria-label={`คอลัมน์ที่ ${idx + 1}`}
            />
            <Button type="button" variant="ghost" size="icon" onClick={() => onColumns(columns.filter((_, i) => i !== idx))} aria-label="ลบคอลัมน์"><X size={14} /></Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onColumns([...columns, GridColumnSchema.parse({ columnId: `c${columns.length + 1}${Math.random().toString(36).slice(2, 4)}`, label: `หัวข้อ ${columns.length + 1}` })])} disabled={columns.length >= 12}>+ คอลัมน์</Button>
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
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
      <Label className="flex items-center gap-1.5 text-destructive">
        <input type="checkbox" checked={v.required} onChange={(e) => onChangeRule({ required: e.target.checked })} />
        จำเป็นต้องตอบ
      </Label>
      {isText && (
        <>
          <Label>ต่ำสุด <Input type="number" min={0} value={v.minLength ?? ''} placeholder="—" onChange={(e) => onChangeRule({ minLength: optionalNumber(e.target.value) })} className="w-16 text-right font-mono tabular-nums" /></Label>
          <Label>สูงสุด <Input type="number" min={0} value={v.maxLength ?? ''} placeholder="—" onChange={(e) => onChangeRule({ maxLength: optionalNumber(e.target.value) })} className="w-16 text-right font-mono tabular-nums" /></Label>
        </>
      )}
      {item.inputType === 'long_text' && (
        <>
          <Label>คำขั้นต่ำ <Input type="number" min={0} value={v.minWords ?? ''} placeholder="—" onChange={(e) => onChangeRule({ minWords: optionalNumber(e.target.value) })} className="w-16 text-right font-mono tabular-nums" /></Label>
          <Label>คำขั้นสูงสุด <Input type="number" min={0} value={v.maxWords ?? ''} placeholder="—" onChange={(e) => onChangeRule({ maxWords: optionalNumber(e.target.value) })} className="w-16 text-right font-mono tabular-nums" /></Label>
        </>
      )}
      {isMulti && (
        <>
          <Label>เลือกน้อย <Input type="number" min={0} value={v.minSelect ?? ''} placeholder="—" onChange={(e) => onChangeRule({ minSelect: optionalNumber(e.target.value) })} className="w-16 text-right font-mono tabular-nums" /></Label>
          <Label>เลือกมาก <Input type="number" min={0} value={v.maxSelect ?? ''} placeholder="—" onChange={(e) => onChangeRule({ maxSelect: optionalNumber(e.target.value) })} className="w-16 text-right font-mono tabular-nums" /></Label>
        </>
      )}
      {(isText || item.inputType === 'numeric_param') && (
        <Label>Regex <Input value={v.regexPattern ?? ''} placeholder="เช่น ^\d+$" onChange={(e) => onChangeRule({ regexPattern: e.target.value.length > 0 ? e.target.value : undefined })} className="w-40 font-mono" /></Label>
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
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <Label className="flex items-center gap-1.5">
        คะแนน:
        <Input
          type="number"
          min={0.5}
          step={0.5}
          value={item.points}
          onChange={(e) => onChange({ ...item, points: Math.max(0.5, Number(e.target.value) || 1) })}
          className="w-16 text-right font-mono tabular-nums"
        />
      </Label>
      {'choices' in item || 'rows' in item || item.inputType === 'linear_scale' ? (
        <Label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={item.shuffleChoices}
            onChange={(e) => onChange({ ...item, shuffleChoices: e.target.checked })}
          />
          สลับลำดับ{('choices' in item ? 'ตัวเลือก' : item.inputType === 'linear_scale' ? 'สเกล' : 'แถว')}รายคน
        </Label>
      ) : null}
      {item.inputType === 'numeric_param' && 'parameters' in item && item.parameters !== undefined && (
        <span className="text-[10px] text-muted-foreground">(คะแนนและตัวแปรจะใช้ตรวจสูตรเฉลยตาม seed ของนักเรียนจริง)</span>
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
      <Button
        type="button"
        variant="outline"
        size={small ? 'sm' : 'default'}
        onClick={() => ref.current?.click()}
        className="border-dashed"
      >
        <ImagePlus size={14} /> แนบรูป (ลดขนาดอัตโนมัติ)
      </Button>
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
    <div className="pt-1">
      <Separator />
      <div className="flex items-center gap-1 pt-2 text-xs">
        <Button type="button" variant="ghost" size="icon" onClick={() => onMove('up')} disabled={onFirst} aria-label="เลื่อนขึ้น"><ArrowUp size={14} /></Button>
        <Button type="button" variant="ghost" size="icon" onClick={() => onMove('down')} disabled={onLast} aria-label="เลื่อนลง"><ArrowDown size={14} /></Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDuplicate}><Copy size={13} /> ซ้ำ</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove} className="text-destructive"><Trash2 size={13} /> ลบข้อ</Button>
      </div>
    </div>
  )
}

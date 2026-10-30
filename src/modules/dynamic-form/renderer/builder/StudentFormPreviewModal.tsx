import { useMemo, useState } from 'react'
import { Award, CheckCircle2, XCircle, PencilLine } from 'lucide-react'
import type { DynamicFormDefinition, StudentFormViewItem, FormAssetMap } from '../../shared/form-schema'
import { isFormItemQuestion } from '../../shared/form-schema'
import { stripAnswerKeyForStudent } from '../../shared/student-view'
import { FormAnswerInput } from '../inputs/FormAnswerInput'
import {
  type FormAnswerValue,
  validateItemAnswer,
  normalizeAnswer
} from '../../shared/form-validate'
import { gradeAnsweredPoints } from '../../shared/form-grading'
import { listQuestions } from './form-builder-store'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'

/* ============================================================
 * Phase 6 (6.2.4) — โหมดจำลองทำข้อสอบของนักเรียน (Preview as Student)
 * - เรนเดอร์แบบเหมือนเครื่องนักเรียน (ตัดเฉลยแล้ว + สลับตาม seed จำลอง)
 * - ส่งพรีวิวด้วยการตรวจเฉลยอัตโนมัติทันที (auto grade ของ form-grading)
 * ============================================================ */

export interface StudentFormPreviewModalProps {
  form: DynamicFormDefinition
  assets: FormAssetMap
  onClose(): void
  open?: boolean
  onOpenChange?(open: boolean): void
}

export default function StudentFormPreviewModal(props: StudentFormPreviewModalProps): React.JSX.Element {
  const { form, assets, onClose } = props
  const previewSeed = 'previews-seed'

  const view = useMemo(() => stripAnswerKeyForStudent(form, previewSeed), [form])

  const [answers, setAnswers] = useState<Record<string, FormAnswerValue>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)

  const setAnswer = (itemId: string, value: FormAnswerValue): void => {
    setAnswers((prev) => ({ ...prev, [itemId]: value }))
    setErrors((prev) => {
      const { [itemId]: _drop, ...rest } = prev
      return rest
    })
  }

  // แปลง item ของมุมมองเป็นรูปที่ keep คะแนน ใช้ตรวจจากฟอร์มต้นฉบับ
  const questionIds = form.items.filter(isFormItemQuestion).map((i) => i.itemId)

  function submit(): void {
    const nextErrors: Record<string, string> = {}
    for (const itemId of questionIds) {
      const item = form.items.find((i) => i.itemId === itemId)
      if (item === undefined || !isFormItemQuestion(item)) continue
      const err = validateItemAnswer(item, answers[itemId] ?? { kind: 'none' })
      if (err !== null) nextErrors[itemId] = err
    }
    setErrors(nextErrors)
    setSubmitted(true)
  }

  const totalAutoEarned = questionIds.reduce((sum, itemId) => {
    const item = form.items.find((i) => i.itemId === itemId)
    if (item === undefined || !isFormItemQuestion(item)) return sum
    const normalized = normalizeAnswer(item, answers[itemId] ?? { kind: 'none' })
    if (normalized === null) return sum
    const resolved = view.resolvedParameters[itemId] ?? {}
    return sum + gradeAnsweredPoints(item, normalized, Object.keys(resolved).length > 0 ? resolved : undefined).earnedPoints
  }, 0)
  const totalMax = listQuestions(form.items).reduce((sum, q) => sum + q.points, 0)
  const open = props.open ?? true

  return (
    <Dialog open={open} onOpenChange={(o) => { props.onOpenChange?.(o); if (!o) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-medium">
            <PencilLine size={14} /> พรีวิวมุมมองนักเรียน
          </DialogTitle>
          <DialogDescription>
            สลับข้อ/ตัวเลือกตาม seed จำลอง — ตัดเฉลยแน่นอน · {listQuestions(form.items).length} ข้อ · เวลา {form.settings.durationMinutes} นาที ·{' '}
            {form.settings.navigationPolicy === 'strict-one-way' ? 'ไปข้างหน้ากลับไม่ได้' : 'ย้อนกลับได้เฉพาะข้อที่เปิดแล้ว'}
          </DialogDescription>
        </DialogHeader>
        <h2 className="text-xl font-semibold">{form.title}</h2>
        {form.instructions.length > 0 && <p className="text-sm text-muted-foreground">{form.instructions}</p>}

        <ScrollArea className="max-h-[50vh] pr-4">
          <div className="space-y-4">
            {view.view.items.map((item, idx) => (
              <PreviewItemBlock
                key={item.itemId}
                item={item}
                viewItemIndex={idx}
                assets={assets}
                value={answers[item.itemId] ?? { kind: 'none' } satisfies FormAnswerValue}
                error={errors[item.itemId]}
                submitted={submitted}
                onChange={(v) => setAnswer(item.itemId, v)}
              />
            ))}
          </div>
        </ScrollArea>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={submit}>
            ส่งข้อสอบ (จำลอง)
          </Button>
          {submitted && (
            <div className="flex items-center gap-2 text-sm">
              <Award size={16} className="text-primary" />
              <span>
                ตรวจอัตโนมัติได้ <b className="tabular-nums">{totalAutoEarned}</b> / <span className="tabular-nums">{totalMax}</span> คะแนน
              </span>
              <Badge variant="secondary">ข้อที่รอครูตรวจยังไม่นับ</Badge>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PreviewItemBlock(props: {
  item: StudentFormViewItem
  viewItemIndex: number
  assets: FormAssetMap
  value: FormAnswerValue
  error?: string | undefined
  submitted: boolean
  onChange(value: FormAnswerValue): void
}): React.JSX.Element {
  const { item, viewItemIndex, assets, value, error, submitted, onChange } = props
  if (item.inputType === 'section_header') {
    return (
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="pt-4">
          <h3 className="font-semibold">{item.title}</h3>
          {item.description.length > 0 && <p className="text-sm text-muted-foreground">{item.description}</p>}
        </CardContent>
      </Card>
    )
  }
  if (item.inputType === 'media_stimulus') {
    return (
      <Card>
        <CardContent className="pt-4">
          <MediaImage assets={assets} assetId={item.imageAssetId} />
          {item.caption.length > 0 && <p className="mt-2 text-sm text-muted-foreground">{item.caption}</p>}
        </CardContent>
      </Card>
    )
  }
  return (
    <Card className={submitted && error !== undefined ? 'border-destructive/60' : undefined}>
      <CardContent className="pt-5">
        <div className="mb-3 flex items-start gap-2">
          <Badge variant="outline" className="mt-0.5 tabular-nums">{viewItemIndex + 1}</Badge>
          <p className={`flex-1 whitespace-pre-wrap text-sm ${submitted === true && error !== undefined ? 'text-destructive' : ''}`}>{item.prompt}</p>
        </div>
        <FormAnswerInput item={item} value={value} onChange={onChange} assets={assets} />
        {submitted && (
          <div className="mt-2 flex items-center gap-1.5 text-xs">
            {error !== undefined ? (
              <>
                <XCircle size={14} className="text-destructive" />
                <span className="text-destructive">{error}</span>
              </>
            ) : (
              <>
                <CheckCircle2 size={14} className="text-primary" />
                <span className="text-muted-foreground">ผ่านเงื่อนไขการตรวจ (คะแนนแสดงเมื่อครูปล่อย)</span>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MediaImage(props: { assets: FormAssetMap; assetId: string }): React.JSX.Element {
  const { assets, assetId } = props
  const asset = assets[assetId]
  if (asset === undefined) return <span className="text-xs text-destructive">(ภาพไม่พบ)</span>
  return <img src={`data:${asset.mimeType};base64,${asset.dataBase64}`} alt="" className="max-h-56 rounded-md border" />
}

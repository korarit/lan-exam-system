import { useMemo, useState } from 'react'
import { X, Award, CheckCircle2, XCircle, PencilLine } from 'lucide-react'
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

/* ============================================================
 * Phase 6 (6.2.4) — โหมดจำลองทำข้อสอบของนักเรียน (Preview as Student)
 * - เรนเดอร์แบบเหมือนเครื่องนักเรียน (ตัดเฉลยแล้ว + สลับตาม seed จำลอง)
 * - ส่งพรีวิวด้วยการตรวจเฉลยอัตโนมัติทันที (auto grade ของ form-grading)
 * ============================================================ */

export interface StudentFormPreviewModalProps {
  form: DynamicFormDefinition
  assets: FormAssetMap
  onClose(): void
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
    if (Object.keys(nextErrors).length > 0) return
    window.alert('ส่งทั้งหมดเรียบร้อย (จำลอง) — ดูคะแนนด้านล่าง')
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

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/80 p-6">
      <div className="mx-auto max-w-3xl rounded-2xl border border-slate-700 bg-slate-900 p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <PencilLine size={14} /> พรีวิวมุมมองนักเรียน (สลับข้อ/ตัวเลือกตาม seed จำลอง — ตัดเฉลยแน่นอน)
            </div>
            <h2 className="mt-1 text-xl font-semibold">{form.title}</h2>
            {form.instructions.length > 0 && <p className="mt-1 text-sm text-slate-400">{form.instructions}</p>}
            <p className="mt-1 text-xs text-slate-500">
              {listQuestions(form.items).length} ข้อ · เวลา {form.settings.durationMinutes} นาที ·{' '}
              {form.settings.navigationPolicy === 'strict-one-way' ? 'ไปข้างหน้ากลับไม่ได้' : 'ย้อนกลับได้เฉพาะข้อที่เปิดแล้ว'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-700 p-2 text-slate-400 hover:bg-slate-800">
            <X size={16} />
          </button>
        </div>

        <div className="mt-5 space-y-4">
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

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={submit}
            className="rounded-xl bg-sky-600 px-5 py-2.5 font-semibold text-white hover:bg-sky-500"
          >
            ส่งข้อสอบ (จำลอง)
          </button>
          {submitted && (
            <div className="flex items-center gap-2 text-sm">
              <Award size={16} className="text-amber-300" />
              <span className="text-slate-200">
                ตรวจอัตโนมัติได้ <b>{totalAutoEarned}</b> / {totalMax} คะแนน
              </span>
              <span className="text-xs text-slate-500">(ข้อที่รอครูตรวจยังไม่นับ)</span>
            </div>
          )}
        </div>
      </div>
    </div>
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
      <div className="rounded-xl border border-indigo-800/40 bg-indigo-950/20 p-4">
        <h3 className="font-semibold text-indigo-200">{item.title}</h3>
        {item.description.length > 0 && <p className="text-sm text-slate-400">{item.description}</p>}
      </div>
    )
  }
  if (item.inputType === 'media_stimulus') {
    return (
      <div className="rounded-xl border border-slate-800 p-4">
        <MediaImage assets={assets} assetId={item.imageAssetId} />
        {item.caption.length > 0 && <p className="mt-2 text-sm text-slate-400">{item.caption}</p>}
      </div>
    )
  }
  return (
    <section className={`rounded-2xl border p-5 ${!submitted || error === undefined ? 'border-slate-800 bg-slate-900/60' : 'border-red-800/60 bg-red-950/10'}`}>
      <div className="mb-3 flex items-start gap-2">
        <span className="mt-0.5 text-xs text-slate-500">{viewItemIndex + 1}.</span>
        <p className={`flex-1 whitespace-pre-wrap text-sm text-slate-200 ${submitted === true && error !== undefined ? 'text-red-200' : ''}`}>{item.prompt}</p>
      </div>
      <FormAnswerInput item={item} value={value} onChange={onChange} assets={assets} />
      {submitted && (
        <div className="mt-2 flex items-center gap-1.5 text-xs">
          {error !== undefined ? (
            <>
              <XCircle size={14} className="text-red-400" />
              <span className="text-red-300">{error}</span>
            </>
          ) : (
            <>
              <CheckCircle2 size={14} className="text-emerald-400" />
              <span className="text-emerald-300">ผ่านเงื่อนไขการตรวจ (คะแนนแสดงเมื่อครูปล่อย)</span>
            </>
          )}
        </div>
      )}
    </section>
  )
}

function MediaImage(props: { assets: FormAssetMap; assetId: string }): React.JSX.Element {
  const { assets, assetId } = props
  const asset = assets[assetId]
  if (asset === undefined) return <span className="text-xs text-red-300">(ภาพไม่พบ)</span>
  return <img src={`data:${asset.mimeType};base64,${asset.dataBase64}`} alt="" className="max-h-56 rounded-lg border border-slate-700" />
}

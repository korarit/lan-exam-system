import { useMemo, useRef, useState } from 'react'
import { Send, Save, ClipboardList } from 'lucide-react'
import type { StudentWorkspaceProps } from '@shared/module-contract'
import type {
  FormItem,
  StudentFormItem,
  StudentFormView,
  StudentFormViewItem
} from '../../shared/form-schema'
import { isFormItemQuestion } from '../../shared/form-schema'
import type { FormAnswerValue } from '../../shared/form-validate'
import type { StoredAnswerValue } from '../../shared/form-answer-schema'
import { FormAnswerInput } from '../inputs/FormAnswerInput'

/* ============================================================
 * F-1 — หน้าทำข้อสอบ dynamic-form ของนักเรียน (ผ่านท่อ LAN)
 * - รับ stripped view จาก MODULE_STATE_PUSH (ExamView ส่งมาเป็น moduleState)
 * - ตอบรายข้อ → ส่งผ่าน student:module-send (action) ไป FormHostService.ingestViaTransport
 * - พิมพ์ค้าง → autosave throttle 5 วิ (draft) เหมือนท่อ code-ide
 * - file_upload: F-1 ยังไม่ส่งไบนารีผ่านท่อ module (แสดงป้ายบอก — ครูเก็บไฟล์แนบ
 *   ผ่านช่องทางเดิมของห้องเมื่อพร้อม)
 * ============================================================ */

function isQuestion(item: StudentFormViewItem): item is StudentFormItem {
  return isFormItemQuestion(item as FormItem)
}

/** แปลงค่าจาก input UI เป็น wire format ที่เครื่องแม่ตรวจได้ */
export function toStoredAnswer(item: StudentFormItem, value: FormAnswerValue): StoredAnswerValue {
  switch (value.kind) {
    case 'none':
      return { kind: 'none' }
    case 'choice':
      return { kind: 'choice', choiceId: value.choiceId }
    case 'multi':
      return { kind: 'multi', choiceIds: value.choiceIds }
    case 'numeric':
      return Number.isFinite(value.numeric) ? { kind: 'numeric', numeric: value.numeric } : { kind: 'none' }
    case 'rows':
      return { kind: 'rows', rowAnswers: value.rowAnswers }
    case 'scale':
      return { kind: 'scale', value: value.value }
    case 'files':
      // F-1: ยังไม่ส่งไบนารีไฟล์แนบผ่านท่อ module — ส่ง descriptor ว่างไปก่อน
      return { kind: 'files', artifactIds: [] }
    case 'text':
      if (value.text.length === 0) return { kind: 'none' }
      if (item.inputType === 'code_snippet') return { kind: 'code', text: value.text }
      if (item.inputType === 'date_time') return { kind: 'date', value: value.text }
      return { kind: 'text', text: value.text }
  }
}

function buildSubmission(item: StudentFormItem, value: FormAnswerValue): Record<string, unknown> {
  return {
    itemId: item.itemId,
    value: toStoredAnswer(item, value),
    timeSpentMs: 0,
    clientSubmittedAtMs: Date.now()
  }
}

export default function DynamicFormStudentWorkspace(
  props: { view: StudentFormView } & Pick<StudentWorkspaceProps, 'onDispatchAction' | 'onAutosaveDraft' | 'studentId'>
): React.JSX.Element {
  const { view } = props
  const questions = useMemo(() => view.items.filter(isQuestion), [view])
  const [answers, setAnswers] = useState<Record<string, FormAnswerValue>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const answersRef = useRef(answers)
  const lastAutosaveRef = useRef(0)

  function queueAutosave(next: Record<string, FormAnswerValue>): void {
    const now = Date.now()
    if (now - lastAutosaveRef.current < 5000) return
    lastAutosaveRef.current = now
    const items = questions
      .filter((q) => next[q.itemId] !== undefined)
      .map((q) => buildSubmission(q, next[q.itemId]!))
    if (items.length === 0) return
    props.onAutosaveDraft({ items })
  }

  function setAnswer(itemId: string, value: FormAnswerValue): void {
    const next = { ...answersRef.current, [itemId]: value }
    answersRef.current = next
    setAnswers(next)
    queueAutosave(next)
  }

  async function submitOne(item: StudentFormItem): Promise<void> {
    const value = answersRef.current[item.itemId]
    if (!value) {
      setNotice('⚠️ ตอบข้อนี้ก่อนกดส่ง')
      return
    }
    try {
      await props.onDispatchAction({
        type: 'dynamic-form.submit-item',
        submission: buildSubmission(item, value)
      })
      setNotice(`✅ ส่งข้อ ${item.itemId} แล้ว — รอเครื่องแม่รับเข้า`)
    } catch {
      setNotice('⛔ ส่งไม่สำเร็จ — สายหลุด กดส่งใหม่หลัง reconnect')
    }
  }

  async function submitAll(): Promise<void> {
    const items = questions
      .filter((q) => answersRef.current[q.itemId] !== undefined)
      .map((q) => buildSubmission(q, answersRef.current[q.itemId]!))
    if (items.length === 0) {
      setNotice('⚠️ ยังไม่มีข้อที่ตอบเลย')
      return
    }
    try {
      await props.onDispatchAction({ type: 'dynamic-form.submit-all', items })
      setNotice(`🚀 ส่งงานทั้งหมด ${items.length} ข้อแล้ว — รอเครื่องแม่รับเข้า`)
    } catch {
      setNotice('⛔ ส่งไม่สำเร็จ — สายหลุด กดส่งใหม่หลัง reconnect')
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/40">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-2.5">
        <ClipboardList size={16} className="text-sky-300" />
        <span className="font-semibold text-slate-100">{view.title}</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">
          {questions.length} ข้อ
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void submitAll()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-sky-500"
        >
          <Send size={15} /> ส่งงานทั้งหมด
        </button>
      </div>
      {view.instructions && (
        <p className="border-b border-slate-800 px-4 py-2 text-[13px] whitespace-pre-wrap text-slate-400">
          {view.instructions}
        </p>
      )}
      {notice !== null && (
        <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900/70 px-4 py-1.5 text-xs text-amber-200">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-slate-500 hover:text-slate-200">
            ปิด
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {questions.map((item, idx) => (
          <section key={item.itemId} className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="mb-2 flex items-start gap-2">
              <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-300">
                ข้อ {idx + 1}
              </span>
              <p className="flex-1 text-sm whitespace-pre-wrap text-slate-100">{item.prompt}</p>
            </div>
            <FormAnswerInput
              item={item}
              value={answers[item.itemId] ?? { kind: 'none' }}
              onChange={(v) => setAnswer(item.itemId, v)}
              assets={{}}
            />
            {item.inputType === 'file_upload' && (
              <p className="mt-2 text-[11px] text-amber-300/80">
                📎 F-1: ไฟล์แนบยังไม่ส่งผ่านเครือข่าย — ครูจะเก็บไฟล์ข้อนี้ด้วยวิธีอื่น
              </p>
            )}
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => void submitOne(item)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-700 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-900/40"
              >
                <Save size={13} /> ส่งข้อนี้
              </button>
            </div>
          </section>
        ))}
        {questions.length === 0 && (
          <p className="py-8 text-center text-sm text-slate-500">ฟอร์มนี้ไม่มีข้อคำถาม</p>
        )}
      </div>
    </div>
  )
}

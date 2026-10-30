import { useMemo, useRef, useState } from 'react'
import { Send, Save, ClipboardList, Paperclip } from 'lucide-react'
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
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { ScrollArea } from '@renderer/components/ui/scroll-area'

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
  const hasFileUpload = useMemo(() => questions.some((q) => q.inputType === 'file_upload'), [questions])
  const [answers, setAnswers] = useState<Record<string, FormAnswerValue>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [lastAutosaveAtMs, setLastAutosaveAtMs] = useState<number | null>(null)
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
    setLastAutosaveAtMs(Date.now())
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
      setNotice('ตอบข้อนี้ก่อนกดส่ง')
      return
    }
    try {
      await props.onDispatchAction({
        type: 'dynamic-form.submit-item',
        submission: buildSubmission(item, value)
      })
      setNotice(`ส่งข้อ ${item.itemId} แล้ว — รอเครื่องแม่รับเข้า`)
    } catch {
      setNotice('ส่งไม่สำเร็จ — สายหลุด กดส่งใหม่หลัง reconnect')
    }
  }

  async function submitAll(): Promise<void> {
    const items = questions
      .filter((q) => answersRef.current[q.itemId] !== undefined)
      .map((q) => buildSubmission(q, answersRef.current[q.itemId]!))
    if (items.length === 0) {
      setNotice('ยังไม่มีข้อที่ตอบเลย')
      return
    }
    try {
      await props.onDispatchAction({ type: 'dynamic-form.submit-all', items })
      setNotice(`ส่งงานทั้งหมด ${items.length} ข้อแล้ว — รอเครื่องแม่รับเข้า`)
    } catch {
      setNotice('ส่งไม่สำเร็จ — สายหลุด กดส่งใหม่หลัง reconnect')
    }
  }

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <ClipboardList size={16} className="text-primary" />
        <span className="font-semibold">{view.title}</span>
        <Badge variant="secondary" className="tabular-nums">
          {questions.length} ข้อ
        </Badge>
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          onClick={() => void submitAll()}
        >
          <Send size={15} /> ส่งงานทั้งหมด
        </Button>
      </div>
      {view.instructions && (
        <p className="border-b px-4 py-2 text-[13px] whitespace-pre-wrap text-muted-foreground">
          {view.instructions}
        </p>
      )}
      {hasFileUpload && (
        <div
          title="ข้อจำกัด F-1: ท่อ LAN ยังไม่ส่งไบนารีไฟล์แนบ ระบบส่งเฉพาะชื่อไฟล์/สถานะ ครูจะเก็บไฟล์จริงผ่านช่องทางอื่นที่นัดไว้"
          className="border-b border-primary/30 bg-primary/5 px-4 py-2 text-xs"
        >
          <span className="flex items-center gap-1.5 font-medium"><Paperclip size={12} /> ข้อสอบนี้มีข้ออัปโหลดไฟล์ — ไฟล์แนบยังไม่ส่งผ่านเครือข่าย (F-1)</span>
          <span className="mt-0.5 block text-muted-foreground">
            ระบบส่งเฉพาะชื่อไฟล์/สถานะให้เครื่องแม่ ครูจะเก็บไฟล์จริงผ่านช่องทางอื่นที่นัดไว้ — อย่าเข้าใจว่าอัปโหลดแล้วไฟล์ถึงครูทันที
          </span>
        </div>
      )}
      <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-1 text-[11px] text-muted-foreground">
        <span title="draft เก็บในเครื่องทุกครั้งที่พิมพ์ + ส่ง host ทุก ≥5 วินาที (throttle) ดูยืนยันจากแถบ ack ด้านบน">
          {lastAutosaveAtMs === null
            ? 'ยังไม่มี autosave — พิมพ์คำตอบแล้วระบบจะบันทึก draft อัตโนมัติ'
            : `draft ล่าสุด ${new Date(lastAutosaveAtMs).toLocaleTimeString('th-TH')} — เก็บในเครื่องแล้ว + ส่ง host แล้ว (รอยืนยัน ack)`}
        </span>
      </div>
      {notice !== null && (
        <div className="flex items-center gap-2 border-b bg-muted/60 px-4 py-1.5 text-xs">
          <span className="flex-1">{notice}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setNotice(null)}>
            ปิด
          </Button>
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {questions.map((item, idx) => (
            <Card key={item.itemId} className="bg-muted/30">
              <CardContent className="pt-4">
                <div className="mb-2 flex items-start gap-2">
                  <Badge variant="outline" className="font-mono tabular-nums">
                    ข้อ {idx + 1}
                  </Badge>
                  <p className="flex-1 text-sm whitespace-pre-wrap">{item.prompt}</p>
                </div>
                <FormAnswerInput
                  item={item}
                  value={answers[item.itemId] ?? { kind: 'none' }}
                  onChange={(v) => setAnswer(item.itemId, v)}
                  assets={{}}
                />
                {item.inputType === 'file_upload' && (
                  <p
                    title="F-1: ท่อ LAN ยังไม่ส่งไบนารีไฟล์แนบ ระบบส่งเฉพาะชื่อไฟล์/สถานะ ไฟล์จริงครูเก็บผ่านช่องทางอื่น — กันเข้าใจผิดว่าส่งไฟล์แล้ว"
                    className="mt-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px]"
                  >
                    <b>ไฟล์แนบยังไม่ส่งผ่านเครือข่าย (F-1)</b> — ระบบบันทึกเฉพาะชื่อไฟล์/สถานะ ครูจะเก็บไฟล์ข้อนี้ด้วยช่องทางอื่นที่แจ้งไว้
                  </p>
                )}
                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void submitOne(item)}
                  >
                    <Save size={13} /> ส่งข้อนี้
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {questions.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">ฟอร์มนี้ไม่มีข้อคำถาม</p>
          )}
        </div>
      </ScrollArea>
    </Card>
  )
}

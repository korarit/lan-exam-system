import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Lock, TriangleAlert } from 'lucide-react'
import { useStudentExamStore, stashLocalAnswer } from '../store/exam-store'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent } from '@renderer/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { cn } from '@renderer/lib/utils'

/** แปลเหตุผล submit-rejected จากเครื่องแม่เป็นภาษาไทย (TC-S27) */
const SUBMIT_REJECTED_TH: Record<string, string> = {
  'cursor-mismatch': 'ข้อที่ส่งไม่ตรงกับข้อปัจจุบันของเครื่องแม่ — กด “ส่งอีกครั้ง” ได้เลย',
  'time-expired': 'หมดเวลาส่งข้อแล้ว — คำตอบอาจไม่ถูกบันทึก ให้แจ้งครูทันที',
  'bad-question': 'ข้อมูลข้อสอบไม่ถูกต้อง — ให้แจ้งครู',
  'not-started': 'การสอบยังไม่เริ่ม — รอครูกดเริ่มแล้วกด “ส่งอีกครั้ง”'
}

/**
 * Question Card (checklist 2.5.3):
 * - แสดงโจทย์ + ช่องตอบ (user-select: none บนโจทย์, ยกเว้นช่องพิมพ์)
 * - คำตอบที่พิมพ์/เลือก ถูก Autosave ทุก 5 วิ (เมื่อมีการเปลี่ยนแปลง)
 * - ปุ่มยืนยัน + Modal ยืนยันเมื่อย้อนกลับไม่ได้ + ปุ่มย้อนกลับ (โหมด allowBackNavigation)
 */
export default function QuestionRenderer(): React.JSX.Element | null {
  const question = useStudentExamStore((s) => s.question)
  const fontScale = useStudentExamStore((s) => s.fontScale)
  const setFontScale = useStudentExamStore((s) => s.setFontScale)
  const answered = useStudentExamStore((s) => s.answeredCount)
  const submitRejectedReason = useStudentExamStore((s) => s.submitRejectedReason)
  const clearSubmitRejected = useStudentExamStore((s) => s.clearSubmitRejected)
  const storeDraft = useStudentExamStore((s) => s.draft)
  const [selectedChoiceIndex, setSelectedChoiceIndex] = useState<number | null>(null)
  const [textContent, setTextContent] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const autosaveTimer = useRef<number | null>(null)
  const autosaveDirty = useRef(false)
  const lastEventDraftKey = useRef<string | null>(null)
  const questionStartMs = useRef(Date.now())
  /** คำตอบค้างส่ง autosave (question เก่ายังอยู่ใน ref นี้จนกว่าจะ flush) */
  const pendingRef = useRef<{ questionId: string; cursorIndex: number; answer: { type: 'text'; content: string } | { type: 'mcq'; choiceIndex: number } } | null>(null)
  /** ผู้สอบแตะต้องช่องคำตอบแล้ว — กัน recovery มาช้าทับงานที่พิมพ์ไว้ */
  const hasLocalEdits = useRef(false)
  /** จังหวะการพิมพ์ (IKI) สำหรับ ABNORMAL_TYPING_PATTERN (Phase 3a) */
  const typingIntervals = useRef<number[]>([])
  const lastKeydownMs = useRef<number | null>(null)
  const metricsSent = useRef(false)

  /** ยิง draft ค้างขึ้นเครื่องแม่ทันที (flush-on-submit/navigate/change/unmount — TC-S16) */
  async function flushPending(): Promise<void> {
    if (autosaveTimer.current !== null) {
      window.clearTimeout(autosaveTimer.current)
      autosaveTimer.current = null
    }
    autosaveDirty.current = false
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    try {
      await window.ztExam.autosaveDraft({
        questionId: pending.questionId,
        cursorIndex: pending.cursorIndex,
        draft: pending.answer
      })
      useStudentExamStore.getState().onLocalDraftSaved()
    } catch {
      /* สายหลุด — คำตอบยังอยู่ใน stashLocalAnswer ฝั่ง UI, กดส่งใหม่หลัง reconnect */
    }
  }
  const flushRef = useRef<() => Promise<void>>(async () => undefined)
  flushRef.current = flushPending

  // unmount → flush คำตอบค้างก่อนทิ้ง (เช่น เปลี่ยนข้อ/หมดเวลา)
  useEffect(() => {
    return () => {
      void flushRef.current()
    }
  }, [])

  // จำคำตอบล่าสุดทุกครั้งที่ผู้สอบแตะต้อง (ไม่รอ debounce — ใช้ตอน time-up auto-submit)
  function markEdited(answer: { type: 'text'; content: string } | { type: 'mcq'; choiceIndex: number }): void {
    const q = useStudentExamStore.getState().question
    if (!q) return
    hasLocalEdits.current = true
    pendingRef.current = { questionId: q.questionId, cursorIndex: q.cursorIndex, answer }
    stashLocalAnswer({ questionId: q.questionId, cursorIndex: q.cursorIndex, answer })
    scheduleAutosave()
  }

  // เคลียรคำตอบทำงานพร้อมรับข้อใหม่ — flush ของข้อเก่าก่อนทิ้ง (TC-S16)
  useEffect(() => {
    if (!question) return
    if (question.questionId !== lastEventDraftKey.current) {
      void flushPending()
      setSelectedChoiceIndex(null)
      setTextContent('')
      hasLocalEdits.current = false
      autosaveDirty.current = false
      if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current)
      autosaveTimer.current = null
      questionStartMs.current = Date.now()
      typingIntervals.current = []
      lastKeydownMs.current = null
      metricsSent.current = false
      lastEventDraftKey.current = question.questionId
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question])

  // ส่งสถิติการพิมพ์เป็นระยะ (วิเคราะห์ฝั่ง main → เตือนเครื่องแม่ถ้าพิมพ์แบบเครื่องจักร)
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (metricsSent.current || typingIntervals.current.length < 10) return
      metricsSent.current = true
      void window.ztExam.sendTypingMetrics({ intervalsMs: typingIntervals.current.slice(0, 500) })
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [])

  function trackTypingRhythm(): void {
    const now = Date.now()
    if (lastKeydownMs.current !== null) {
      const interval = now - lastKeydownMs.current
      if (interval >= 0 && interval <= 10_000) {
        typingIntervals.current.push(interval)
        if (typingIntervals.current.length > 500) typingIntervals.current.shift()
      }
    }
    lastKeydownMs.current = now
  }

  // กู้คืน Draft จากเครื่องแม่ — ฟัง store.draft โดยตรง เผื่อ exam:recovery มาช้าหลัง render
  useEffect(() => {
    if (!storeDraft || !question) return
    if (hasLocalEdits.current) return
    if (storeDraft.type === 'text') setTextContent(storeDraft.content)
    if (storeDraft.type === 'mcq') setSelectedChoiceIndex(storeDraft.choiceIndex)
  }, [question?.questionId, storeDraft])

  function currentAnswer():
    | { type: 'text'; content: string }
    | { type: 'mcq'; choiceIndex: number }
    | null {
    if (!question) return null
    if (question.type === 'mcq') {
      return selectedChoiceIndex === null ? null : { type: 'mcq', choiceIndex: selectedChoiceIndex }
    }
    return { type: 'text', content: textContent }
  }

  function scheduleAutosave(): void {
    autosaveDirty.current = true
    if (autosaveTimer.current !== null) return
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = null
      if (!autosaveDirty.current || !question) return
      autosaveDirty.current = false
      const answer = currentAnswer()
      if (!answer) return
      void window.ztExam
        .autosaveDraft({ questionId: question.questionId, cursorIndex: question.cursorIndex, draft: answer })
        .then(() => useStudentExamStore.getState().onLocalDraftSaved())
    }, 5000)
  }

  if (!question) return null
  const promptScale = `${Math.round(17 * fontScale)}px`
  const choiceScale = `${Math.round(15 * fontScale)}px`

  async function confirmSubmit(): Promise<void> {
    const answer = currentAnswer()
    if (!question || !answer) return
    setShowConfirm(false)
    clearSubmitRejected()
    await flushPending()
    await window.ztExam.submitAnswer({
      questionId: question.questionId,
      cursorIndex: question.cursorIndex,
      answer,
      timeSpentMs: Date.now() - questionStartMs.current
    })
  }

  async function goBack(): Promise<void> {
    if (!question || question.cursorIndex === 0) return
    await flushPending()
    await window.ztExam.navigate({ cursorIndex: question.cursorIndex - 1 })
  }

  function blockClipboard(e: React.ClipboardEvent<HTMLDivElement>): void {
    e.preventDefault()
  }
  function blockDrag(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
  }

  const isBlank =
    (question.type === 'short-answer' || question.type === 'essay') && textContent.trim().length === 0
  const confirmTitle = isBlank ? 'ส่งกระดาษเปล่า?' : 'ไปข้อนี้แล้วแก้ไม่ได้'
  const confirmDescription = isBlank
    ? `ข้อ ${question.cursorIndex + 1} ยังไม่มีคำตอบ ยืนยันส่งเป็นกระดาษเปล่า?`
    : `ข้อ ${question.cursorIndex + 1} จะถูกส่งและข้ามไปข้อถัดไปทันที ย้อนกลับมาแก้ไม่ได้`

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-6 py-6">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setFontScale(fontScale - 0.1)}
            aria-label="ลดขนาดตัวอักษร"
          >
            A−
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setFontScale(fontScale + 0.1)}
            aria-label="เพิ่มขนาดตัวอักษร"
          >
            A+
          </Button>
        </div>
        <div className="ml-auto text-xs tabular-nums text-muted-foreground">
          ตอบแล้ว {answered + 1} / {question.questionCount}
        </div>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ScrollArea className="h-full flex-1">
          <CardContent
            className="select-none p-6"
            onCopy={blockClipboard}
            onCut={blockClipboard}
            onPaste={blockClipboard}
            onDragStart={blockDrag}
          >
            <div className="mb-2 text-xs text-muted-foreground">
              ข้อที่ {question.cursorIndex + 1} · {question.points} คะแนน ·{' '}
              {question.allowBackNavigation ? 'แก้กลับได้' : 'ส่งแล้วไปข้อถัดไป'}
            </div>
            <p className="whitespace-pre-line leading-relaxed" style={{ fontSize: promptScale }}>
              {question.prompt}
            </p>

            {question.type === 'mcq' && question.choices && (
              <ul className="mt-6 space-y-3">
                {question.choices.map((choice, index) => (
                  <li key={index}>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setSelectedChoiceIndex(index)
                        markEdited({ type: 'mcq', choiceIndex: index })
                      }}
                      className={cn(
                        'h-auto w-full justify-start whitespace-normal px-4 py-3 text-left',
                        selectedChoiceIndex === index && 'border-primary bg-primary/10 hover:bg-primary/15'
                      )}
                      style={{ fontSize: choiceScale }}
                    >
                      <span
                        className={cn(
                          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs',
                          selectedChoiceIndex === index
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border text-muted-foreground'
                        )}
                      >
                        {String.fromCharCode(65 + index)}
                      </span>
                      <span className="whitespace-pre-line">{choice.text}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {question.type === 'short-answer' && (
              <Input
                value={textContent}
                onChange={(e) => {
                  setTextContent(e.target.value)
                  markEdited({ type: 'text', content: e.target.value })
                }}
                onKeyDown={trackTypingRhythm}
                placeholder="พิมพ์คำตอบสั้น"
                className="mt-6"
                style={{ fontSize: choiceScale }}
              />
            )}

            {question.type === 'essay' && (
              <textarea
                value={textContent}
                onChange={(e) => {
                  setTextContent(e.target.value)
                  markEdited({ type: 'text', content: e.target.value })
                }}
                onKeyDown={trackTypingRhythm}
                placeholder="พิมพ์คำตอบอัตนัย…"
                rows={10}
                className="mt-6 flex min-h-36 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                style={{ fontSize: choiceScale }}
              />
            )}
          </CardContent>
        </ScrollArea>
      </Card>

      <div className="mt-4 flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          disabled={!question.allowBackNavigation || question.cursorIndex === 0}
          onClick={() => void goBack()}
        >
          <ArrowLeft /> ย้อนกลับ
        </Button>

        <Button
          type="button"
          className="ml-auto"
          disabled={question.type === 'mcq' && selectedChoiceIndex === null}
          onClick={() => {
            const blank =
              (question.type === 'short-answer' || question.type === 'essay') &&
              textContent.trim().length === 0
            if (!question.allowBackNavigation || blank) {
              setShowConfirm(true)
              return
            }
            void confirmSubmit()
          }}
        >
          <Check /> ยืนยันคำตอบและไปข้อถัดไป
        </Button>
      </div>

      {/* TC-S27: แสดงเหตุผลที่เครื่องแม่ปฏิเสธ + ปุ่มส่งอีกครั้ง */}
      {submitRejectedReason && (
        <Card className="mt-3 border-destructive/60">
          <CardContent className="flex flex-col gap-2 p-4 text-sm">
            <div className="flex items-start gap-2 text-destructive">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" />
              <span>ส่งคำตอบไม่สำเร็จ: {SUBMIT_REJECTED_TH[submitRejectedReason] ?? submitRejectedReason}</span>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={question.type === 'mcq' && selectedChoiceIndex === null}
                onClick={() => void confirmSubmit()}
              >
                ส่งอีกครั้ง
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => clearSubmitRejected()}>
                ปิด
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {isBlank ? <TriangleAlert size={18} /> : <Lock size={18} />}
              {confirmTitle}
            </DialogTitle>
            <DialogDescription>{confirmDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowConfirm(false)}>
              ยกเลิก
            </Button>
            <Button type="button" onClick={() => void confirmSubmit()}>
              ยืนยันและไปข้อถัดไป
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

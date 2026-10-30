import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Lock, Type, TriangleAlert } from 'lucide-react'
import { useStudentExamStore, stashLocalAnswer } from '../store/exam-store'

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

  return (
    <div className="relative mx-auto flex h-full w-full max-w-3xl flex-col px-6 py-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Type size={14} />
          <button type="button" onClick={() => setFontScale(fontScale - 0.1)} className="rounded border border-slate-700 px-2 py-0.5 hover:bg-slate-800">A−</button>
          <button type="button" onClick={() => setFontScale(fontScale + 0.1)} className="rounded border border-slate-700 px-2 py-0.5 hover:bg-slate-800">A+</button>
        </div>
        <div className="ml-auto text-xs text-slate-500">
          ตอบแล้ว {answered + 1} / {question.questionCount}
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900/70 p-6 select-none"
        onCopy={blockClipboard}
        onCut={blockClipboard}
        onPaste={blockClipboard}
        onDragStart={blockDrag}
      >
        <div className="mb-2 text-xs text-slate-500">
          ข้อที่ {question.cursorIndex + 1} · {question.points} คะแนน ·{' '}
          {question.allowBackNavigation ? 'แก้กลับได้' : 'ส่งแล้วไปข้อถัดไป'}
        </div>
        <p className="whitespace-pre-line leading-relaxed text-slate-100" style={{ fontSize: promptScale }}>
          {question.prompt}
        </p>

        {question.type === 'mcq' && question.choices && (
          <ul className="mt-6 space-y-3">
            {question.choices.map((choice, index) => (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedChoiceIndex(index)
                    markEdited({ type: 'mcq', choiceIndex: index })
                  }}
                  className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${
                    selectedChoiceIndex === index
                      ? 'border-sky-500 bg-sky-950/40'
                      : 'border-slate-700 bg-slate-950/60 hover:border-slate-500'
                  }`}
                  style={{ fontSize: choiceScale }}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                      selectedChoiceIndex === index
                        ? 'border-sky-400 bg-sky-500 text-white'
                        : 'border-slate-600 text-slate-400'
                    }`}
                  >
                    {String.fromCharCode(65 + index)}
                  </span>
                  <span className="whitespace-pre-line">{choice.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {question.type === 'short-answer' && (
          <input
            value={textContent}
            onChange={(e) => {
              setTextContent(e.target.value)
              markEdited({ type: 'text', content: e.target.value })
            }}
            onKeyDown={trackTypingRhythm}
            placeholder="พิมพ์คำตอบสั้น"
            className="mt-6 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 focus:border-sky-500 focus:outline-none"
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
            className="mt-6 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 focus:border-sky-500 focus:outline-none"
            style={{ fontSize: choiceScale }}
          />
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={!question.allowBackNavigation || question.cursorIndex === 0}
          onClick={() => void goBack()}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-300 transition hover:bg-slate-800 disabled:opacity-30"
        >
          <ArrowLeft size={16} /> ย้อนกลับ
        </button>

        <button
          type="button"
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
          className="ml-auto inline-flex items-center gap-2 rounded-xl bg-sky-600 px-5 py-2.5 font-semibold text-white transition hover:bg-sky-500 disabled:opacity-30"
        >
          <Check size={16} /> ยืนยันคำตอบและไปข้อถัดไป
        </button>
      </div>

      {/* TC-S27: แสดงเหตุผลที่เครื่องแม่ปฏิเสธ + ปุ่มส่งอีกครั้ง */}
      {submitRejectedReason && (
        <div className="mt-3 rounded-xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm">
          <div className="flex items-start gap-2 text-red-200">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" />
            <span>ส่งคำตอบไม่สำเร็จ: {SUBMIT_REJECTED_TH[submitRejectedReason] ?? submitRejectedReason}</span>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={question.type === 'mcq' && selectedChoiceIndex === null}
              onClick={() => void confirmSubmit()}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-500 disabled:opacity-40"
            >
              ส่งอีกครั้ง
            </button>
            <button
              type="button"
              onClick={() => clearSubmitRejected()}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800"
            >
              ปิด
            </button>
          </div>
        </div>
      )}

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-6">
            <div className="mb-3 flex items-center gap-2 font-semibold text-amber-300">
              {(question.type === 'short-answer' || question.type === 'essay') && textContent.trim().length === 0 ? (
                <><TriangleAlert size={18} /> ส่งกระดาษเปล่า?</>
              ) : (
                <><Lock size={18} /> ไปข้อนี้แล้วแก้ไม่ได้</>
              )}
            </div>
            <p className="text-sm text-slate-400">
              {(question.type === 'short-answer' || question.type === 'essay') && textContent.trim().length === 0
                ? `ข้อ ${question.cursorIndex + 1} ยังไม่มีคำตอบ ยืนยันส่งเป็นกระดาษเปล่า?`
                : `ข้อ ${question.cursorIndex + 1} จะถูกส่งและข้ามไปข้อถัดไปทันที ย้อนกลับมาแก้ไม่ได้`}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => void confirmSubmit()}
                className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-500"
              >
                ยืนยันและไปข้อถัดไป
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

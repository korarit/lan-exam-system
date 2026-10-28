import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Lock, Type } from 'lucide-react'
import { useStudentExamStore } from '../store/exam-store'

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
  const [selectedChoiceIndex, setSelectedChoiceIndex] = useState<number | null>(null)
  const [textContent, setTextContent] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const autosaveTimer = useRef<number | null>(null)
  const autosaveDirty = useRef(false)
  const lastEventDraftKey = useRef<string | null>(null)
  const questionStartMs = useRef(Date.now())
  /** จังหวะการพิมพ์ (IKI) สำหรับ ABNORMAL_TYPING_PATTERN (Phase 3a) */
  const typingIntervals = useRef<number[]>([])
  const lastKeydownMs = useRef<number | null>(null)
  const metricsSent = useRef(false)

  // เคลียรคำตอบทำงานพร้อมรับข้อใหม่ (draft จาก server กู้คืน)
  useEffect(() => {
    if (!question) return
    if (question.questionId !== lastEventDraftKey.current) {
      setSelectedChoiceIndex(null)
      setTextContent('')
      autosaveDirty.current = false
      if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current)
      autosaveTimer.current = null
      questionStartMs.current = Date.now()
      typingIntervals.current = []
      lastKeydownMs.current = null
      metricsSent.current = false
    }
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

  // กู้คืน Draft จากเครื่องแม่หลัง reconnect
  useEffect(() => {
    const draft = useStudentExamStore.getState().draft
    if (!draft || !question) return
    if (draft.type === 'text') setTextContent(draft.content)
    if (draft.type === 'mcq') setSelectedChoiceIndex(draft.choiceIndex)
  }, [question?.questionId])

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
    await window.ztExam.submitAnswer({
      questionId: question.questionId,
      cursorIndex: question.cursorIndex,
      answer,
      timeSpentMs: Date.now() - questionStartMs.current
    })
  }

  async function goBack(): Promise<void> {
    if (!question || question.cursorIndex === 0) return
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
                    scheduleAutosave()
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
              scheduleAutosave()
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
              scheduleAutosave()
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
          disabled={question.type !== 'essay' && question.type !== 'short-answer' && selectedChoiceIndex === null}
          onClick={() => {
            if (!question.allowBackNavigation) {
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

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-6">
            <div className="mb-3 flex items-center gap-2 font-semibold text-amber-300">
              <Lock size={18} /> ไปข้อนี้แล้วแก้ไม่ได้
            </div>
            <p className="text-sm text-slate-400">
              ข้อ {question.cursorIndex + 1} จะถูกส่งและข้ามไปข้อถัดไปทันที ย้อนกลับมาแก้ไม่ได้
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

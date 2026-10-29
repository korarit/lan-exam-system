import { useEffect } from 'react'
import { CircleCheck, CloudOff } from 'lucide-react'
import WatermarkOverlay from './WatermarkOverlay'
import HudBar from './HudBar'
import QuestionRenderer from './QuestionRenderer'
import DocsPanel from './DocsPanel'
import { useStudentExamStore } from '../store/exam-store'
import { useStudentNetworkStore } from '../store/network-store'
import { useDocsStore } from '../store/docs-store'
import { CODE_IDE_RENDERER_UI } from '@modules/code-ide/renderer/index'
import { DYNAMIC_FORM_RENDERER_UI } from '@modules/dynamic-form/renderer/index'

let subscribed = false

/** ฉบับร่างล่าสุดของแต่ละ module (กัน time-up มาก่อน autosave รอบถัดไป) */
const lastModuleDrafts = new Map<string, unknown>()

function stashModuleDraft(moduleId: string, draft: unknown): void {
  lastModuleDrafts.set(moduleId, draft)
}

/** หมดเวลา: ยิง draft ล่าสุดของทุก module ขึ้นเครื่องแม่ครั้งสุดท้าย (F-2) */
async function flushModuleDrafts(): Promise<void> {
  const jobs: Array<{ moduleId: 'code-ide' | 'dynamic-form'; kind: 'action' | 'autosave'; payloadJson: string }> = []
  for (const [moduleId, draft] of lastModuleDrafts) {
    try {
      if (moduleId === 'code-ide') {
        jobs.push({ moduleId, kind: 'autosave', payloadJson: JSON.stringify(draft) })
      } else if (moduleId === 'dynamic-form') {
        const items =
          typeof draft === 'object' && draft !== null && 'items' in draft
            ? (draft as { items: unknown }).items
            : null
        if (!Array.isArray(items) || items.length === 0) continue
        jobs.push({
          moduleId,
          kind: 'action',
          payloadJson: JSON.stringify({ type: 'dynamic-form.submit-all', items })
        })
      }
    } catch {
      /* draft แปลงไม่ได้ — ข้าม */
    }
  }
  lastModuleDrafts.clear()
  for (const job of jobs) {
    try {
      await window.ztExam.moduleSend(job)
    } catch {
      /* สายหลุดระหว่าง flush — host finalize จะเลื่อน draft เดิมใน DB ให้ */
    }
  }
}

/** subscribe exam events ครั้งเดียวระดับโมดูล (กัน duplicate ตอน React strict) */
function useExamEventSubscription(): void {
  useEffect(() => {
    function subscribeExam(): () => void {
      const unsubs = [
        window.ztExam.onEvent('exam:started', (payload) =>
          useStudentExamStore.getState().onExamStarted(payload)
        ),
        window.ztExam.onEvent('exam:question', (payload) =>
          useStudentExamStore.getState().onQuestion(payload)
        ),
        window.ztExam.onEvent('exam:recovery', (payload) =>
          useStudentExamStore.getState().onRecovery(payload)
        ),
        window.ztExam.onEvent('exam:tick', (payload) =>
          useStudentExamStore.getState().onTick(payload)
        ),
        window.ztExam.onEvent('exam:submit-rejected', (payload) =>
          useStudentExamStore.getState().onSubmitRejected(payload)
        ),
        window.ztExam.onEvent('exam:module-state', (payload) =>
          useStudentExamStore.getState().onModuleState(payload)
        ),
        window.ztExam.onEvent('exam:module-ack', (payload) =>
          useStudentExamStore.getState().onModuleAck(payload)
        ),
        window.ztExam.onEvent('exam:time-up', () => useStudentExamStore.getState().onTimeUp()),
        window.ztExam.onEvent('exam:completed', (payload) => {
          useStudentExamStore.getState().onCompleted(payload)
          useDocsStore.getState().reset()
        }),
        window.ztExam.onEvent('exam:time-up', () => useDocsStore.getState().reset()),
        // Phase 5: สถานะแผงเอกสาร (Mode 2) จาก main process
        window.ztExam.onEvent('exam:docs-state', (payload) =>
          useDocsStore.getState().setDocs(payload)
        )
      ]
      return () => unsubs.forEach((u) => u())
    }
    if (subscribed) return
    subscribed = true
    subscribeExam()
  }, [])
}

function CodeIdeExamSlot(props: { studentId: string }): React.JSX.Element {
  const moduleState = useStudentExamStore((s) => s.moduleStates['code-ide'])
  if (moduleState === undefined || moduleState === null) return <></>
  const { StudentExamWorkspace } = CODE_IDE_RENDERER_UI
  return (
    <StudentExamWorkspace
      moduleState={moduleState}
      studentId={props.studentId}
      onDispatchAction={async (action) => {
        try {
          await window.ztExam.moduleSend({
            moduleId: 'code-ide',
            kind: 'action',
            payloadJson: JSON.stringify(action)
          })
        } catch {
          /* สายหลุด — autosave ในโฟลเดอร์นักเรียนยังอยู่, กดส่งใหม่หลัง reconnect */
        }
      }}
      onAutosaveDraft={(draft) => {
        stashModuleDraft('code-ide', draft)
        void window.ztExam
          .moduleSend({ moduleId: 'code-ide', kind: 'autosave', payloadJson: JSON.stringify(draft) })
          .catch(() => undefined)
      }}
    />
  )
}

function DynamicFormExamSlot(props: { studentId: string }): React.JSX.Element {
  const moduleState = useStudentExamStore((s) => s.moduleStates['dynamic-form'])
  if (moduleState === undefined || moduleState === null) return <></>
  const { StudentExamWorkspace } = DYNAMIC_FORM_RENDERER_UI
  return (
    <StudentExamWorkspace
      moduleState={moduleState}
      studentId={props.studentId}
      onDispatchAction={async (action) => {
        try {
          await window.ztExam.moduleSend({
            moduleId: 'dynamic-form',
            kind: 'action',
            payloadJson: JSON.stringify(action)
          })
        } catch {
          /* สายหลุด — draft ล่าสุดยังอยู่ฝั่งนักเรียน, กดส่งใหม่หลัง reconnect */
        }
      }}
      onAutosaveDraft={(draft) => {
        stashModuleDraft('dynamic-form', draft)
        void window.ztExam
          .moduleSend({ moduleId: 'dynamic-form', kind: 'autosave', payloadJson: JSON.stringify(draft) })
          .catch(() => undefined)
      }}
    />
  )
}

function ModuleAckBanner(): React.JSX.Element | null {
  const ack = useStudentExamStore((s) => s.lastModuleAck)
  if (!ack || Date.now() - ack.atMs > 10000) return null
  return (
    <div className={`border-b px-4 py-1.5 text-center text-xs ${ack.ok ? 'border-emerald-800/60 bg-emerald-950/40 text-emerald-200' : 'border-red-800/60 bg-red-950/40 text-red-200'}`}>
      {ack.ok ? `✅ เครื่องแม่รับงานแล้ว (${ack.progressText ?? ack.kind})` : `⛔ เครื่องแม่ปฏิเสธงาน: ${ack.reason ?? 'unknown'}`}
    </div>
  )
}

export default function ExamView(): React.JSX.Element | null {
  const phase = useStudentExamStore((s) => s.phase)
  const identity = useStudentExamStore((s) => s.identity)
  const examMode = useStudentExamStore((s) => s.examMode)
  const connection = useStudentNetworkStore((s) => s.connection)
  const remaining = useStudentExamStore((s) => s.remainingSeconds)
  const finishReason = useStudentExamStore((s) => s.finishReason)
  const hasCodeIdeModule = useStudentExamStore((s) => s.moduleStates['code-ide'] !== undefined && s.moduleStates['code-ide'] !== null)
  const hasFormModule = useStudentExamStore((s) => s.moduleStates['dynamic-form'] !== undefined && s.moduleStates['dynamic-form'] !== null)
  useExamEventSubscription()

  // เข้าโหมด kiosk ทันทีที่เริ่ม/กู้คืนการสอบ (main process ล็อกจอระดับ OS)
  useEffect(() => {
    if (phase === 'active') {
      void window.ztExam.enterKiosk()
    }
  }, [phase])

  // Mode 2: เปิดแผงเอกสารอัตโนมัติเมื่อเริ่มการสอบ (Modal 2 auto-open)
  useEffect(() => {
    if (phase !== 'active' || examMode !== 'in-app-docs') return
    if (useDocsStore.getState().docs === null) {
      void window.ztExam.docsToggle({ open: true })
    }
  }, [phase, examMode])

  // หมดเวลา → ยื่น final draft ที่กำลังพิมพ์ค้างไว้ภายใน grace period
  useEffect(() => {
    if (phase !== 'timeup') return
    const store = useStudentExamStore.getState()
    const question = store.question
    if (question) {
      void window.ztExam.submitAnswer({
        questionId: question.questionId,
        cursorIndex: question.cursorIndex,
        answer: { type: 'text', content: store.draft?.type === 'text' ? store.draft.content : '' },
        timeSpentMs: 0
      })
    }
    // F-2: ยิง draft ล่าสุดของทุก module (code-ide/dynamic-form) ขึ้นเครื่องแม่ครั้งสุดท้าย
    void flushModuleDrafts()
  }, [phase])

  if (phase === 'idle' || phase === 'waiting' || !identity) return null

  if (phase === 'completed') {
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-slate-950">
        <WatermarkOverlay
          studentId={identity.studentId}
          studentName={identity.studentName}
          deviceLabel={navigator.platform || 'desktop'}
        />
        <CircleCheck size={56} className="mb-4 text-emerald-400" />
        <h2 className="text-xl font-semibold text-emerald-200">
          การสอบเสร็จสมบูรณ์{' '}
          {finishReason === 'time-up' ? '(หมดเวลา)' : finishReason === 'completed' ? '(ทำครบทุกข้อ)' : '(จบตามคำสั่งครู)'}
        </h2>
        <p className="mt-2 text-sm text-slate-400">โปรดแจ้งครูก่อนออกจากเครื่อง</p>
      </div>
    )
  }

  const frozen = connection.state === 'frozen' || connection.state === 'reconnecting'
  const timeup = phase === 'timeup'

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-slate-950">
      {/* Dynamic watermark ระบุตัวตนรายแอป */}
      <WatermarkOverlay
        studentId={identity.studentId}
        studentName={identity.studentName}
        deviceLabel={navigator.platform || 'desktop'}
      />

      <HudBar connectionOk={connection.state === 'ready'} />
      <ModuleAckBanner />

      {/* Fail-closed overlay: ขาดการติดต่อกับเครื่องแม่ — บังโจทย์ทั้งหมด */}
      {frozen ? (
        <div className="flex flex-1 flex-col items-center justify-center">
          <CloudOff size={48} className="mb-4 text-amber-400" />
          <h2 className="text-lg font-semibold text-amber-200">ขาดการติดต่อกับเครื่องแม่</h2>
          <p className="mt-2 max-w-md text-center text-sm text-slate-400">
            ระบบซ่อนโจทย์ชั่วคราวเพื่อความปลอดภัยของข้อสอบ รอสักครู่จะกู้คืนข้อเดิมพร้อมคำตอบที่พิมพ์ค้างไว้ให้โดยอัตโนมัติ
          </p>
        </div>
      ) : timeup ? (
        <div className="flex flex-1 flex-col items-center justify-center">
          <CloudOff size={48} className="mb-4 text-red-400" />
          <h2 className="text-lg font-semibold text-red-200">หมดเวลาสอบ</h2>
          <p className="mt-2 text-sm text-slate-400">กำลังบันทึกคำตอบล่าสุดของข้อนี้…</p>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {hasCodeIdeModule ? (
            <div className="w-full h-full overflow-hidden p-2">
              <CodeIdeExamSlot studentId={identity.studentId} />
            </div>
          ) : hasFormModule ? (
            <div className="w-full h-full overflow-hidden p-2">
              <DynamicFormExamSlot studentId={identity.studentId} />
            </div>
          ) : examMode === 'in-app-docs' ? (
            <>
              <div className="w-1/2 h-full overflow-hidden">
                <QuestionRenderer />
              </div>
              <div className="w-1/2 h-full overflow-hidden border-l border-slate-800">
                <DocsPanel />
              </div>
            </>
          ) : (
            <div className="w-full h-full overflow-hidden">
              <QuestionRenderer />
            </div>
          )}
        </div>
      )}

      {/* แถบนับถอยหลังสแตนดี้ บนจอ (สีเปลี่ยนเมื่อเวลาจะหมด) */}
      {remaining <= 0 && !frozen && !timeup && (
        <div className="border-t border-amber-800/60 bg-amber-950/40 px-4 py-2 text-center text-xs text-amber-200">
          รอข้อมูลเวลาจากเครื่องแม่…
        </div>
      )}
    </div>
  )
}

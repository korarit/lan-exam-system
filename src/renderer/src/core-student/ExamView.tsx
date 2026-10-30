import { useEffect } from 'react'
import { CircleCheck, CloudOff } from 'lucide-react'
import WatermarkOverlay from './WatermarkOverlay'
import HudBar from './HudBar'
import QuestionRenderer from './QuestionRenderer'
import DocsPanel from './DocsPanel'
import { useStudentExamStore, peekLocalAnswer } from '../store/exam-store'
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

/** หมดเวลา: ยิง draft ล่าสุดของทุก module ขึ้นเครื่องแม่ครั้งสุดท้าย (F-2) — คง local draft ไว้ถ้าส่งไม่สำเร็จ */
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
  let okCount = 0
  const failed: string[] = []
  for (const job of jobs) {
    try {
      await window.ztExam.moduleSend(job)
      okCount += 1
      // ส่งสำเร็จค่อยลบ draft นั้น — กัน draft หายทั้งที่ host ยังไม่รับ
      lastModuleDrafts.delete(job.moduleId)
    } catch {
      failed.push(job.moduleId)
      /* สายหลุดระหว่าง flush — คง draft ไว้ใน Map + host finalize จะเลื่อน draft เดิมใน DB ให้ */
    }
  }
  try {
    const store = useStudentExamStore.getState()
    if (jobs.length === 0) {
      store.onModuleFlushDone('หมดเวลา: ไม่มี draft ค้าง — ไม่ต้อง flush')
    } else if (failed.length === 0) {
      store.onModuleFlushDone(`หมดเวลา: flush สำเร็จ ${okCount} module แล้ว (host รับแล้ว)`)
    } else {
      store.onModuleFlushDone(
        `หมดเวลา: flush ได้ ${okCount}/${jobs.length} — ค้าง ${failed.join(', ')} (เน็ตหลุด? draft ยังเก็บในเครื่อง กดส่งใหม่หลัง reconnect)`
      )
    }
  } catch {
    /* store ยังไม่พร้อม — ข้าม */
  }
}

/** subscribe exam events ครั้งเดียวระดับโมดูล (กัน duplicate ตอน React strict) */
function useExamEventSubscription(): void {
  useEffect(() => {
    function subscribeExam(): () => void {
      const unsubs = [        window.ztExam.onEvent('exam:started', (payload) =>
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
    const cleanup = subscribeExam()
    return () => {
      cleanup()
      subscribed = false
    }
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
        try { useStudentExamStore.getState().onModuleDraftStashed('code-ide') } catch { /* noop */ }
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
        try { useStudentExamStore.getState().onModuleDraftStashed('dynamic-form') } catch { /* noop */ }
        void window.ztExam
          .moduleSend({ moduleId: 'dynamic-form', kind: 'autosave', payloadJson: JSON.stringify(draft) })
          .catch(() => undefined)
      }}
    />
  )
}

/** แปลเหตุผล module-ack ที่ถูกปฏิเสธเป็นไทย (NC-12 ส่วน module — เดิมโชว์ reason ดิบ) */
const MODULE_ACK_REJECT_TH: Record<string, string> = {
  ROOM_NOT_OPEN: 'ห้องยังไม่เปิด — รอครูเปิดห้องแล้วกดส่งใหม่',
  HANDLER_FAILED: 'เครื่องแม่ประมวลผลไม่สำเร็จ — กดส่งใหม่อีกครั้ง ถ้ายังไม่ได้ให้แจ้งครู',
  EXAM_NOT_RUNNING: 'การสอบยังไม่เริ่ม/จบแล้ว — รอครูแล้วกดส่งใหม่',
  TRANSFER_MISMATCH: 'ข้อมูลส่งไม่ครบ — กดส่งใหม่อีกครั้ง'
}

function ModuleAckBanner(): React.JSX.Element | null {
  const ack = useStudentExamStore((s) => s.lastModuleAck)
  const draftAtMs = useStudentExamStore((s) => s.lastModuleDraftAtMs)
  const draftModuleId = useStudentExamStore((s) => s.lastModuleDraftModuleId)
  const flushAtMs = useStudentExamStore((s) => s.lastModuleFlushAtMs)
  const flushNote = useStudentExamStore((s) => s.lastModuleFlushNote)
  const connection = useStudentNetworkStore((s) => s.connection)
  const offline = connection.state === 'frozen' || connection.state === 'reconnecting' || connection.state === 'closed'
  if (!ack && draftAtMs === null && flushNote === null) return null
  const fresh = ack !== null && Date.now() - ack.atMs <= 10000
  const reasonTh = ack !== null && !ack.ok && ack.reason ? (MODULE_ACK_REJECT_TH[ack.reason] ?? `${ack.reason} — กดส่งใหม่อีกครั้ง ถ้ายังไม่ได้ให้แจ้งครู`) : ack?.reason
  const ackText =
    ack === null
      ? null
      : ack.ok
        ? `✅ เครื่องแม่รับงานแล้ว (${ack.progressText ?? ack.kind})`
        : `⛔ เครื่องแม่ปฏิเสธงาน: ${reasonTh}`
  const draftText =
    draftAtMs !== null
      ? `📝 draft ล่าสุด [${draftModuleId ?? '?'}] ${new Date(draftAtMs).toLocaleTimeString('th-TH')} — เก็บในเครื่องแล้ว + ส่ง host แล้ว (รอยืนยัน ack)`
      : null
  return (
    <div
      title="แถบนี้ไม่หายไปเอง — ack ใหม่จะขึ้นสีเข้ม 10 วินาทีแรก แล้วค้างเป็นสถานะจางๆ ต่อ เน็ตหลุดให้ดูบรรทัด draft/flush ว่าส่งถึง host หรือยัง"
      className={`border-b px-4 py-1.5 text-center text-xs ${ack && !ack.ok ? 'border-red-800/60 bg-red-950/40 text-red-200' : fresh ? 'border-emerald-800/60 bg-emerald-950/40 text-emerald-200' : 'border-slate-800 bg-slate-900/60 text-slate-400'}`}
    >
      <div>{fresh ? ackText : ackText !== null ? `ล่าสุด: ${ackText} (${ack !== null ? new Date(ack.atMs).toLocaleTimeString('th-TH') : ''})` : 'ยังไม่มี ack จากเครื่องแม่'}</div>
      {draftText !== null && <div className="mt-0.5 opacity-90">{draftText}</div>}
      {flushNote !== null && flushAtMs !== null && (
        <div className="mt-0.5 opacity-90">⏱ flush: {flushNote}</div>
      )}
      {offline && (
        <div className="mt-0.5 font-semibold text-amber-200">⚠️ เน็ตหลุด — draft ยังอยู่ในเครื่อง ไม่หาย กดส่งใหม่หลัง reconnect แล้วดู ack ยืนยันอีกครั้ง</div>
      )}
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
  // R5: รู้สถานะแผงเอกสาร — ถ้านักเรียนปิดเองให้โจทย์ขยายเต็มจอ (ไม่เหลือครึ่งขวาว่าง)
  const docsPanel = useDocsStore((s) => s.docs)
  useExamEventSubscription()

  // เข้าโหมด kiosk ทันทีที่เริ่ม/กู้คืนการสอบ (main process ล็อกจอระดับ OS)
  useEffect(() => {
    if (phase === 'active') {
      void window.ztExam.enterKiosk()
    }
  }, [phase])

  // ออกจาก kiosk เมื่อสอบจบ/ห้องปิด/unmount (TC-S12/TC-S23)
  useEffect(() => {
    if (phase === 'completed') {
      void window.ztExam.exitKiosk().catch(() => undefined)
    }
  }, [phase])

  useEffect(() => {
    if (connection.state === 'closed') {
      void window.ztExam.exitKiosk().catch(() => undefined)
    }
  }, [connection.state])

  useEffect(() => {
    return () => {
      void window.ztExam.exitKiosk().catch(() => undefined)
    }
  }, [])

  // Mode 2: เปิดแผงเอกสารอัตโนมัติเมื่อเริ่มการสอบ (Modal 2 auto-open)
  useEffect(() => {
    if (phase !== 'active' || examMode !== 'in-app-docs') return
    if (useDocsStore.getState().docs === null) {
      void window.ztExam.docsToggle({ open: true })
    }
  }, [phase, examMode])

  // หมดเวลา → ยื่น final draft ที่กำลังพิมพ์ค้างไว้ภายใน grace period
  // (TC-S22: ส่งตาม type จริง — MCQ ส่ง choiceIndex, text ส่ง content; ไม่มี draft ค่อยส่งว่าง)
  useEffect(() => {
    if (phase !== 'timeup') return
    const store = useStudentExamStore.getState()
    const question = store.question
    if (question) {
      const local = peekLocalAnswer()
      const draft =
        local && local.questionId === question.questionId ? local.answer : store.draft
      const answer =
        draft?.type === 'mcq'
          ? { type: 'mcq' as const, choiceIndex: draft.choiceIndex }
          : draft?.type === 'text'
            ? { type: 'text' as const, content: draft.content }
            : { type: 'text' as const, content: '' }
      void window.ztExam.submitAnswer({
        questionId: question.questionId,
        cursorIndex: question.cursorIndex,
        answer,
        timeSpentMs: 0
      })
    }
    // F-2: ยิง draft ล่าสุดของทุก module (code-ide/dynamic-form) ขึ้นเครื่องแม่ครั้งสุดท้าย
    void flushModuleDrafts()
  }, [phase])

  if (phase === 'idle' || phase === 'waiting' || !identity) return null

  async function backToLobby(leave: boolean): Promise<void> {
    if (leave) {
      try {
        await window.ztExam.leaveRoom()
      } catch {
        /* สายหลุดแล้ว — กลับหน้าแรกในเครื่องได้เลย */
      }
    }
    useStudentExamStore.getState().reset()
    useDocsStore.getState().reset()
    try {
      await window.ztExam.exitKiosk()
    } catch {
      /* ไม่ใช่โหมด kiosk — ข้าม */
    }
  }

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
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void backToLobby(false)}
            className="rounded-xl border border-slate-700 px-5 py-2.5 text-sm text-slate-200 transition hover:bg-slate-800"
          >
            กลับหน้าแรก
          </button>
          <button
            type="button"
            onClick={() => void backToLobby(true)}
            className="rounded-xl bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500"
          >
            ออกจากห้องสอบ
          </button>
        </div>
      </div>
    )
  }

  const frozen = connection.state === 'frozen' || connection.state === 'reconnecting'
  const closedRoom = connection.state === 'closed'
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

      {/* Fail-closed overlay: ชั้นเดียวตอนสอบ (NC-06/10 — StudentPanel ซ่อนชั้นของตัวเองเมื่อ phase active/timeup) */}
      {closedRoom ? (
        <div className="flex flex-1 flex-col items-center justify-center">
          <CloudOff size={48} className="mb-4 text-slate-400" />
          <h2 className="text-lg font-semibold text-slate-200">ห้องปิดแล้ว</h2>
          <p className="mt-2 max-w-md text-center text-sm text-slate-400">
            ครูปิดห้องสอบแล้ว — คำตอบที่ส่งไปแล้วยังอยู่ แจ้งครูให้เปิดห้องใหม่ แล้วกลับหน้าแรกเพื่อเข้าห้องอีกครั้ง
          </p>
          <button
            type="button"
            onClick={() => void backToLobby(false)}
            className="mt-4 rounded-xl border border-slate-700 px-5 py-2.5 text-sm text-slate-200 transition hover:bg-slate-800"
          >
            กลับหน้าแรก
          </button>
        </div>
      ) : frozen ? (
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
            docsPanel !== null && !docsPanel.open ? (
              /* R5: แผงเอกสารถูกปิดอยู่ — โจทย์ขยายเต็มจอชัดเจน + แถบบอกวิธิเปิดกลับ */
              <div className="w-full h-full overflow-hidden flex flex-col">
                <div className="flex items-center gap-2 border-b border-amber-800/60 bg-amber-950/40 px-4 py-1.5 text-xs text-amber-200">
                  <span className="flex-1">แผงเอกสารถูกปิดอยู่ — โจทย์ขยายเต็มจอแล้ว (การปิดถูกบันทึกแจ้งครู)</span>
                  <button
                    type="button"
                    onClick={() => void window.ztExam.docsToggle({ open: true })}
                    className="shrink-0 rounded-lg border border-amber-700/60 px-2.5 py-1 text-xs text-amber-100 transition hover:bg-amber-900/60"
                  >
                    เปิดเอกสารอีกครั้ง
                  </button>
                </div>
                <div className="flex-1 overflow-hidden">
                  <QuestionRenderer />
                </div>
              </div>
            ) : (
              <>
                <div className="w-1/2 h-full overflow-hidden">
                  <QuestionRenderer />
                </div>
                <div className="w-1/2 h-full overflow-hidden border-l border-slate-800">
                  <DocsPanel />
                </div>
              </>
            )
          ) : (
            <div className="w-full h-full overflow-hidden">
              <QuestionRenderer />
            </div>
          )}
        </div>
      )}

      {/* แถบนับถอยหลังสแตนดี้ บนจอ (สีเปลี่ยนเมื่อเวลาจะหมด) */}
      {remaining <= 0 && !frozen && !timeup && !closedRoom && (
        <div className="border-t border-amber-800/60 bg-amber-950/40 px-4 py-2 text-center text-xs text-amber-200">
          รอข้อมูลเวลาจากเครื่องแม่…
        </div>
      )}
    </div>
  )
}

import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { CoreSessionManager } from '../host/core-session-manager'
import type { ExamTlsClient } from '../network/tls-client'
import type { KioskEnterResponse, StudentSubmitResponse } from '@shared/ipc-channels'
import type { SignedDetectionPolicy } from '@shared/policy-schema'
import { NetMsgType } from '@shared/protocol-schema'
import { dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { enterKioskMode, exitKioskMode } from '../window'
import type { GuardEngine } from '../guard/guard-engine'

const EXAM_FILTERS = [
  { name: 'แพ็กเกจข้อสอบ (JSON)', extensions: ['json', 'ztexam'] }
]

export interface ExamServices {
  getSessionManager(): CoreSessionManager
  getStudentClient(): ExamTlsClient
  /** GuardEngine ฝั่งนักเรียน (null บนเครื่องแม่) */
  getGuardEngine(): GuardEngine | null
  /** เข้า/ออกโหมด kiosk ของหน้าต่างนักเรียน */
  enterKiosk(): void
  exitKiosk(): void
}

/**
 * IPC ของ Exam Core (Phase 2):
 * - ฝั่ง host: โหลดแพ็กเกจข้อสอบ เริ่ม/จบการสอบ
 * - ฝั่ง student: ส่งคำตอบ/draft/navigate (จาก renderer → เครื่องแม่ผ่าน TLS)
 */
export function registerExamHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  services: ExamServices
): void {
  /* ---------- Host ---------- */

  router.register('host:load-exam', (req) => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const raw: unknown = JSON.parse(req.examJson)
    const loaded = services.getSessionManager().loadExam(raw)
    return {
      ok: true,
      title: loaded.title,
      questionCount: loaded.questions.length,
      durationSeconds: loaded.durationSeconds
    }
  })

  router.register('host:select-exam-file', async () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const picked = await dialog.showOpenDialog({
      title: 'เลือกไฟล์แพ็กเกจข้อสอบ',
      properties: ['openFile'],
      filters: EXAM_FILTERS
    })
    const filePath = picked.filePaths[0]
    if (!filePath) {
      return { ok: false, title: '', questionCount: 0, durationSeconds: 0, message: 'ยกเลิกการเลือกไฟล์' }
    }
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      const loaded = services.getSessionManager().loadExam(raw)
      return {
        ok: true,
        title: loaded.title,
        questionCount: loaded.questions.length,
        durationSeconds: loaded.durationSeconds
      }
    } catch (err) {
      return {
        ok: false,
        title: '',
        questionCount: 0,
        durationSeconds: 0,
        message: `ไฟล์ข้อสอบไม่ผ่านการตรวจ: ${path.basename(filePath)} (${err instanceof Error ? err.message.slice(0, 120) : 'unknown'})`
      }
    }
  })

  router.register('host:start-exam', async () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    await services.getSessionManager().startExam()
    return { ok: true }
  })

  router.register('host:end-exam', async () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    await services.getSessionManager().endExam('ended-by-host')
    return { ok: true }
  })

  router.register('host:get-exam-state', () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    const mgr = services.getSessionManager()
    const hostState = mgr.getExamHostState() as {
      state: 'idle' | 'running' | 'collecting' | 'finished'
      title: string | null
      questionCount: number
      examEndsAtMs: number
      serverNowMs: number
      room: string | null
    }
    return {
      ...hostState,
      durationSeconds: mgr.examInfo?.durationSeconds ?? 0
    }
  })

  router.register('host:get-summaries', () => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    return { summaries: services.getSessionManager().getHostSummaries() }
  })

  /* ---------- Student ---------- */

  router.register('student:submit-answer', (req) => {
    services.getStudentClient().sendExamMessage(NetMsgType.submitAnswer, req)
    return { ok: true }
  })

  router.register('student:autosave-draft', (req) => {
    services.getStudentClient().sendExamMessage(NetMsgType.autosaveDraft, req)
    return { ok: true }
  })

  router.register('student:navigate', (req) => {
    services.getStudentClient().sendExamMessage(NetMsgType.navigateTo, req)
    return { ok: true }
  })

  router.register('student:enter-kiosk', (): KioskEnterResponse => {
    if (state.role !== 'student') throw new Error('STUDENT_ROLE_REQUIRED')
    services.enterKiosk()
    return { ok: true }
  })

  router.register('student:exit-kiosk', (): KioskEnterResponse => {
    if (state.role !== 'student') throw new Error('STUDENT_ROLE_REQUIRED')
    services.exitKiosk()
    return { ok: true }
  })

  /* ---------- Guard (Phase 3a) ---------- */

  router.register('student:internal-copy', (): StudentSubmitResponse => {
    // VULN-09: renderer ปลอม mark ได้ — main ตั้ง hash เองจาก before-input-event เท่านั้น
    return { ok: true }
  })

  router.register('student:typing-metrics', (req): StudentSubmitResponse => {
    services.getGuardEngine()?.ingestTypingSamples(req.intervalsMs)
    return { ok: true }
  })
}

export interface StudentForwarderHooks {
  /** ได้รับนโยบายตรวจจับใหม่จากเครื่องแม่ (ผูกกับ GuardEngine ใน index.ts) */
  onPolicyUpdate?: (policy: SignedDetectionPolicy) => void
  /** การสอบจบ (หมดเวลา/จบเอง/ห้องปิด) — หยุด guard ทั้งหมด */
  onExamEnded?: () => void
  /** Phase 3c: ข้อความจากเครื่องแม่ที่ ScreenStreamController จัดการ — คืน true เมื่อจัดการแล้ว */
  onNetMessage?: (type: string, payload: unknown) => boolean
}

/**
 * แปลงข้อความ exam จากเครื่องแม่ เป็น renderer events (แล้วจัดการ kiosk lifecycle)
 */
export function createStudentExamEventForwarder(
  eventSender: (channel: string, payload: unknown) => void,
  getWindow: () => BrowserWindow | null,
  hooks: StudentForwarderHooks = {}
): (type: string, payload: unknown) => void {
  return (type, payload) => {
    if (hooks.onNetMessage?.(type, payload)) return
    switch (type) {
      case NetMsgType.examStarted:
        eventSender('exam:started', payload)
        break
      case NetMsgType.questionPayload:
        eventSender('exam:question', payload)
        break
      case NetMsgType.stateRecovery:
        eventSender('exam:recovery', payload)
        break
      case NetMsgType.submitRejected:
        eventSender('exam:submit-rejected', payload)
        break
      case NetMsgType.timeUp:
        eventSender('exam:time-up', {})
        break
      case NetMsgType.examCompleted: {
        eventSender('exam:completed', payload)
        hooks.onExamEnded?.()
        const win = getWindow()
        if (win && !win.isDestroyed()) exitKioskMode(win)
        break
      }
      case NetMsgType.policyUpdate: {
        const { policy } = payload as { policy: SignedDetectionPolicy }
        hooks.onPolicyUpdate?.(policy)
        break
      }
      case NetMsgType.heartbeatPong: {
        const pong = payload as { remainingExamSeconds?: number }
        if (typeof pong.remainingExamSeconds === 'number') {
          eventSender('exam:tick', { remainingSeconds: pong.remainingExamSeconds })
        }
        break
      }
      case NetMsgType.proctorWarning:
        eventSender('exam:proctor-warning', payload)
        break
      case NetMsgType.freezeExam:
        eventSender('exam:freeze-state', { ...(payload as { frozen: boolean; reason?: string }), frozen: true })
        break
      case NetMsgType.unfreezeExam:
        eventSender('exam:freeze-state', { ...(payload as { frozen: boolean; reason?: string }), frozen: false })
        break
      case NetMsgType.roomClosed:
        {
          hooks.onExamEnded?.()
          const win = getWindow()
          if (win && !win.isDestroyed()) exitKioskMode(win)
        }
        break
      default:
        break
    }
  }
}

/** helper เรียกเมื่อ renderer ขอเข้า kiosk */
export function makeKioskHooks(
  getWindow: () => BrowserWindow | null,
  windowedKiosk: boolean
): Pick<ExamServices, 'enterKiosk' | 'exitKiosk'> {
  return {
    enterKiosk: () => {
      const win = getWindow()
      if (!win || win.isDestroyed() || windowedKiosk) return
      enterKioskMode(win)
    },
    exitKiosk: () => {
      const win = getWindow()
      if (!win || win.isDestroyed() || windowedKiosk) return
      exitKioskMode(win)
    }
  }
}

import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { DocsViewController } from '../browser/docs-view'
import type { OpenVsCodeResponse } from '@shared/ipc-channels'

/* ============================================================
 * Phase 5 IPC — ควบคุมแผงเอกสาร (Mode 2) และ VS Code ควบคุม (Mode 3)
 * จาก renderer นักเรียน; ตัวตรวจ whitelist จริงอยู่ฝั่ง main process เสมอ
 * ============================================================ */

export interface ModeServices {
  getDocsView: () => DocsViewController | null
  /** เรียกเมื่อนักเรียนกด "เปิด VS Code" — compose เสร็จใน index.ts */
  launchVsCode: () => Promise<OpenVsCodeResponse>
  focusExamWindow: () => boolean
}

export function registerModeHandlers(router: IpcRouter, state: AppRuntimeState, services: ModeServices): void {
  router.register('exam:docs-toggle', (req) => {
    if (state.role !== 'student') throw new Error('STUDENT_ROLE_REQUIRED')
    const docsView = services.getDocsView()
    if (!docsView) return { ok: false }
    return docsView.toggle(req.open)
  })

  router.register('exam:docs-navigate', (req) => {
    if (state.role !== 'student') throw new Error('STUDENT_ROLE_REQUIRED')
    const docsView = services.getDocsView()
    if (!docsView) return { ok: false }
    return docsView.navigate(req.url)
  })

  router.register('exam:open-vscode', async () => {
    if (state.role !== 'student') throw new Error('STUDENT_ROLE_REQUIRED')
    return services.launchVsCode()
  })

  router.register('student:focus-exam', () => {
    if (state.role !== 'student') throw new Error('STUDENT_ROLE_REQUIRED')
    return { ok: services.focusExamWindow() }
  })
}

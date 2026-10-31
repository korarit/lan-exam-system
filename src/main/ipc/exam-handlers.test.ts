import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IpcRouter, type IpcRegistrar } from './router'
import { registerExamHandlers, type ExamServices } from './exam-handlers'
import type { AppRuntimeState } from './app-handlers'
import type { IpcResult } from '@shared/ipc-channels'

function createRouter(): { router: IpcRouter; listeners: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown> } {
  const listeners = new Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>()
  const registrar: IpcRegistrar = {
    handle: (channel, listener) => {
      listeners.set(channel, listener as unknown as (e: IpcMainInvokeEvent, p: unknown) => unknown)
    }
  }
  return { router: new IpcRouter(registrar), listeners }
}

function fakeEvent(): IpcMainInvokeEvent {
  return { senderFrame: { parent: null } } as unknown as IpcMainInvokeEvent
}

function makeServices(overrides: Partial<ExamServices> = {}): ExamServices {
  return {
    getSessionManager: () => {
      throw new Error('unused')
    },
    getStudentClient: () => {
      throw new Error('unused')
    },
    getGuardEngine: () => null,
    enterKiosk: vi.fn(),
    exitKiosk: vi.fn(),
    ...overrides
  } as unknown as ExamServices
}

describe('student:exit-kiosk (VULN-21)', () => {
  it('ปฏิเสธการออก kiosk ระหว่างสอบ', async () => {
    const { router, listeners } = createRouter()
    const state: AppRuntimeState = { profileId: 'p', role: 'student' }
    const exitKiosk = vi.fn()
    registerExamHandlers(router, state, makeServices({ exitKiosk, isExamRunning: () => true }))

    const result = (await listeners.get('student:exit-kiosk')?.(fakeEvent(), undefined)) as IpcResult<unknown>
    expect(result.ok).toBe(false)
    expect(exitKiosk).not.toHaveBeenCalled()
  })

  it('อนุญาตให้ออก kiosk เมื่อไม่ได้สอบอยู่', async () => {
    const { router, listeners } = createRouter()
    const state: AppRuntimeState = { profileId: 'p', role: 'student' }
    const exitKiosk = vi.fn()
    registerExamHandlers(router, state, makeServices({ exitKiosk, isExamRunning: () => false }))

    const result = (await listeners.get('student:exit-kiosk')?.(fakeEvent(), undefined)) as IpcResult<unknown>
    expect(result.ok).toBe(true)
    expect(exitKiosk).toHaveBeenCalledOnce()
  })
})

import { describe, it, expect, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IpcRouter, type IpcRegistrar } from './router'
import type { IpcInvokeMap, IpcResult } from '@shared/ipc-channels'

interface FakeListener {
  (event: IpcMainInvokeEvent, ...args: unknown[]): void
}

function createFakeRegistrar(): { registrar: IpcRegistrar; listeners: Map<string, FakeListener> } {
  const listeners = new Map<string, FakeListener>()
  return {
    listeners,
    registrar: {
      handle: (channel, listener) => {
        listeners.set(channel, listener)
      }
    }
  }
}

function fakeEvent(topFrame: boolean): IpcMainInvokeEvent {
  return {
    senderFrame: { parent: topFrame ? null : { url: 'https://evil.example' } }
  } as unknown as IpcMainInvokeEvent
}

describe('IpcRouter', () => {
  it('passes a valid payload to the handler and returns wrapped data', async () => {
    const { registrar, listeners } = createFakeRegistrar()
    const router = new IpcRouter(registrar)
    const handler = vi.fn(() => ({ ok: true, role: 'host' as const }))
    router.register('app:select-role', handler)

    const listener = listeners.get('app:select-role')
    expect(listener).toBeDefined()
    const result = (await listener?.(fakeEvent(true), { role: 'host' })) as unknown as IpcResult<
      IpcInvokeMap['app:select-role']['res']
    >
    expect(handler).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ ok: true, role: 'host' })
  })

  it('rejects a payload that fails the Zod schema with a safe message', async () => {
    const { registrar, listeners } = createFakeRegistrar()
    const router = new IpcRouter(registrar)
    const handler = vi.fn()
    router.register('app:select-role', handler)

    const result = (await listeners.get('app:select-role')?.(fakeEvent(true), {
      role: 'admin; DROP TABLE students'
    })) as unknown as IpcResult<unknown>
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('VALIDATION')
    expect(handler).not.toHaveBeenCalled()
    // ห้ามฟุ้งรายละเอียดภายในออกไป
    expect(result.error?.message.length).toBeLessThan(80)
  })

  it('rejects unexpected extra fields (strict schema)', async () => {
    const { registrar, listeners } = createFakeRegistrar()
    const router = new IpcRouter(registrar)
    router.register('app:select-role', vi.fn())

    const result = (await listeners.get('app:select-role')?.(fakeEvent(true), {
      role: 'host',
      injected: true
    })) as unknown as IpcResult<unknown>
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('VALIDATION')
  })

  it('rejects invokes from a nested/untrusted frame', async () => {
    const { registrar, listeners } = createFakeRegistrar()
    const router = new IpcRouter(registrar)
    const handler = vi.fn()
    router.register('app:select-role', handler)

    const result = (await listeners.get('app:select-role')?.(fakeEvent(false), {
      role: 'host'
    })) as unknown as IpcResult<unknown>
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('VALIDATION')
    expect(handler).not.toHaveBeenCalled()
  })

  it('wraps handler failures without leaking the stack', async () => {
    const { registrar, listeners } = createFakeRegistrar()
    const router = new IpcRouter(registrar)
    router.register('app:get-app-info', () => {
      throw new Error('db secret path /home/user/x.sqlite')
    })

    const result = (await listeners.get('app:get-app-info')?.(
      fakeEvent(true),
      undefined
    )) as unknown as IpcResult<unknown>
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('HANDLER')
    expect(result.error?.message).not.toContain('stack')
  })

  it('refuses to register the same channel twice', () => {
    const { registrar } = createFakeRegistrar()
    const router = new IpcRouter(registrar)
    router.register('app:select-role', () => ({ ok: true, role: 'host' }))
    expect(() =>
      router.register('app:select-role', () => ({ ok: true, role: 'host' }))
    ).toThrow(/already registered/)
  })
})

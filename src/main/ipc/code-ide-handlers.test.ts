import { describe, it, expect, afterEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IpcRouter, type IpcRegistrar } from './router'
import { registerCodeIdeHandlers } from './code-ide-handlers'
import { clearCustomSdkPaths } from '@modules/code-ide/main/runtime-locator'
import type { IpcInvokeMap, IpcResult } from '@shared/ipc-channels'

afterEach(() => {
  clearCustomSdkPaths()
})

function setup(): { router: IpcRouter; listeners: Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => void> } {
  const listeners = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => void>()
  const registrar: IpcRegistrar = { handle: (channel, listener) => { listeners.set(channel, listener) } }
  const router = new IpcRouter(registrar)
  registerCodeIdeHandlers(router)
  return { router, listeners }
}

function fakeEvent(): IpcMainInvokeEvent {
  return { senderFrame: { parent: null } } as unknown as IpcMainInvokeEvent
}

describe('code-ide IPC handlers (Phase 9 — รันบนเครื่องตัวเอง)', () => {
  it('code-ide:run-sql รัน SELECT จริงผ่าน SQLite และคืน actual', async () => {
    const { listeners } = setup()
    const result = (await listeners.get('code-ide:run-sql')?.(fakeEvent(), {
      seedSql: 'CREATE TABLE users(id INTEGER, name TEXT); INSERT INTO users VALUES (1, \'Ann\');',
      studentSql: 'SELECT id, name FROM users;',
      test: {
        testId: 's1', kind: 'sql-query', title: 't',
        expectedColumns: ['id', 'name'], expectedRows: [[1, 'Ann']],
        checkColumnOrder: true, checkRowOrder: true,
        visibility: 'sample', points: 10, timeoutMs: 2000
      }
    })) as unknown as IpcResult<IpcInvokeMap['code-ide:run-sql']['res']>
    expect(result.ok).toBe(true)
    expect(result.data?.passed).toBe(true)
    expect(result.data?.actualColumns).toEqual(['id', 'name'])
    expect(result.data?.actualRows).toEqual([[1, 'Ann']])
  })

  it('code-ide:run-sql ปฏิเสธ payload ผิด schema (VALIDATION)', async () => {
    const { listeners } = setup()
    const result = (await listeners.get('code-ide:run-sql')?.(fakeEvent(), {
      seedSql: '', studentSql: '', test: { testId: 'x' }
    })) as unknown as IpcResult<unknown>
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('VALIDATION')
  })

  it('code-ide:run-cli รัน python จริง (ถ้ามี python ในเครื่อง)', async () => {
    const { listeners } = setup()
    const result = (await listeners.get('code-ide:run-cli')?.(fakeEvent(), {
      language: 'python',
      entryPointPath: 'src/main.py',
      entries: [
        { path: 'src', kind: 'folder' },
        { path: 'src/main.py', kind: 'file', content: 'print(int(input()) + 1)' }
      ],
      test: {
        testId: 't1', kind: 'stdio', title: 't', stdin: '41', expectedStdout: '42',
        inputs: [], visibility: 'sample', points: 10, timeoutMs: 8000
      }
    })) as unknown as IpcResult<IpcInvokeMap['code-ide:run-cli']['res']>
    expect(result.ok).toBe(true)
    // ถ้าเครื่อง test ไม่มี python จะได้ stderr อธิบาย — ไม่ fail เพราะ env
    if ((result.data?.stderr ?? '').includes('python') && result.data?.actualStdout === '') {
      expect(result.data?.note).toBeTruthy()
    } else {
      expect(result.data?.actualStdout.trim()).toBe('42')
      expect(result.data?.passed).toBe(true)
    }
  }, 20000)

  it('code-ide:add-sdk-path โฟลเดอร์ว่าง (ไม่มี binary) → ok:false', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const emptyDir = mkdtempSync(join(tmpdir(), 'zt-empty-sdk-'))
    const { listeners } = setup()
    const result = (await listeners.get('code-ide:add-sdk-path')?.(fakeEvent(), {
      runtime: 'python',
      dirPath: emptyDir
    })) as unknown as IpcResult<IpcInvokeMap['code-ide:add-sdk-path']['res']>
    expect(result.ok).toBe(true)
    // โฟลเดอร์มีจริงแต่ไม่มี binary → handler ตอบ ok:false พร้อมเหตุผล
    expect(result.data?.ok).toBe(false)
    expect(result.data?.reason).toContain('NO_RUNTIME_BINARY')
  })

  it('code-ide:add-sdk-path พาธไม่มีจริง → ok:false', async () => {
    const { listeners } = setup()
    const result = (await listeners.get('code-ide:add-sdk-path')?.(fakeEvent(), {
      runtime: 'go',
      dirPath: '/path/that/does/not/exist-zt'
    })) as unknown as IpcResult<IpcInvokeMap['code-ide:add-sdk-path']['res']>
    expect(result.ok).toBe(true)
    expect(result.data?.ok).toBe(false)
    expect(result.data?.reason).toBe('NOT_A_DIRECTORY')
  })

  it('code-ide:check-runtimes คืนสถานะรายการที่ขอ', async () => {
    const { listeners } = setup()
    const result = (await listeners.get('code-ide:check-runtimes')?.(fakeEvent(), {
      languages: ['python', 'sql-sqlite']
    })) as unknown as IpcResult<IpcInvokeMap['code-ide:check-runtimes']['res']>
    expect(result.ok).toBe(true)
    expect(result.data?.runtimes.map((r) => r.name).sort()).toEqual(['python'])
  })
})

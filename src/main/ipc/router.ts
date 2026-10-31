import type { IpcMainInvokeEvent } from 'electron'
import { ZodError, type ZodType } from 'zod'
import {
  IpcInvokeSchemas,
  IpcEventSchemas,
  type IpcInvokeChannel,
  type IpcEventChannel,
  type IpcInvokeMap,
  type IpcEventMap,
  type IpcResult,
  type IpcErrorDetail
} from '@shared/ipc-channels'

/** อินเทอร์เฟซการลงทะเบียน channel (แยกออกจาก electron เพื่อให้ทดสอบ unit ได้) */
export interface IpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => void
  ): void
}

/** ผูกกับ ipcMain จริง */
export function createElectronIpcRegistrar(): IpcRegistrar {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ipcMain } = require('electron') as typeof import('electron')
  return { handle: (channel, listener) => ipcMain.handle(channel, listener) }
}

export type IpcInvokeHandler<K extends IpcInvokeChannel> = (
  req: IpcInvokeMap[K]['req'],
  event: IpcMainInvokeEvent
) => Promise<IpcInvokeMap[K]['res']> | IpcInvokeMap[K]['res']

export interface IpcEventSender {
  send(channel: string, payload: unknown): void
  isDestroyed(): boolean
}

export interface IpcRouterOptions {
  /**
   * ผูก sender กับ WebContents ที่อนุญาต (main window / floating HUD)
   * default = ไม่ผูก (legacy) — production ต้องส่งเข้ามาเสมอเพื่อปิด VULN-21
   */
  isTrustedSender?: (event: IpcMainInvokeEvent) => boolean
}

/**
 * IPC Router ฝั่ง Main process:
 * - รับเฉพาะ invoke จาก top-level frame ของแอปเท่านั้น (ไม่รับจาก iframe / WebContentsView)
 * - Validate payload ขาเข้าและขาออกด้วย Zod ทุกครั้ง
 * - คืนผลลัพธ์แบบ { ok, data | error } โดยไม่ปล่อยข้อความภายในออกไป
 */
export class IpcRouter {
  private readonly registeredChannels = new Set<string>()

  constructor(
    private readonly registrar: IpcRegistrar,
    private readonly options: IpcRouterOptions = {}
  ) {}

  register<K extends IpcInvokeChannel>(
    channel: K,
    handler: IpcInvokeHandler<K>
  ): void {
    if (this.registeredChannels.has(channel)) {
      throw new Error(`IPC channel already registered: ${channel}`)
    }
    this.registeredChannels.add(channel)
    const schema = IpcInvokeSchemas[channel]

    this.registrar.handle(channel, async (event: IpcMainInvokeEvent, rawPayload: unknown) => {
      if (!this.isTrustedFrame(event)) {
        return this.failure('VALIDATION', 'Untrusted frame is not allowed')
      }
      try {
        const parsed = schema.request.safeParse(rawPayload)
        if (!parsed.success) {
          return this.failure('VALIDATION', safeZodMessage(parsed.error))
        }
        const result = await handler(parsed.data as IpcInvokeMap[K]['req'], event)
        const resCheck = schema.response.safeParse(result)
        if (!resCheck.success) {
          return this.failure('RESPONSE', 'Handler returned an unexpected response shape')
        }
        return { ok: true, data: resCheck.data } satisfies IpcResult<IpcInvokeMap[K]['res']>
      } catch (err) {
        return this.failure('HANDLER', err instanceof Error ? err.message : 'Unexpected handler failure')
      }
    })
  }

  /** ส่ง push event จาก Main ไปยัง Renderer โดย validate payload ก่อนส่ง */
  sendToRenderer<S extends IpcEventSender>(
    webContents: S,
    channel: IpcEventChannel,
    payload: IpcEventMap[IpcEventChannel]
  ): boolean {
    const schema = IpcEventSchemas[channel] as ZodType
    const parsed = schema.safeParse(payload)
    if (!parsed.success || webContents.isDestroyed()) {
      return false
    }
    webContents.send(channel, parsed.data)
    return true
  }

  private isTrustedFrame(event: IpcMainInvokeEvent): boolean {
    const frame = event.senderFrame
    if (!frame) return false
    // รับเฉพาะ top frame ของหน้าต่างแอป (ไม่ใช่ iframe ที่ฝังเข้ามา)
    if (frame.parent !== null) return false
    // VULN-21: top frame จาก WebContents อื่นก็ยังต้องถูกปฏิเสธ
    if (this.options.isTrustedSender) return this.options.isTrustedSender(event)
    return true
  }

  private failure(code: IpcErrorDetail['code'], message: string): IpcResult<never> {
    return { ok: false, error: { code, message } }
  }}

/** ข้อความ error ที่ปลอดภัยต่อการส่งกลับไปยัง renderer */
function safeZodMessage(err: ZodError): string {
  const issue = err.issues[0]
  const path = issue && issue.path.length > 0 ? issue.path.join('.') : 'payload'
  return `Invalid ${path}`
}

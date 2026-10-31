import { randomUUID } from 'node:crypto'
import {
  NetMsgType,
  type ModulePacketKind,
  type ModulePacketModuleId
} from '@shared/protocol-schema'
import type { IpcRouter } from '../ipc/router'
import type { AppRuntimeState } from '../ipc/app-handlers'

/* ============================================================
 * Phase 2 (สเปคมี แต่ไม่เคยมีโค้ด) — ท่อกลาง MODULE_PACKET_ENVELOPE
 * รับส่ง action/autosave ของ Pluggable Exam Modules ผ่าน TLS 1.3
 * - ความถูกต้อง/กัน replay อาศัย NetEnvelope (seq + HMAC + sessionKey) อยู่แล้ว
 * - payload ก้อนใหญ่ (โปรเจกต์หลายไฟล์) หั่นเป็น chunks ประกอบที่โฮสต์
 * - โฮสต์ตอบ moduleAck ทุกงาน / ผลัก moduleStatePush (stripped view) ตอนเริ่มสอบ
 * ไฟล์นี้ใช้ได้ทั้งสอง role: Host (reassembly + dispatch) และ
 * Student (chunk + ส่งผ่าน ExamTlsClient.sendExamMessage)
 * ============================================================ */

export const MODULE_CHUNK_BYTES = 256 * 1024
export const MODULE_MAX_TRANSFER_BYTES = 12 * 1024 * 1024
export const MODULE_TRANSFER_TIMEOUT_MS = 60_000
export const MODULE_MAX_TRANSFERS_PER_STUDENT = 8
/** ส่งตรงไม่หั่นเมื่อ JSON เล็กกว่านี้ (เผื่อ base64 + envelope ไม่เกิน frame) */
export const MODULE_DIRECT_MAX_JSON = 900_000

export interface ModuleChunkMessage {
  transferId: string
  moduleId: ModulePacketModuleId
  kind: ModulePacketKind
  chunkIndex: number
  chunkTotal: number
  contentBase64: string
}

export class ModuleTransferError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModuleTransferError'
  }
}

/** หั่น JSON เป็น chunks (base64) — โยน TOO_LARGE ถ้าเกินขีด */
export function chunkModulePayload(
  moduleId: ModulePacketModuleId,
  kind: ModulePacketKind,
  json: string,
  transferId: string = randomUUID()
): ModuleChunkMessage[] {
  const raw = Buffer.from(json, 'utf8')
  if (raw.length === 0) throw new ModuleTransferError('EMPTY_PAYLOAD')
  if (raw.length > MODULE_MAX_TRANSFER_BYTES) throw new ModuleTransferError('TRANSFER_TOO_LARGE')
  const chunks: ModuleChunkMessage[] = []
  const total = Math.max(1, Math.ceil(raw.length / MODULE_CHUNK_BYTES))
  if (total > 4096) throw new ModuleTransferError('TOO_MANY_CHUNKS')
  for (let i = 0; i < total; i++) {
    const slice = raw.subarray(i * MODULE_CHUNK_BYTES, (i + 1) * MODULE_CHUNK_BYTES)
    chunks.push({
      transferId,
      moduleId,
      kind,
      chunkIndex: i,
      chunkTotal: total,
      contentBase64: slice.toString('base64')
    })
  }
  return chunks
}

interface PendingTransfer {
  moduleId: ModulePacketModuleId
  kind: ModulePacketKind
  chunkTotal: number
  parts: Map<number, string>
  receivedBytes: number
  startedAtMs: number
}

/** ประกอบ chunks (ทนลำดับสลับ/ซ้ำ) — คืน JSON ครบเมื่อชิ้นสุดท้ายมาถึง */
export class ModuleChunkAssembler {
  private readonly pending = new Map<string, PendingTransfer>()

  ingest(chunk: ModuleChunkMessage, nowMs: number): { complete: boolean; json?: string } {
    this.prune(nowMs)
    if (chunk.chunkIndex >= chunk.chunkTotal) throw new ModuleTransferError('CHUNK_INDEX_INVALID')
    let transfer = this.pending.get(chunk.transferId)
    if (!transfer) {
      if (this.pending.size >= MODULE_MAX_TRANSFERS_PER_STUDENT) {
        throw new ModuleTransferError('TOO_MANY_TRANSFERS')
      }
      transfer = {
        moduleId: chunk.moduleId,
        kind: chunk.kind,
        chunkTotal: chunk.chunkTotal,
        parts: new Map(),
        receivedBytes: 0,
        startedAtMs: nowMs
      }
      this.pending.set(chunk.transferId, transfer)
    }
    if (transfer.moduleId !== chunk.moduleId || transfer.kind !== chunk.kind || transfer.chunkTotal !== chunk.chunkTotal) {
      throw new ModuleTransferError('TRANSFER_MISMATCH')
    }
    if (!transfer.parts.has(chunk.chunkIndex)) {
      // base64 ~4/3 ของ raw — ประเมินหยาบแล้วกันบวมด้วยขีดรวม
      transfer.receivedBytes += Math.floor((chunk.contentBase64.length * 3) / 4)
      if (transfer.receivedBytes > MODULE_MAX_TRANSFER_BYTES + 1_000_000) {
        this.pending.delete(chunk.transferId)
        throw new ModuleTransferError('TRANSFER_TOO_LARGE')
      }
      transfer.parts.set(chunk.chunkIndex, chunk.contentBase64)
    }
    if (transfer.parts.size < transfer.chunkTotal) return { complete: false }
    const ordered: string[] = []
    for (let i = 0; i < transfer.chunkTotal; i++) {
      const part = transfer.parts.get(i)
      if (part === undefined) return { complete: false }
      ordered.push(part)
    }
    this.pending.delete(chunk.transferId)
    let json: string
    try {
      json = Buffer.concat(ordered.map((b) => Buffer.from(b, 'base64'))).toString('utf8')
    } catch {
      throw new ModuleTransferError('CHUNK_DECODE_FAILED')
    }
    if (json.length < 2) throw new ModuleTransferError('EMPTY_PAYLOAD')
    return { complete: true, json }
  }

  pendingCount(): number {
    return this.pending.size
  }

  prune(nowMs: number): number {
    let removed = 0
    for (const [id, t] of this.pending) {
      if (nowMs - t.startedAtMs > MODULE_TRANSFER_TIMEOUT_MS) {
        this.pending.delete(id)
        removed += 1
      }
    }
    return removed
  }
}

/* ------------------------- ฝั่ง Host ------------------------- */

export interface ModuleIngestResult {
  ok: boolean
  progressText?: string
  reason?: string
  /** VULN-61: view ถัดไปที่ host ต้องการ push (progressive disclosure) */
  stateJson?: string
}

export interface ModuleTransportHostDeps {
  getRoomId: () => string | null
  /** ส่งข้อความถึงนักเรียน (tlsServer.sendToStudent) */
  sendToStudent: (studentId: string, type: string, payload: unknown) => void
  /**
   * รับงานที่ประกอบเสร็จแล้วต่อโมดูล (adapter ของแต่ละ moduleId ตรวจ
   * สถานะห้องสอบ/validate/store/grade เอง — transport แค่ส่ง ack กลับ)
   */
  handleModuleMessage: (args: {
    roomId: string
    studentId: string
    moduleId: ModulePacketModuleId
    kind: ModulePacketKind
    payloadJson: string
    serverTimestampMs: number
  }) => Promise<ModuleIngestResult>
}

export class ModuleTransportHost {
  private readonly assemblers = new Map<string, ModuleChunkAssembler>()

  constructor(private readonly deps: ModuleTransportHostDeps) {}

  private assemblerFor(studentId: string): ModuleChunkAssembler {
    let assembler = this.assemblers.get(studentId)
    if (!assembler) {
      assembler = new ModuleChunkAssembler()
      this.assemblers.set(studentId, assembler)
    }
    return assembler
  }

  /** คืน true เมื่อกิน message นี้แล้ว (index.ts ไม่ต้องส่งต่อ session-manager) */
  handleStudentMessage(studentId: string, type: string, payload: unknown): boolean {
    if (type === NetMsgType.moduleAction) {
      const p = payload as { moduleId: ModulePacketModuleId; actionJson: string }
      void this.dispatch(studentId, p.moduleId, 'action', p.actionJson)
      return true
    }
    if (type === NetMsgType.moduleAutosave) {
      const p = payload as { moduleId: ModulePacketModuleId; draftJson: string }
      void this.dispatch(studentId, p.moduleId, 'autosave', p.draftJson)
      return true
    }
    if (type === NetMsgType.moduleChunk) {
      const p = payload as ModuleChunkMessage
      try {
        const out = this.assemblerFor(studentId).ingest(p, Date.now())
        if (out.complete && out.json !== undefined) {
          void this.dispatch(studentId, p.moduleId, p.kind, out.json)
        }
      } catch (err) {
        this.ack(studentId, p.moduleId, p.kind, {
          ok: false,
          reason: err instanceof ModuleTransferError ? err.message : 'CHUNK_FAILED'
        })
      }
      return true
    }
    return false
  }

  private async dispatch(
    studentId: string,
    moduleId: ModulePacketModuleId,
    kind: ModulePacketKind,
    payloadJson: string
  ): Promise<void> {
    const roomId = this.deps.getRoomId()
    if (!roomId) {
      this.ack(studentId, moduleId, kind, { ok: false, reason: 'ROOM_NOT_OPEN' })
      return
    }
    try {
      const result = await this.deps.handleModuleMessage({
        roomId,
        studentId,
        moduleId,
        kind,
        payloadJson,
        serverTimestampMs: Date.now()
      })
      this.ack(studentId, moduleId, kind, result)
      if (result.stateJson !== undefined) {
        this.deps.sendToStudent(studentId, NetMsgType.moduleStatePush, {
          moduleId,
          stateJson: result.stateJson
        })
      }
    } catch {
      this.ack(studentId, moduleId, kind, { ok: false, reason: 'HANDLER_FAILED' })
    }
  }

  private ack(
    studentId: string,
    moduleId: ModulePacketModuleId,
    kind: ModulePacketKind,
    result: ModuleIngestResult
  ): void {
    try {
      this.deps.sendToStudent(studentId, NetMsgType.moduleAck, {
        moduleId,
        kind,
        ok: result.ok,
        ...(result.progressText !== undefined ? { progressText: result.progressText.slice(0, 200) } : {}),
        ...(result.reason !== undefined ? { reason: result.reason.slice(0, 200) } : {})
      })
    } catch {
      /* สายหลุดระหว่าง ack — งานใน DB ยังอยู่ */
    }
  }
}

/* ------------------------- ฝั่ง Student ------------------------- */

export interface ModulePacketSender {
  sendExamMessage: (type: string, payload: unknown) => void
}

/* ----------------- Student IPC (renderer → TLS) ----------------- */

export interface ModuleTransportStudentDeps {
  getStudentClient: () => { sendExamMessage: (type: string, payload: unknown) => void } | null
  isConnected: () => boolean
}

/** IPC `student:module-send` — ใช้ได้เฉพาะ role student ที่ต่อสาย TLS อยู่ */
export function registerModuleTransportStudentHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  deps: ModuleTransportStudentDeps
): void {
  router.register('student:module-send', (req) => {
    if (state.role !== 'student') throw new Error('STUDENT_ROLE_REQUIRED')
    const sender = createStudentModuleSender(deps)
    try {
      const out = sender.send(req.moduleId, req.kind, req.payloadJson)
      return { ok: true, chunked: out.chunked, chunks: out.chunks }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'SEND_FAILED'
      if (reason === 'NOT_CONNECTED') return { ok: false, reason: 'NOT_CONNECTED' }
      if (reason === 'TRANSFER_TOO_LARGE' || reason === 'EMPTY_PAYLOAD') return { ok: false, reason }
      return { ok: false, reason: 'SEND_FAILED' }
    }
  })
}

/**
 * renderer เรียกผ่าน IPC `student:module-send` — main หั่น + ส่งผ่านสาย TLS
 * ที่มีอยู่ (Envelope HMAC + seq + anti-replay คุ้มครองทั้งก้อนอยู่แล้ว)
 */
export function createStudentModuleSender(deps: ModuleTransportStudentDeps): {
  send: (moduleId: ModulePacketModuleId, kind: ModulePacketKind, payloadJson: string) => { chunked: boolean; chunks: number }
} {
  return {
    send: (moduleId, kind, payloadJson) => {
      if (!deps.isConnected()) throw new Error('NOT_CONNECTED')
      const client = deps.getStudentClient()
      if (!client) throw new Error('NOT_CONNECTED')
      return sendModulePacket(client, moduleId, kind, payloadJson)
    }
  }
}

/** ส่ง action/autosave 1 ชิ้น — ใหญ่เกินขีดหั่นเป็น chunks อัตโนมัติ */
export function sendModulePacket(
  sender: ModulePacketSender,
  moduleId: ModulePacketModuleId,
  kind: ModulePacketKind,
  payloadJson: string
): { chunked: boolean; chunks: number } {
  if (payloadJson.length <= MODULE_DIRECT_MAX_JSON) {
    if (kind === 'action') {
      sender.sendExamMessage(NetMsgType.moduleAction, { moduleId, actionJson: payloadJson })
    } else {
      sender.sendExamMessage(NetMsgType.moduleAutosave, { moduleId, draftJson: payloadJson })
    }
    return { chunked: false, chunks: 1 }
  }
  const chunks = chunkModulePayload(moduleId, kind, payloadJson)
  for (const c of chunks) {
    sender.sendExamMessage(NetMsgType.moduleChunk, c)
  }
  return { chunked: true, chunks: chunks.length }
}

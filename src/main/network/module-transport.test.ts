import { describe, expect, it, vi } from 'vitest'
import {
  ModuleChunkAssembler,
  ModuleTransportHost,
  chunkModulePayload,
  sendModulePacket,
  MODULE_CHUNK_BYTES
} from './module-transport'
import { NetMsgType } from '@shared/protocol-schema'

/* Phase 2 (ท่อกลาง modules — สเปคมีแต่เพิ่งมีโค้ด): chunking + dispatch + ack */

function bigJson(sizeBytes: number): string {
  return JSON.stringify({ data: 'x'.repeat(sizeBytes) })
}

describe('module chunking', () => {
  it('หั่นแล้วประกอบกลับได้ตรง (หลาย chunks)', () => {
    const json = bigJson(MODULE_CHUNK_BYTES * 2 + 100)
    const chunks = chunkModulePayload('code-ide', 'action', json, 't-1')
    expect(chunks.length).toBe(3)
    const asm = new ModuleChunkAssembler()
    const results = chunks.map((c) => asm.ingest(c, Date.now()))
    expect(results.slice(0, -1).every((r) => !r.complete)).toBe(true)
    expect(results[results.length - 1]?.complete).toBe(true)
    expect(results[results.length - 1]?.json).toBe(json)
  })

  it('ทนลำดับสลับ + chunk ซ้ำ', () => {
    const json = bigJson(MODULE_CHUNK_BYTES + 10)
    const chunks = chunkModulePayload('code-ide', 'autosave', json, 't-2')
    expect(chunks).toHaveLength(2)
    const asm = new ModuleChunkAssembler()
    const reversed = [...chunks].reverse()
    expect(asm.ingest(reversed[0]!, Date.now()).complete).toBe(false)
    expect(asm.ingest(reversed[0]!, Date.now()).complete).toBe(false) // ซ้ำ
    const done = asm.ingest(reversed[1]!, Date.now())
    expect(done.complete).toBe(true)
    expect(done.json).toBe(json)
    // transfer เดิมจบแล้ว — ส่งชิ้นเดิมอีก = transfer ใหม่ค้าง 1 ชิ้น (ไม่ complete)
    expect(asm.ingest(chunks[0]!, Date.now()).complete).toBe(false)
    expect(asm.pendingCount()).toBe(1)
  })

  it('payload เกินขีดโยน TRANSFER_TOO_LARGE', () => {
    expect(() => chunkModulePayload('code-ide', 'action', bigJson(13 * 1024 * 1024))).toThrow(
      'TRANSFER_TOO_LARGE'
    )
  })

  it('transferId ชนกันแต่ kind ต่างกัน = MISMATCH', () => {
    const asm = new ModuleChunkAssembler()
    const a = chunkModulePayload('code-ide', 'action', bigJson(MODULE_CHUNK_BYTES + 10), 't-x')
    const b = chunkModulePayload('code-ide', 'autosave', bigJson(MODULE_CHUNK_BYTES + 20), 't-x')
    asm.ingest(a[0]!, Date.now())
    expect(() => asm.ingest(b[0]!, Date.now())).toThrow('TRANSFER_MISMATCH')
  })

  it('transfer ค้างเกิน timeout ถูก prune', () => {
    const asm = new ModuleChunkAssembler()
    const chunks = chunkModulePayload('code-ide', 'action', bigJson(MODULE_CHUNK_BYTES + 10), 't-old')
    asm.ingest(chunks[0]!, 1_000)
    expect(asm.pendingCount()).toBe(1)
    expect(asm.prune(1_000 + 61_000)).toBe(1)
    expect(asm.pendingCount()).toBe(0)
  })
})

describe('sendModulePacket (ฝั่งนักเรียน)', () => {
  it('เล็กส่งตรง — ใหญ่หั่น chunks', () => {
    const sent: Array<{ type: string; payload: unknown }> = []
    const sender = { sendExamMessage: (type: string, payload: unknown) => sent.push({ type, payload }) }
    const small = sendModulePacket(sender, 'code-ide', 'action', '{"type":"x"}')
    expect(small).toEqual({ chunked: false, chunks: 1 })
    expect(sent[0]?.type).toBe(NetMsgType.moduleAction)
    sent.length = 0
    const big = sendModulePacket(sender, 'code-ide', 'autosave', bigJson(1_000_000))
    expect(big.chunked).toBe(true)
    expect(big.chunks).toBe(4)
    expect(sent.every((s) => s.type === NetMsgType.moduleChunk)).toBe(true)
  })
})

describe('ModuleTransportHost', () => {
  function makeHost(overrides: {
    roomId?: string | null | undefined
    handler?: (args: { roomId: string; studentId: string; payloadJson: string }) => Promise<{ ok: boolean; progressText?: string; reason?: string }>
  } = {}): {
    host: ModuleTransportHost
    sent: Array<{ studentId: string; type: string; payload: unknown }>
    handled: Array<{ payloadJson: string }>
  } {
    const sent: Array<{ studentId: string; type: string; payload: unknown }> = []
    const handled: Array<{ payloadJson: string }> = []
    const host = new ModuleTransportHost({
      getRoomId: () => (overrides.roomId === undefined ? 'room-1' : overrides.roomId),
      sendToStudent: (studentId, type, payload) => sent.push({ studentId, type, payload }),
      handleModuleMessage: async ({ roomId, studentId, payloadJson }) => {
        handled.push({ payloadJson })
        if (overrides.handler) return overrides.handler({ roomId, studentId, payloadJson })
        return { ok: true, progressText: 'done' }
      }
    })
    return { host, sent, handled }
  }

  it('action เล็ก → dispatch + ack ok', async () => {
    const { host, sent, handled } = makeHost()
    expect(host.handleStudentMessage('s1', NetMsgType.moduleAction, { moduleId: 'code-ide', actionJson: '{"type":"ping"}' })).toBe(true)
    await vi.waitFor(() => expect(handled).toHaveLength(1))
    expect(handled[0]?.payloadJson).toBe('{"type":"ping"}')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({ studentId: 's1', type: NetMsgType.moduleAck })
    expect((sent[0]?.payload as { ok: boolean }).ok).toBe(true)
  })

  it('chunks หลายชิ้นประกอบครบแล้ว dispatch ครั้งเดียว', async () => {
    const { host, sent, handled } = makeHost()
    const json = bigJson(600 * 1024)
    const chunks = chunkModulePayload('code-ide', 'action', json, 't-batch')
    for (const c of chunks) {
      expect(host.handleStudentMessage('s2', NetMsgType.moduleChunk, c)).toBe(true)
    }
    await vi.waitFor(() => expect(handled).toHaveLength(1))
    expect(handled[0]?.payloadJson).toBe(json)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect((sent[0]?.payload as { ok: boolean }).ok).toBe(true)
  })

  it('ไม่มีห้อง → ack ROOM_NOT_OPEN (ไม่ throw)', async () => {
    const { host, sent } = makeHost({ roomId: null })
    expect(host.handleStudentMessage('s3', NetMsgType.moduleAction, { moduleId: 'code-ide', actionJson: '{"a":1}' })).toBe(true)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect((sent[0]?.payload as { reason?: string }).reason).toBe('ROOM_NOT_OPEN')
  })

  it('handler พัง → ack HANDLER_FAILED (สายไม่ขาด)', async () => {
    const { host, sent } = makeHost({
      handler: async () => {
        throw new Error('DB down')
      }
    })
    host.handleStudentMessage('s4', NetMsgType.moduleAction, { moduleId: 'code-ide', actionJson: '{"a":1}' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect((sent[0]?.payload as { reason?: string }).reason).toBe('HANDLER_FAILED')
  })

  it('handler คืน ok:false → ack ส่ง reason ต่อ', async () => {
    const { host, sent } = makeHost({
      handler: async () => ({ ok: false, reason: 'EXAM_NOT_RUNNING' })
    })
    host.handleStudentMessage('s5', NetMsgType.moduleAutosave, { moduleId: 'code-ide', draftJson: '{"entries":[]}' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const ack = sent[0]?.payload as { ok: boolean; reason?: string }
    expect(ack.ok).toBe(false)
    expect(ack.reason).toBe('EXAM_NOT_RUNNING')
  })

  it('type ไม่เกี่ยว → คืน false (ส่งต่อ session-manager)', () => {
    const { host } = makeHost()
    expect(host.handleStudentMessage('s6', NetMsgType.heartbeatPing, {})).toBe(false)
  })

  it('chunk เสีย → ack reason ตรง (TRANSFER_MISMATCH)', () => {
    const { host, sent } = makeHost()
    const a = chunkModulePayload('code-ide', 'action', bigJson(MODULE_CHUNK_BYTES + 10), 't-bad')
    const b = chunkModulePayload('code-ide', 'autosave', bigJson(MODULE_CHUNK_BYTES + 20), 't-bad')
    host.handleStudentMessage('s7', NetMsgType.moduleChunk, a[0])
    host.handleStudentMessage('s7', NetMsgType.moduleChunk, b[0])
    expect(sent).toHaveLength(1)
    expect((sent[0]?.payload as { reason?: string }).reason).toBe('TRANSFER_MISMATCH')
  })
})

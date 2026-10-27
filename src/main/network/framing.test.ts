import { describe, it, expect } from 'vitest'
import { FrameDecoder, encodeFrame, MAX_FRAME_SIZE, FrameType } from './framing'
import { PassThrough } from 'node:stream'

function collect(decoder: FrameDecoder): Promise<Array<{ type: number; payload: Buffer }>> {
  const frames: Array<{ type: number; payload: Buffer }> = []
  decoder.on('data', (frame: { type: number; payload: Buffer }) => frames.push(frame))
  const done = new Promise<Array<{ type: number; payload: Buffer }>>((resolve) => {
    decoder.on('end', () => resolve(frames))
    decoder.on('error', (err: Error) => {
      frames.push({ type: -1, payload: Buffer.from(err.message) })
      resolve(frames)
    })
  })
  return done
}

describe('FrameEncoder / FrameDecoder', () => {
  it('decodes a single frame written at once', async () => {
    const decoder = new FrameDecoder()
    const done = collect(decoder)
    decoder.write(encodeFrame(Buffer.from('hello'), FrameType.json))
    decoder.end()
    const frames = await done
    expect(frames).toHaveLength(1)
    expect(frames[0]!.type).toBe(FrameType.json)
    expect(frames[0]!.payload.toString('utf8')).toBe('hello')
  })

  it('reassembles a frame split across many partial chunks', async () => {
    const decoder = new FrameDecoder()
    const done = collect(decoder)
    const frame = encodeFrame(Buffer.from('x'.repeat(1000)), FrameType.binary)
    // หั่นทีละ 7 bytes — ข้ามขอบเขต header ด้วย
    for (let i = 0; i < frame.length; i += 7) {
      decoder.write(frame.subarray(i, i + 7))
    }
    decoder.end()
    const frames = await done
    expect(frames).toHaveLength(1)
    expect(frames[0]!.type).toBe(FrameType.binary)
    expect(frames[0]!.payload.toString('utf8')).toBe('x'.repeat(1000))
  })

  it('splits multiple frames coalesced into a single chunk', async () => {
    const decoder = new FrameDecoder()
    const done = collect(decoder)
    const coalesced = Buffer.concat([
      encodeFrame(Buffer.from('one')),
      encodeFrame(Buffer.from('two')),
      encodeFrame(Buffer.from('three'))
    ])
    decoder.write(coalesced)
    decoder.end()
    const frames = await done
    expect(frames.map((f) => f.payload.toString('utf8'))).toEqual(['one', 'two', 'three'])
  })

  it('destroys the stream when the declared size exceeds MAX_FRAME_SIZE (DoS guard)', async () => {
    const decoder = new FrameDecoder()
    const done = collect(decoder)
    const header = Buffer.alloc(5)
    header.writeUInt32BE(MAX_FRAME_SIZE, 0) // ประกาศความยาวเกินลิมิต
    decoder.write(header)
    decoder.end()
    const frames = await done
    expect(frames).toHaveLength(1)
    expect(frames[0]!.type).toBe(-1)
    expect(frames[0]!.payload.toString('utf8')).toBe('FRAME_TOO_LARGE')
  })

  it('errors on a truncated final frame', async () => {
    const source = new PassThrough()
    const decoder = new FrameDecoder()
    const done = collect(decoder)
    source.pipe(decoder)
    // ประกาศ payload 100 bytes แต่ส่งมาแค่ 3 bytes แล้วปิด stream
    const header = Buffer.alloc(5)
    header.writeUInt32BE(100, 0)
    source.write(Buffer.concat([header, Buffer.from('abc')]))
    setTimeout(() => source.end(), 10)
    const frames = await done
    expect(frames.some((f) => f.type === -1 && f.payload.toString('utf8') === 'INCOMPLETE_FRAME')).toBe(true)
  })
})

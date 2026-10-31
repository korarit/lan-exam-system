import { describe, expect, it, afterEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import {
  checkRuntime,
  setCustomSdkPath,
  getCustomSdkPath,
  clearCustomSdkPaths,
  getRuntimePathEntries
} from './runtime-locator'

/** หาโฟลเดอร์ที่มี binary `node` จริงจาก PATH (ทดสอบไม่ผูกกับ electron) */
function findNodeDir(): string | null {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue
    if (fs.existsSync(path.join(dir, exe))) return dir
  }
  return null
}

describe('runtime-locator custom SDK path (Phase 9.1)', () => {
  afterEach(() => {
    clearCustomSdkPaths()
  })

  it('โฟลเดอร์ที่มี node binary จริง → found พร้อม path เต็ม', async () => {
    const nodeDir = findNodeDir() ?? path.dirname(process.execPath)
    setCustomSdkPath('node', nodeDir)
    expect(getCustomSdkPath('node')).toBe(nodeDir)
    const info = await checkRuntime('node')
    expect(info.found).toBe(true)
    expect(info.path).toContain(nodeDir)
  })

  it('โฟลเดอร์ว่าง (ไม่มี binary) → fallback ไป PATH ตามปกติ', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'zt-empty-sdk-'))
    setCustomSdkPath('python', emptyDir)
    const info = await checkRuntime('python')
    // ถ้าเครื่อง test มี python ใน PATH จะเจอผ่าน fallback, ถ้าไม่มีก็ไม่เจอ — ทั้งสองแบบต้องไม่ throw
    expect(typeof info.found).toBe('boolean')
  })

  it('getRuntimePathEntries คืนเฉพาะโฟลเดอร์ที่มีอยู่จริง', () => {
    const nodeDir = findNodeDir() ?? path.dirname(process.execPath)
    setCustomSdkPath('node', nodeDir)
    setCustomSdkPath('go', '/path/that/does/not/exist-zt')
    expect(getRuntimePathEntries(['node', 'go', 'rust'])).toEqual([nodeDir])
  })

  it('clear ล้างทั้งหมด', () => {
    setCustomSdkPath('node', '/tmp')
    clearCustomSdkPaths()
    expect(getCustomSdkPath('node')).toBeUndefined()
    expect(getRuntimePathEntries(['node'])).toEqual([])
  })
})

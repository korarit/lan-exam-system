import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  VsCodeController,
  VsCodeIntegrityWatchdog,
  buildLockedSettings,
  findVsCodeBinary,
  isControlledVsCodeCommand,
  type ControlledProfile,
  type RogueProcessSnapshot
} from './vscode-controller'
import type { DetectionEvent } from '@shared/policy-schema'

/* ============================================================
 * VsCodeIntegrityWatchdog (Phase 5 — checklist 4.1)
 * จำลองการแก้ settings.json / เพิ่มไฟล์ใน extensions ระหว่างสอบ
 * → ต้องจับได้ในรอบ scan ถัดไปทันทีไม่เกินหนึ่งรอบ
 * ============================================================ */

describe('isControlledVsCodeCommand', () => {
  const profile = { userDataDir: '/tmp/zt-profile/user-data', extensionsDir: '/tmp/zt-profile/extensions' }

  it('ต้องตรงทั้ง user-data-dir และ extensions-dir (ขาด extensions-dir ไม่ผ่าน)', () => {
    expect(isControlledVsCodeCommand('code --user-data-dir=/tmp/zt-profile/user-data --extensions-dir=/tmp/zt-profile/extensions', profile)).toBe(true)
    expect(isControlledVsCodeCommand('code --user-data-dir=/tmp/zt-profile/user-data', profile)).toBe(false)
    expect(isControlledVsCodeCommand('code --user-data-dir=/tmp/zt-profile/user-data --extensions-dir=/tmp/evil', profile)).toBe(false)
    expect(isControlledVsCodeCommand('code --user-data-dir=/tmp/zt-profile/user-data-rogue', profile)).toBe(false)
  })
})

describe('buildLockedSettings', () => {
  it('ล็อก proxy + ปิด AI ตามแผน Phase 5', () => {
    const settings = JSON.parse(buildLockedSettings(54123))
    expect(settings['http.proxy']).toBe('http://127.0.0.1:54123')
    expect(settings['extensions.autoUpdate']).toBe(false)
    expect(settings['inlineChat.enabled']).toBe(false)
    expect(settings['github.copilot.enable']).toMatchObject({ '*': false })
    expect(settings['telemetry.telemetryLevel']).toBe('off')
  })
})

describe('VsCodeIntegrityWatchdog', () => {
  let profile: ControlledProfile | null
  let events: DetectionEvent[]
  let fakeProcesses: RogueProcessSnapshot[]
  let watchdog: VsCodeIntegrityWatchdog

  const now = () => 1_700_000_000_000

  async function prepare(): Promise<ControlledProfile> {
    const unique = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const rootDir = path.join(os.tmpdir(), `ztwatch-${unique}`)
    const userDataDir = path.join(rootDir, 'user-data')
    const extensionsDir = path.join(rootDir, 'extensions')
    const workspaceDir = path.join(rootDir, 'workspace')
    await fsp.mkdir(path.join(userDataDir, 'User'), { recursive: true })
    await fsp.mkdir(extensionsDir, { recursive: true })
    await fsp.mkdir(workspaceDir, { recursive: true })
    await fsp.writeFile(path.join(userDataDir, 'User', 'settings.json'), buildLockedSettings(54123), 'utf8')
    return { root: rootDir, userDataDir, extensionsDir, workspaceDir }
  }

  beforeEach(async () => {
    profile = await prepare()
    events = []
    fakeProcesses = []
    watchdog = new VsCodeIntegrityWatchdog({
      getProfile: () => profile,
      emit: (event) => events.push(event),
      listProcesses: () => Promise.resolve(fakeProcesses),
      now
    })
  })

  afterEach(async () => {
    watchdog.stop()
    if (profile?.root && fs.existsSync(profile.root)) {
      await fsp.rm(profile.root, { recursive: true, force: true })
    }
  })

  it('รอบแรกตั้ง baseline — ไม่มี event', async () => {
    await watchdog.scanOnce()
    expect(events).toHaveLength(0)
  })

  it('แก้ settings.json ระหว่างสอบ → VSCODE_PROFILE_TAMPERED (settings-modified)', async () => {
    await watchdog.scanOnce()
    const settingsPath = path.join(profile!.userDataDir, 'User', 'settings.json')
    await fsp.writeFile(settingsPath, buildLockedSettings(99999), 'utf8')
    await watchdog.scanOnce()
    const tampered = events.filter((event) => event.code === 'VSCODE_PROFILE_TAMPERED')
    expect(tampered).toHaveLength(1)
    expect(tampered[0]!.detail.kind).toBe('settings-modified')
    expect(tampered[0]!.severity).toBe('critical')
    // แก้เพิ่มอีกครั้ง (baseline อัปเดตแล้ว) → event รอบถัดไปได้อีก
    await fsp.writeFile(settingsPath, '{}', 'utf8')
    await watchdog.scanOnce()
    expect(events.filter((event) => event.code === 'VSCODE_PROFILE_TAMPERED')).toHaveLength(2)
  })

  it('แอบเพิ่มโฟลเดอร์ Extension ใหม่ → VSCODE_PROFILE_TAMPERED (extensions-changed) (checklist 4.1)', async () => {
    await watchdog.scanOnce()
    await fsp.mkdir(path.join(profile!.extensionsDir, 'ms-toolsai.some-ai-ext'), { recursive: true })
    await fsp.writeFile(
      path.join(profile!.extensionsDir, 'ms-toolsai.some-ai-ext', 'package.json'),
      '{"name":"some-ai-ext"}',
      'utf8'
    )
    await watchdog.scanOnce()
    const tampered = events.filter((event) => event.code === 'VSCODE_PROFILE_TAMPERED')
    expect(tampered).toHaveLength(1)
    expect(tampered[0]!.detail.kind).toBe('extensions-changed')
  })

  it('VULN-58: แก้ .vscode/settings.json ใน workspace → VSCODE_PROFILE_TAMPERED (workspace-config-modified)', async () => {
    await watchdog.scanOnce()
    const vscodeDir = path.join(profile!.workspaceDir, '.vscode')
    await fsp.mkdir(vscodeDir, { recursive: true })
    await fsp.writeFile(path.join(vscodeDir, 'settings.json'), '{"http.proxy":""}', 'utf8')
    await watchdog.scanOnce()
    const tampered = events.filter((event) => event.code === 'VSCODE_PROFILE_TAMPERED')
    expect(tampered).toHaveLength(1)
    expect(tampered[0]!.detail.kind).toBe('workspace-config-modified')
  })

  it('โปรเซส VS Code ที่ไม่ใช่โปรไฟล์ของเรา → UNAUTHORIZED_IDE_DETECTED', async () => {
    await watchdog.scanOnce()
    fakeProcesses = [
      { exeName: process.platform === 'win32' ? 'code.exe' : 'code', commandLine: 'C:\\Tools\\Code.exe --user-data-dir=C:\\Users\\hacker\\code-profile' }
    ]
    await watchdog.scanOnce()
    const rogue = events.filter((event) => event.code === 'UNAUTHORIZED_IDE_DETECTED')
    expect(rogue).toHaveLength(1)
    expect(rogue[0]!.detail.kind).toBe('vscode-outside-profile')
  })

  it('VS Code ในโปรไฟล์ควบคุม = ปกติ (ไม่มี event)', async () => {
    await watchdog.scanOnce()
    fakeProcesses = [{
      exeName: process.platform === 'win32' ? 'code.exe' : 'code',
      commandLine: `--user-data-dir=${profile!.userDataDir} --extensions-dir=${profile!.extensionsDir}`
    }]
    await watchdog.scanOnce()
    expect(events.filter((event) => event.code === 'UNAUTHORIZED_IDE_DETECTED')).toHaveLength(0)
  })

  it('โปรไฟล์ควบคุมจริงแต่ --extensions-dir ชี้ที่อื่น → UNAUTHORIZED_IDE_DETECTED', async () => {
    await watchdog.scanOnce()
    fakeProcesses = [{
      exeName: process.platform === 'win32' ? 'code.exe' : 'code',
      commandLine: `--user-data-dir=${profile!.userDataDir} --extensions-dir=${profile!.root}-rogue`
    }]
    await watchdog.scanOnce()
    expect(events.filter((event) => event.code === 'UNAUTHORIZED_IDE_DETECTED')).toHaveLength(1)
  })

  it('path ที่มีคำว่า ztexam/lan-exam-system ไม่ได้รับการยกเว้นแล้ว', async () => {
    await watchdog.scanOnce()
    fakeProcesses = [{
      exeName: process.platform === 'win32' ? 'code.exe' : 'code',
      commandLine: 'C:\\work\\lan-exam-system\\ztexam\\code.exe'
    }]
    await watchdog.scanOnce()
    expect(events.filter((event) => event.code === 'UNAUTHORIZED_IDE_DETECTED')).toHaveLength(1)
  })

  it('Cursor / Windsurf = UNAUTHORIZED_IDE_DETECTED (ai-editor)', async () => {
    await watchdog.scanOnce()
    fakeProcesses = [{ exeName: 'cursor.exe', commandLine: '' }]
    await watchdog.scanOnce()
    const rogue = events.filter((event) => event.code === 'UNAUTHORIZED_IDE_DETECTED')
    expect(rogue).toHaveLength(1)
    expect(rogue[0]!.detail.kind).toBe('ai-editor')
  })
})

describe('VsCodeController.prepareProfile', () => {
  /**
   * ทดสอบโดยไม่ spawn VS Code จริง — เช็คเฉพาะโครงเตรียมโปรไฟล์
   */
  it('เตรียมโปรไฟล์ครบ (user-data / extensions / workspace) + settings ถูกต้อง', async () => {
    const events: DetectionEvent[] = []
    const controller = new VsCodeController({
      emit: (event) => events.push(event),
      now: () => 1_700_000_000_000
    })
    const result = await controller.prepareProfile('room-abc', 12345)
    expect(result.ok).toBe(true)
    const root = controller.profileRootDir!
    const settingsPath = path.join(root, 'user-data', 'User', 'settings.json')
    expect(fs.existsSync(settingsPath)).toBe(true)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(settings['http.proxy']).toBe('http://127.0.0.1:12345')
    expect(fs.existsSync(path.join(root, 'extensions'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'workspace'))).toBe(true)
    controller.stop()
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('proxy ยังไม่ทำงาน (port 0) → ปฏิเสธเตรียมโปรไฟล์', async () => {
    const controller = new VsCodeController({ emit: () => {} })
    const result = await controller.prepareProfile('room-xyz', 0)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('PROXY_NOT_RUNNING')
  })
})

describe('findVsCodeBinary', () => {
  it('คืน null เมื่อไม่ติดตั้ง (หรือแค่คืน string ตอนมี) — ห้าม throw', () => {
    const result = findVsCodeBinary()
    expect(result === null || result.endsWith('.exe') || result.includes('code')).toBe(true)
  })
})

import { platform } from 'node:process'
import type { DetectionEvent } from '@shared/policy-schema'
import { parseJsonLines, runPowerShell } from './system-probes'
import { makeDetectionEvent } from './process-inspector'

/* ============================================================
 * OverlayInspector — จับโปรแกรมโกงยุคใหม่ที่:
 * 1) ลอยทับหน้าจอข้อสอบแบบ topmost + click-through (blur ไม่ทำงาน)
 * 2) ซ่อนตัวเองจากการจับภาพหน้าจอ (WDA_EXCLUDEFROMCAPTURE)
 * รันบน Windows ผ่าน EnumWindows ใน PowerShell probe —
 * แพลตฟอร์มอื่นรายงานสถานะ unsupported (Phase 4 จะเติม native addon)
 * ============================================================ */

export const WDA_NONE = 0x0
export const WDA_MONITOR = 0x1
export const WDA_EXCLUDEFROMCAPTURE = 0x11

const WS_EX_TOPMOST = 0x8
const WS_EX_TRANSPARENT = 0x20
const WS_EX_LAYERED = 0x80000

/** หน้าต่างของ OS ที่ยอมรับได้ (shell ของระบบ ไม่ใช่ overlay ของผู้สอบ) */
const OS_WHITELIST_EXES = new Set([
  'explorer.exe',
  'applicationframehost.exe',
  'textinputhost.exe',
  'shellexperiencehost.exe',
  'searchhost.exe',
  'startmenuexperiencehost.exe',
  'systemsettings.exe',
  'taskbar.exe'
])

export interface WindowInspection {
  pid: number
  exeName: string
  title: string
  exStyle: number
  displayAffinity: number
  left: number
  top: number
  right: number
  bottom: number
}

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/**
 * จำแนกหน้าต่างต้องสงสัย (pure — ทดสอบได้ไม่พึ่ง OS)
 * - capture evasion → CRITICAL สูงสุด (โปรแกรมปกติไม่ซ่อนตัวจากการจับภาพในห้องสอบ)
 * - topmost overlay ทับหน้าจอข้อสอบ (โดยเฉพาะแบบ click-through) → CRITICAL
 */
export function classifyWindows(
  windows: WindowInspection[],
  examBounds: Rect | null,
  ownPid: number
): DetectionEvent[] {
  const events: DetectionEvent[] = []
  for (const win of windows) {
    if (win.pid === ownPid) continue
    if (OS_WHITELIST_EXES.has(win.exeName)) continue
    const bounds: Rect = { left: win.left, top: win.top, right: win.right, bottom: win.bottom }
    if (win.displayAffinity === WDA_EXCLUDEFROMCAPTURE || win.displayAffinity === WDA_MONITOR) {
      events.push(
        makeDetectionEvent('CAPTURE_EVADING_WINDOW_DETECTED', 'overlay-inspector', {
          pid: String(win.pid),
          processName: win.exeName,
          title: win.title.slice(0, 120),
          displayAffinity: `0x${win.displayAffinity.toString(16)}`
        })
      )
      continue
    }
    const topmost = (win.exStyle & WS_EX_TOPMOST) !== 0
    const clickThrough = (win.exStyle & WS_EX_TRANSPARENT) !== 0
    const layered = (win.exStyle & WS_EX_LAYERED) !== 0
    if (topmost && examBounds && overlaps(bounds, examBounds)) {
      // หน้าต่าง topmost ที่ไม่ click-through (เช่น dialog จาก OS) ยังเป็นได้ทั้งสองทาง —
      // โปร่งใสคลิกทะลุ = ลักษณะเฉพาะของ overlay โกง จึงน้ำหนักสูงสุด
      if (clickThrough || layered) {
        events.push(
          makeDetectionEvent('TOPMOST_OVERLAY_WINDOW_DETECTED', 'overlay-inspector', {
            pid: String(win.pid),
            processName: win.exeName,
            title: win.title.slice(0, 120),
            clickThrough: String(clickThrough),
            layered: String(layered)
          })
        )
      }
    }
  }
  return events
}

interface PsWindowLine {
  pid: number
  exe?: string
  title?: string
  exStyle?: number
  affinity?: number
  left?: number
  top?: number
  right?: number
  bottom?: number
}

const WINDOW_ENUM_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class ZTWindowEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] static extern int SetWindowLongW(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public static List<object> Scan() {
    var results = new List<object>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      uint affinity; GetWindowDisplayAffinity(hWnd, out affinity);
      var sb = new StringBuilder(256); GetWindowTextW(hWnd, sb, 256);
      RECT r; GetWindowRect(hWnd, out r);
      var exStyle = (long)GetWindowLongW(hWnd, -20);
      results.Add(new {
        pid = (int)pid,
        exStyle = exStyle,
        affinity = affinity,
        left = r.Left, top = r.Top, right = r.Right, bottom = r.Bottom,
        title = sb.ToString()
      });
      return true;
    }, IntPtr.Zero);
    return results;
  }
}
"@
[ZTWindowEnum]::Scan() | ForEach-Object { $exe = ''; try { $p = Get-Process -Id $_.pid -ErrorAction Stop; $exe = $p.ProcessName } catch {}; $_ | Select-Object @{n='exe';e={$exe + '.exe'}}, * | ConvertTo-Json -Compress }
`

export interface OverlayInspectorOptions {
  /** ขอบเขตหน้าต่างข้อสอบ (จาก BrowserWindow.getBounds()) */
  getExamBounds: () => Rect | null
  emit: (event: DetectionEvent) => void
  now?: () => number
}

export class OverlayInspector {
  readonly detectorId = 'overlay-inspector'
  private readonly now: () => number
  private lastScanAtMs = 0

  constructor(private readonly opts: OverlayInspectorOptions) {
    this.now = opts.now ?? Date.now
  }

  getLastTickAtMs(): number {
    return this.lastScanAtMs
  }

  start(): void {}

  stop(): void {}

  /** สแกนหน้าต่างทั้งระบบหนึ่งรอบ (Windows เท่านั้น — อื่น ๆ ข้ามแบบเงียบ) */
  async scanOnce(): Promise<DetectionEvent[]> {
    this.lastScanAtMs = this.now()
    if (platform !== 'win32') {
      // macOS/Linux ต้องใช้ native addon (Phase 4) — ยังไม่ฟ้องเพื่อกัน false positive
      return []
    }
    const output = await runPowerShell(WINDOW_ENUM_SCRIPT).catch(() => '')
    if (!output) return []
    const lines = parseJsonLines<PsWindowLine>(output)
    const windows: WindowInspection[] = lines
      .filter((l) => typeof l.pid === 'number' && l.pid > 0)
      .map((l) => ({
        pid: l.pid,
        exeName: (l.exe ?? '').toLowerCase(),
        title: l.title ?? '',
        exStyle: l.exStyle ?? 0,
        displayAffinity: l.affinity ?? 0,
        left: l.left ?? 0,
        top: l.top ?? 0,
        right: l.right ?? 0,
        bottom: l.bottom ?? 0
      }))
    const events = classifyWindows(windows, this.opts.getExamBounds(), process.pid)
    for (const event of events) this.opts.emit(event)
    return events
  }
}

import vm from 'node:vm'
import { JSDOM, VirtualConsole } from 'jsdom'

/* ============================================================
 * Phase 10 (ค้างจาก Phase 9) — HeadlessDomRunner (jsdom + vm timeout)
 * รัน bundle ของนักเรียน + assertionScript ของครูใน DOM จริงแบบ headless
 * - ใช้ได้ทั้งใน Electron Main (grading) และ vitest (ไม่ต้องมี BrowserWindow)
 * - กัน infinite loop ด้วย vm timeout (sync) + wall-clock race (async)
 * - ไม่โหลดทรัพยากรภายนอก (offline 100%) — ไม่มีเน็ตให้ใช้อยู่แล้ว
 *
 * Assertion API (ดู HttpApiDbCheckSchema? — ดู DomTestCaseSchema ใน shared):
 *   document / window — DOM จริง, assert(cond, msg?), click(selector)
 * ============================================================ */

export interface DomRunResult {
  testId: string
  passed: boolean | null
  note: string
  consoleLogs: string[]
  durationMs: number
}

const BUNDLE_TIMEOUT_MS = 15_000
const FLUSH_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** ดึง message จาก error ข้าม vm realm (instanceof ใช้ไม่ได้) */
function errMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string' && m.length > 0) return m
  }
  if (err instanceof Error && err.message.length > 0) return err.message
  try {
    return String(err).slice(0, 300)
  } catch {
    return 'unknown'
  }
}

export async function runDomTest(opts: {
  testId: string
  bundleJs: string
  documentHtml: string
  assertionScript: string
  timeoutMs: number
}): Promise<DomRunResult> {
  const started = Date.now()
  const logs: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('log', (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(' ').slice(0, 500))
  })
  virtualConsole.on('error', (...args: unknown[]) => {
    logs.push(`[error] ${args.map((a) => String(a)).join(' ').slice(0, 500)}`)
  })
  virtualConsole.on('jsdomError', (err: unknown) => {
    logs.push(`[jsdom] ${err instanceof Error ? err.message.slice(0, 300) : 'script error'}`)
  })

  let dom: JSDOM
  try {
    dom = new JSDOM(opts.documentHtml, {
      url: 'http://127.0.0.1/',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole
    })
  } catch (err) {
    return {
      testId: opts.testId,
      passed: false,
      note: `⛔ สร้าง DOM ไม่ได้: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
      consoleLogs: [],
      durationMs: Date.now() - started
    }
  }

  const ctx = vm.createContext(dom.window as unknown as vm.Context)
  try {
    // helpers + shims ก่อนรัน bundle ของนักเรียน
    vm.runInContext(
      `var process = { env: { NODE_ENV: 'production' } };
       function assert(cond, message) { if (!cond) throw new Error('assert failed' + (message ? ': ' + message : '')); }
       async function click(selector) {
         var el = document.querySelector(selector);
         if (!el) throw new Error('click: not found ' + selector);
         el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
         await new Promise(function (r) { setTimeout(r, 50); });
       }`,
      ctx,
      { timeout: 2000, filename: 'ztcode-harness.js' }
    )
    // รัน bundle (กัน infinite loop ด้วย vm timeout)
    vm.runInContext(opts.bundleJs, ctx, { timeout: BUNDLE_TIMEOUT_MS, filename: 'student-bundle.js' })
  } catch (err) {
    const message = errMessage(err)
    const timedOut = /timed out|Script execution timed out/i.test(message)
    return {
      testId: opts.testId,
      passed: false,
      note: timedOut
        ? '⏳ bundle ของนักเรียนรันไม่จบใน 15 วินาที (ตัดจบแล้ว — สงสัย infinite loop)'
        : `❌ bundle รันพัง: ${message.slice(0, 300)}`,
      consoleLogs: logs.slice(0, 20),
      durationMs: Date.now() - started
    }
  }

  // ปล่อยให้ React concurrent render flush (rAF + microtasks)
  await sleep(FLUSH_MS)
  try {
    const raf = (dom.window as unknown as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame
    if (typeof raf === 'function') {
      await new Promise<void>((resolve) => {
        raf.call(dom.window, () => resolve())
      })
    }
  } catch {
    /* ไม่มี rAF — ข้าม */
  }

  try {
    const wrapped = `;(async () => { ${opts.assertionScript} })()`
    const pending = vm.runInContext(wrapped, ctx, {
      timeout: opts.timeoutMs,
      filename: 'assertion.js'
    }) as unknown
    // Promise เกิดใน vm realm ใหม่ — instanceof ของ main realm ใช้ไม่ได้ ต้อง duck-type
    const isThenable = (v: unknown): v is Promise<unknown> =>
      typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'
    if (isThenable(pending) && typeof (pending as Promise<unknown>).catch === 'function') {
      await Promise.race([
        pending,
        sleep(opts.timeoutMs + 1000).then(() => {
          throw new Error('ASSERT_TIMEOUT')
        })
      ])
    }
    return {
      testId: opts.testId,
      passed: true,
      note: '✅ ผ่าน',
      consoleLogs: logs.slice(0, 20),
      durationMs: Date.now() - started
    }
  } catch (err) {
    const message = errMessage(err)
    return {
      testId: opts.testId,
      passed: false,
      note:
        message === 'ASSERT_TIMEOUT' || /timed out/i.test(message)
          ? `⏱️ assertion ไม่จบใน ${opts.timeoutMs}ms (ตัดจบแล้ว)`
          : `❌ ${message.slice(0, 300)}`,
      consoleLogs: logs.slice(0, 20),
      durationMs: Date.now() - started
    }
  } finally {
    try {
      dom.window.close()
    } catch {
      /* ปิดไม่ได้ — GC จัดการ */
    }
  }
}

/** HTML ตั้งต้นสำหรับตรวจ: html-css-js ใช้ไฟล์ entry ของนักเรียน, React ใช้ root container */
export function documentHtmlFor(entryHtmlContent: string | null, title: string): string {
  if (entryHtmlContent !== null) return entryHtmlContent
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><div id="root"></div></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

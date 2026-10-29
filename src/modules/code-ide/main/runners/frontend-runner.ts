/* Phase 9 (9.4.2) — Frontend Bundler (offline esbuild)
 * รวมโปรเจกต์หลายไฟล์/โฟลเดอร์ของนักเรียนเป็น bundle เดียวโดยไม่ต่อเน็ต
 */

export interface FrontendBundleResult {
  ok: boolean
  outputJs?: string | undefined
  errors?: string | undefined
  note: string
}

export async function bundleFrontend(
  entryPointAbs: string,
  opts: { absWorkingDir?: string; minify?: boolean; nodePaths?: string[] } = {}
): Promise<FrontendBundleResult> {
  try {
    // dynamic resolve ผ่าน createRequire — ไม่ผูก static import (esbuild อาจยังไม่ถูก npm install ในบางเครื่อง)
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-require-imports
    const esbuild = require('esbuild') as { build: (o: Record<string, unknown>) => Promise<{ outputFiles?: Array<{ text: string }> }> }
    const { build } = esbuild
    const result = await build({
      entryPoints: [entryPointAbs],
      bundle: true,
      write: false,
      minify: opts.minify ?? false,
      format: 'iife',
      platform: 'browser',
      absWorkingDir: opts.absWorkingDir || undefined,
      // offline vendor libs ของครู (DependencyBundle) — resolve ได้โดยไม่ต่อเน็ต
      ...(opts.nodePaths !== undefined && opts.nodePaths.length > 0 ? { nodePaths: opts.nodePaths } : {}),
      loader: { '.ts': 'ts', '.tsx': 'tsx', '.jsx': 'jsx', '.css': 'css' },
      logLevel: 'silent'
    })
    const js = result.outputFiles?.[0]?.text ?? ''
    return { ok: true, outputJs: js, note: `bundle สำเร็จ (${js.length} chars)` }
  } catch (err) {
    return { ok: false, errors: err instanceof Error ? err.message : 'bundle failed', note: 'esbuild bundle ไม่สำเร็จ — ตรวจ import path / syntax' }
  }
}

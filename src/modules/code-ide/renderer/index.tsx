import { useEffect, useState } from 'react'
import type { RendererExamModuleUI, StudentWorkspaceProps } from '@shared/module-contract'
import { CODE_IDE_METADATA } from '../shared/module-metadata'
import CodeExamBuilder from './builder/CodeExamBuilder'
import CodeSubmissionsTable from './responses/CodeSubmissionsTable'
import StudentCodeIdeWorkspace from './student/StudentCodeIdeWorkspace'
import { StudentCodePackageViewSchema } from '../shared/code-schema'

/* ============================================================
 * Renderer side ของโมดูล code-ide
 * Phase 8: HostBuilderView (Problem Builder เต็ม) +
 *          StudentExamWorkspace (Project IDE Workspace เต็ม)
 * Phase 9/10: ผูก Runtime + Hidden Grader ผ่าน props เดิม
 * ============================================================ */

function CodeIdeStudentEntry(props: StudentWorkspaceProps): React.JSX.Element {
  // F-3 fix: เดิม parse ด้วย CodeExamPackageSchema ทำให้ sampleTests หลุด + deps ไม่ผ่าน
  // (stripped view ไม่มี testCases/blob) → ใช้ StudentCodePackageViewSchema โดยเฉพาะ
  const parsed = StudentCodePackageViewSchema.safeParse(props.moduleState)
  const [bundleNote, setBundleNote] = useState<string | null>(null)
  // F-3: แคช DependencyBundle blobs ลงเครื่องตัวเองครั้งเดียวต่อโจทย์ (รัน sample ด้วย lib จริงได้ออฟไลน์)
  const bundleKey =
    parsed.success && parsed.data.bundleBlobs !== undefined && parsed.data.bundleBlobs.length > 0
      ? `${parsed.data.packageId}:${parsed.data.bundleBlobs.length}`
      : null
  useEffect(() => {
    if (!parsed.success || bundleKey === null) return
    const pkg = parsed.data
    if (pkg.bundleBlobs === undefined || pkg.bundleBlobs.length === 0) return
    const zt = window.ztExam
    if (typeof zt.cacheStudentBundles !== 'function') return
    void (async () => {
      try {
        const res = await zt.cacheStudentBundles({
          packageId: pkg.packageId,
          dependencies: pkg.dependencies,
          blobs: pkg.bundleBlobs ?? []
        })
        if (!res.ok) {
          setBundleNote(`⚠️ แคชไลบรารีเสริมไม่สำเร็จ (${res.reason ?? 'unknown'}) — รันด้วย runtime เครื่องตัวเองล้วน`)
        } else if (res.unsupported.length > 0) {
          setBundleNote(`⚠️ ไลบรารีบางชุดใช้ไม่ได้: ${res.unsupported.slice(0, 2).join('; ')}`)
        } else {
          setBundleNote(null)
        }
      } catch {
        setBundleNote('⚠️ แคชไลบรารีเสริมไม่สำเร็จ — รันด้วย runtime เครื่องตัวเองล้วน')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleKey])
  if (!parsed.success) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center">
        <h2 className="font-semibold">Code IDE — รอโจทย์จากเครื่องแม่</h2>
        <p className="mt-2 text-sm text-slate-500">
          เมื่อครูเริ่มข้อสอบ โปรเจกต์ (.ztcode) จะปรากฏตรงนี้ — หรือเปิดดูตัวอย่างได้จากแท็บ Code IDE Builder ฝั่งครู
        </p>
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col">
      {bundleNote !== null && (
        <div className="mb-2 rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-1.5 text-center text-[11px] text-amber-200">
          {bundleNote}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <StudentCodeIdeWorkspace
          pkg={parsed.data}
          {...(props.studentId !== undefined ? { studentId: props.studentId } : {})}
          onAutosave={(entries) => props.onAutosaveDraft({ entries })}
          onSubmit={(entries) => void props.onDispatchAction({ type: 'code-ide.submit', entries })}
        />
      </div>
    </div>
  )
}

export const CODE_IDE_RENDERER_UI: RendererExamModuleUI = {
  metadata: CODE_IDE_METADATA,
  HostBuilderView: () => <CodeExamBuilder />,
  HostResponsesView: () => <CodeSubmissionsTable />,
  StudentExamWorkspace: (props: StudentWorkspaceProps) => <CodeIdeStudentEntry {...props} />
}

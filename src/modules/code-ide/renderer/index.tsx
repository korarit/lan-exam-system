import type { RendererExamModuleUI, StudentWorkspaceProps } from '@shared/module-contract'
import { CODE_IDE_METADATA } from '../shared/module-metadata'
import CodeExamBuilder from './builder/CodeExamBuilder'
import StudentCodeIdeWorkspace from './student/StudentCodeIdeWorkspace'
import { CodeExamPackageSchema } from '../shared/code-schema'

/* ============================================================
 * Renderer side ของโมดูล code-ide
 * Phase 8: HostBuilderView (Problem Builder เต็ม) +
 *          StudentExamWorkspace (Project IDE Workspace เต็ม)
 * Phase 9/10: ผูก Runtime + Hidden Grader ผ่าน props เดิม
 * ============================================================ */

function CodeIdeStudentEntry(props: StudentWorkspaceProps): React.JSX.Element {
  const parsed = CodeExamPackageSchema.safeParse(props.moduleState)
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
    <StudentCodeIdeWorkspace
      pkg={parsed.data}
      onAutosave={(entries) => props.onAutosaveDraft({ entries })}
      onSubmit={(entries) => void props.onDispatchAction({ type: 'code-ide.submit', entries })}
    />
  )
}

export const CODE_IDE_RENDERER_UI: RendererExamModuleUI = {
  metadata: CODE_IDE_METADATA,
  HostBuilderView: () => <CodeExamBuilder />,
  HostResponsesView: () => (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center">
      <h2 className="font-semibold">ผลตรวจ Code IDE (Phase 10)</h2>
      <p className="mt-2 text-sm text-slate-500">
        หน้าดูโค้ด / Diff / Code Playback + Export CSV มาพร้อม Hidden Grader ใน Phase 10
      </p>
    </div>
  ),
  StudentExamWorkspace: (props: StudentWorkspaceProps) => <CodeIdeStudentEntry {...props} />
}

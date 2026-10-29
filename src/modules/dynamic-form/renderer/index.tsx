import type { RendererExamModuleUI, StudentWorkspaceProps } from '@shared/module-contract'
import { DYNAMIC_FORM_METADATA } from '../shared/module-metadata'
import FormBuilderWorkspace from './builder/FormBuilderWorkspace'
import ResponsesDashboard from './responses/ResponsesDashboard'

/* ============================================================
 * Renderer side ของโมดูล dynamic-form
 * Phase 6: HostBuilderView (พร้อมใช้) + พรีวิวนักเรียน
 * Phase 7: ResponsesDashboard (Summary / By Question / Individual)
 * ============================================================ */

function Phase7StudentPlaceholder(props: StudentWorkspaceProps): React.JSX.Element {
  void props
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center">
      <h2 className="font-semibold">หน้าทำข้อสอบของนักเรียน (ภาคเชื่อมต่อเครื่องแม่)</h2>
      <p className="mt-2 text-sm text-slate-500">
        Backend ของโมดูล (Validator / File Vault / Auto-Grading / Export) พร้อมแล้วใน Phase 7 —
        ช่องทาง network ของนักเรียนจะต่อผ่านท่อ TLS ของระบบข้อสอบเดิม
      </p>
    </div>
  )
}

export const DYNAMIC_FORM_RENDERER_UI: RendererExamModuleUI = {
  metadata: DYNAMIC_FORM_METADATA,
  HostBuilderView: () => <FormBuilderWorkspace />,
  HostResponsesView: () => <ResponsesDashboard />,
  StudentExamWorkspace: (props: StudentWorkspaceProps) => <Phase7StudentPlaceholder {...props} />
}

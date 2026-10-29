import type { RendererExamModuleUI, StudentWorkspaceProps } from '@shared/module-contract'
import { DYNAMIC_FORM_METADATA } from '../main/form-module-backend'
import FormBuilderWorkspace from './builder/FormBuilderWorkspace'

/* ============================================================
 * Renderer side ของโมดูล dynamic-form
 * Phase 6: HostBuilderView (พร้อมใช้) + พรีวิวนักเรียน
 * Phase 7: HostResponsesView / StudentExamWorkspace แบบเต็มท่อเน็ต
 * ============================================================ */

function Phase7PlaceholderView(props: { scope: 'responses' | 'student' }): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center">
      <h2 className="font-semibold">
        {props.scope === 'responses' ? 'หน้าตรวจคำตอบและสถิติ' : 'หน้าทำข้อสอบของนักเรียน (ภาคเชื่อมต่อเครื่องแม่)'}
      </h2>
      <p className="mt-2 text-sm text-slate-500">
        ส่วนนี้จะเปิดใช้ใน Phase 7 (Backend, Auto-Grading & Export) — ตอนนี้ใช้{' '}
        {props.scope === 'responses' ? 'Export ผ่านหน้า Builder และตรวจแบบพรีวิว' : 'หน้าพรีวิวของครูเพื่อตรวจรูปแบบฟอร์ม'} ไปก่อน
      </p>
    </div>
  )
}

export const DYNAMIC_FORM_RENDERER_UI: RendererExamModuleUI = {
  metadata: DYNAMIC_FORM_METADATA,
  HostBuilderView: () => <FormBuilderWorkspace />,
  HostResponsesView: () => <Phase7PlaceholderView scope="responses" />,
  StudentExamWorkspace: (_props: StudentWorkspaceProps) => <Phase7PlaceholderView scope="student" />
}

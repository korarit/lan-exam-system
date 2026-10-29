import { z } from 'zod'
import type { RendererExamModuleUI, StudentWorkspaceProps } from '@shared/module-contract'
import { DYNAMIC_FORM_METADATA } from '../shared/module-metadata'
import type { StudentFormView } from '../shared/form-schema'
import FormBuilderWorkspace from './builder/FormBuilderWorkspace'
import ResponsesDashboard from './responses/ResponsesDashboard'
import DynamicFormStudentWorkspace from './student/DynamicFormStudentWorkspace'

/* ============================================================
 * Renderer side ของโมดูล dynamic-form
 * Phase 6: HostBuilderView (พร้อมใช้) + พรีวิวนักเรียน
 * Phase 7: ResponsesDashboard (Summary / By Question / Individual)
 * F-1: StudentExamWorkspace ตัวจริง — รับ stripped view จาก MODULE_STATE_PUSH
 *      แล้วส่งคำตอบผ่าน student:module-send (ExamView เป็นคนส่งต่อ)
 * ============================================================ */

/** ตรวจรูปทรง stripped view แบบหลวม ๆ (items ละเอียดอยู่ใน shared/student-view) */
const StudentViewShapeSchema = z
  .object({
    moduleId: z.literal('dynamic-form'),
    formId: z.string().min(1),
    title: z.string(),
    instructions: z.string(),
    items: z.array(z.unknown()).max(200)
  })
  .passthrough()

function DynamicFormStudentEntry(props: StudentWorkspaceProps): React.JSX.Element {
  const parsed = StudentViewShapeSchema.safeParse(props.moduleState)
  if (!parsed.success) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center">
        <h2 className="font-semibold">ฟอร์มข้อสอบ — รอโจทย์จากเครื่องแม่</h2>
        <p className="mt-2 text-sm text-slate-500">
          เมื่อครูเริ่มข้อสอบ ฟอร์มจะปรากฏตรงนี้ (stripped view ไม่มีเฉลย)
        </p>
      </div>
    )
  }
  return (
    <DynamicFormStudentWorkspace
      view={parsed.data as unknown as StudentFormView}
      {...(props.studentId !== undefined ? { studentId: props.studentId } : {})}
      onDispatchAction={props.onDispatchAction}
      onAutosaveDraft={props.onAutosaveDraft}
    />
  )
}

export const DYNAMIC_FORM_RENDERER_UI: RendererExamModuleUI = {
  metadata: DYNAMIC_FORM_METADATA,
  HostBuilderView: () => <FormBuilderWorkspace />,
  HostResponsesView: () => <ResponsesDashboard />,
  StudentExamWorkspace: (props: StudentWorkspaceProps) => <DynamicFormStudentEntry {...props} />
}

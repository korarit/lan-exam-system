import type { ComponentType } from 'react'

/** id ของ Exam Module ที่ระบบรองรับ (เพิ่มใหม่ได้โดยไม่ต้องแก้ core) */
export type ExamModuleId = 'dynamic-form' | 'code-ide' | 'external-url'

/** ข้อมูลอธิบายโมดูล ใช้ทั้งฝั่ง main และ renderer */
export interface ExamModuleMetadata {
  moduleId: ExamModuleId
  displayName: string
  description: string
  version: string
  /** นามสกุลไฟล์ข้อสอบของโมดูล เช่น '.ztform' หรือ '.ztcode' */
  fileExtension: string
  supportedSecurityModes: Array<'closed' | 'in-app-docs' | 'external-tools'>
}

/** บริบทการเริ่ม session ของนักเรียน 1 คน */
export interface StudentSessionContext<TPackage> {
  roomId: string
  studentId: string
  /** ค่า seed ต่อคน ใช้สุ่มลำดับข้อ/ตัวเลือกให้ต่างกัน */
  studentSeed: string
  examPackage: TPackage
}

export interface StudentActionResult<TClientState> {
  nextClientState?: TClientState
  progressText: string
  isFinished?: boolean
}

/**
 * สัญญาฝั่ง Main Process (Embedded Backend ของแต่ละโมดูล)
 * ทุกโมดูลต้อง implement interface นี้เพื่อเสียบเข้ากับ Core Platform
 */
export interface HostExamModuleBackend<
  TPackage = unknown,
  TClientState = unknown,
  TAction = unknown
> {
  readonly metadata: ExamModuleMetadata
  /** ตรวจความถูกต้องของแพ็กเกจข้อสอบ (throw ถ้าไม่ผ่าน) */
  validatePackage(rawPackage: unknown): TPackage
  initializeStudentSession(
    ctx: StudentSessionContext<TPackage>
  ): Promise<TClientState>
  handleStudentAction(ctx: {
    roomId: string
    studentId: string
    action: TAction
    /** เวลาอ้างอิงจากเครื่องแม่เท่านั้น (Host-authoritative) */
    serverTimestampMs: number
  }): Promise<StudentActionResult<TClientState>>
  handleAutosaveDraft(ctx: {
    roomId: string
    studentId: string
    draftPayload: unknown
    serverTimestampMs: number
  }): Promise<void>
  finalizeStudentSession(ctx: {
    roomId: string
    studentId: string
    reason: 'submitted' | 'time-up'
  }): Promise<void>
  exportResultsCsv(roomId: string): Promise<Uint8Array>
}

export interface StudentWorkspaceProps {
  /** state ล่าสุดที่ backend ส่งให้นักเรียนคนนี้ */
  moduleState: unknown
  onDispatchAction: (action: unknown) => Promise<void>
  onAutosaveDraft: (draft: unknown) => void
}

/** สัญญาฝั่ง Renderer (UI ของแต่ละโมดูล) */
export interface RendererExamModuleUI {
  readonly metadata: ExamModuleMetadata
  HostBuilderView: ComponentType<{ onSavePackage: (filePath: string) => void }>
  HostResponsesView: ComponentType<{ roomId: string }>
  StudentExamWorkspace: ComponentType<StudentWorkspaceProps>
}

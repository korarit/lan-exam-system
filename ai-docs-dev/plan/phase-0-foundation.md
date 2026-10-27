# Phase 0: Foundation, Scaffolding & Core Architecture

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
สร้างรากฐานโปรเจกต์ Desktop App ด้วย **Electron + TypeScript + React + Vite + Tailwind CSS** ที่มีโครงสร้างชัดเจน แยกส่วน Main / Preload / Renderer อย่างปลอดภัย มีระบบฐานข้อมูล SQLite พร้อมเข้ารหัสระดับฟิลด์ และมีหน้าจอสลับบทบาทระหว่าง **Host (ครู)** กับ **Student (นักเรียน)**

### สิ่งที่ต้องได้เมื่อจบ Phase 0
- โปรเจกต์รันคำสั่ง `npm run dev`, `npm run typecheck`, `npm run test`, และ `npm run build` ผ่านทั้งหมด
- โครงสร้างโฟลเดอร์ครบตามสถาปัตยกรรม
- IPC Bridge แบบ Type-safe พร้อมการตรวจสอบข้อมูลด้วย Zod
- โมดูล Cryptography พื้นฐาน (`node:crypto` wrapper) และฐานข้อมูล SQLite ที่ฝั่งเครื่องแม่พร้อมใช้งาน

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 0.1 Project Initialization & Tooling Setup
1. **สร้างโปรเจกต์ด้วย `electron-vite`:**
   - ตั้งค่า `electron.vite.config.ts` แยก build target 3 ส่วน:
     - `main`: Node.js environment (ESNext / CommonJS bundle สำหรับ native modules เช่น `better-sqlite3`)
     - `preload`: Sandboxed preload script
     - `renderer`: React 18 + Vite + Tailwind CSS
2. **ตั้งค่า TypeScript (`tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`):**
   - เปิด `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`
   - ตั้ง path aliases:
     - `@shared/*` -> `src/shared/*` (ใช้ร่วมกันทั้ง main, preload, renderer)
     - `@main/*` -> `src/main/*`
     - `@renderer/*` -> `src/renderer/src/*`
3. **ติดตั้ง Dependencies หลัก:**
   - Runtime/Core: `zod`, `zustand`, `lucide-react`, `better-sqlite3`, `selfsigned`, `systeminformation`
   - Dev/Build: `electron`, `electron-vite`, `electron-builder`, `@electron/fuses`, `tailwindcss`, `postcss`, `autoprefixer`, `vitest`, `@types/better-sqlite3`

---

### 0.2 Shared Domain Types, Pluggable Module Contract & Crypto Utilities (`src/shared/` & `src/main/crypto/`)
1. **สร้าง `src/shared/types/`:**
   - `role.ts`: `type AppRole = 'unselected' | 'host' | 'student'`
   - `exam.ts`: โครงสร้างข้อมูลพื้นฐานของห้องสอบ (`ExamMode`: `'closed' | 'in-app-docs' | 'external-tools'`, `EnforcementMode`: `'report-only' | 'block-and-report'`)
   - `events.ts`: ประเภทของ Audit Event และระดับความรุนแรง (`'normal' | 'warning' | 'critical'`)
2. **สร้างสัญญากลางสำหรับระบบโมดูล (`src/shared/module-contract.ts`):**
   ออกแบบให้รูปแบบการสอบเป็น **Pluggable Module** ตั้งแต่ต้น เพื่อให้ `dynamic-form` (Phase 6–7) หรือโมดูลในอนาคตอย่าง `code-ide` (ระบบสอบเขียนโปรแกรมด้วย IDE ภายในแอปใน Phase 8) เสียบเข้ากับ Core Platform ได้โดยไม่ต้องแก้ระบบเครือข่ายหรือระบบตรวจจับการโกง:
   ```ts
   export type ExamModuleId = 'dynamic-form' | 'code-ide' | 'external-url'

   export interface ExamModuleMetadata {
     moduleId: ExamModuleId
     displayName: string
     description: string
     version: string
     fileExtension: string // เช่น '.ztform' หรือ '.ztcode'
     supportedSecurityModes: Array<'closed' | 'in-app-docs' | 'external-tools'>
   }

   // สัญญาฝั่ง Main Process (Embedded Backend ของแต่ละโมดูล)
   export interface HostExamModuleBackend<TPackage = unknown, TClientState = unknown, TAction = unknown> {
     readonly metadata: ExamModuleMetadata
     validatePackage(rawPackage: unknown): TPackage
     initializeStudentSession(ctx: {
       roomId: string
       studentId: string
       studentSeed: string
       examPackage: TPackage
     }): Promise<TClientState>
     handleStudentAction(ctx: {
       roomId: string
       studentId: string
       action: TAction
       serverTimestampMs: number
     }): Promise<{ nextClientState?: TClientState; progressText: string; isFinished?: boolean }>
     handleAutosaveDraft(ctx: {
       roomId: string
       studentId: string
       draftPayload: unknown
       serverTimestampMs: number
     }): Promise<void>
     finalizeStudentSession(ctx: { roomId: string; studentId: string; reason: 'submitted' | 'time-up' }): Promise<void>
     exportResultsCsv(roomId: string): Promise<Buffer>
   }

   // สัญญาฝั่ง Renderer (UI ของแต่ละโมดูล)
   export interface RendererExamModuleUI {
     readonly metadata: ExamModuleMetadata
     HostBuilderView: React.ComponentType<{ onSavePackage: (filePath: string) => void }>
     HostResponsesView: React.ComponentType<{ roomId: string }>
     StudentExamWorkspace: React.ComponentType<{
       moduleState: unknown
       onDispatchAction: (action: unknown) => Promise<void>
       onAutosaveDraft: (draft: unknown) => void
     }>
   }
   ```
3. **สร้าง `src/main/crypto/primitives.ts`:**
   - ฟังก์ชันสร้างคีย์สุ่มด้วย CSPRNG (`crypto.randomBytes(32)`)
   - **AES-256-GCM Helper** สำหรับเข้ารหัส/ถอดรหัสข้อมูลตอนเก็บ (At-rest encryption) และเซกเมนต์วิดีโอ:
     - โครงสร้างข้อมูลที่เข้ารหัส: `{ iv: string (base64, 12 bytes), tag: string (base64, 16 bytes), ciphertext: string (base64) }`
   - **HMAC-SHA256 Helper** สำหรับตรวจสอบความถูกต้องของข้อความและคำตอบ (`computeHmac(key, payload)`, `verifyHmacTimingSafe(key, payload, mac)`) โดยใช้ `crypto.timingSafeEqual` เสมอ
   - **SHA-256 Hash Helper** สำหรับไฟล์และ Hash Chain (`sha256Hex(bufferOrString)`)
   - **Ed25519 Verify/Sign Helper** สำหรับตรวจสอบลายเซ็นของ Manifest และ Policy

---

### 0.3 Type-Safe IPC Architecture (`src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc/`)
1. **กำหนด IPC Contract (`src/shared/ipc-channels.ts`):**
   - แยกชัดเจนระหว่าง:
     - `IpcInvokeMap`: Renderer เรียก Main แบบ `ipcRenderer.invoke` (Request/Response)
     - `IpcEventMap`: Main ส่ง Event ไปหา Renderer แบบ `webContents.send` (Push Event)
2. **สร้าง IPC Router ที่ฝั่ง Main (`src/main/ipc/router.ts`):**
   - ห่อ `ipcMain.handle(channel, async (event, rawPayload) => ...)`
   - บังคับตรวจ `event.senderFrame` (รับเฉพาะจาก Main frame ของแอป ไม่รับจาก iframe หรือ `WebContentsView` ของเอกสารใน Mode 2)
   - บังคับ validate `rawPayload` ด้วย Zod schema ทุกครั้งก่อนเข้า handler
3. **สร้าง Preload Bridge (`src/preload/index.ts`):**
   - ใช้ `contextBridge.exposeInMainWorld('ztExam', api)`
   - ห้ามส่ง `ipcRenderer` ออกไปตรง ๆ เด็ดขาด ให้ส่งเฉพาะฟังก์ชันที่กำหนดไว้ และคืนค่าฟังก์ชัน `unsubscribe()` สำหรับทุก event listener เพื่อไม่ให้เกิด memory leak ใน React

---

### 0.4 Local Database & Encrypted Storage (`src/main/storage/`)
1. **ตั้งค่า SQLite (`src/main/storage/db.ts`):**
   - เก็บไฟล์ฐานข้อมูลไว้ที่ `app.getPath('userData')/zt-exam-host.sqlite`
   - เปิดใช้งาน `PRAGMA journal_mode = WAL;` และ `PRAGMA foreign_keys = ON;` เพื่อให้เขียนข้อมูลความเร็วสูงขณะรับคำตอบและ audit logs จากนักเรียนหลายคนพร้อมกัน
2. **สร้าง Migration Runner (`src/main/storage/migrations.ts`):**
   - เตรียมตารางพื้นฐาน:
     - `exam_sessions`: เก็บข้อมูลห้องสอบที่เปิด, โหมด, เวลาเริ่ม/จบ, salt ของการเข้ารหัส
     - `students`: รายชื่อนักเรียนที่เข้าร่วม, `student_id`, `display_name`, `seed`, `status`, `suspicion_score`
     - `submissions`: คำตอบรายข้อ (ฟิลด์คำตอบเข้ารหัสด้วย AES-256-GCM), `seq_no`, `hmac`, `received_at`
     - `audit_logs`: เก็บเหตุการณ์แบบ append-only (`id`, `session_id`, `student_id`, `timestamp`, `event_type`, `severity`, `payload_json`, `prev_hash`, `entry_hash`)

---

### 0.5 Application Window Manager, Multi-Instance Test Mode & Role Selection UI (`src/main/window.ts` & `src/renderer/`)
1. **Same-Machine Multi-Instance Isolation (รันเครื่องแม่และเครื่องลูกในคอมเครื่องเดียวกันได้):**
   - ก่อน `app.whenReady()` ให้อ่าน CLI flag `--profile=<id>` (เช่น `--profile=host`, `--profile=student-1`, `--profile=student-2`) และ `--role=host|student`
   - แยกโฟลเดอร์ `app.setPath('userData', path.join(defaultUserData, `instance-${profileId}`))` เพื่อไม่ให้ Chromium Cache, Cookies, และไฟล์ SQLite ชนกันเมื่อเปิดหลายหน้าต่างบนเครื่องเดียว
   - รองรับ flag `--windowed-kiosk` (สำหรับโหมดพัฒนา/ทดสอบในเครื่องเดียว): ให้หน้าต่างเครื่องนักเรียนแสดง Kiosk HUD และลายน้ำครบทุกอย่าง แต่อยู่ในกรอบหน้าต่างปกติที่วางคู่กับหน้าต่างเครื่องแม่แบบ Side-by-Side ได้โดยไม่ล็อกเต็มจอทับหน้าต่างเครื่องแม่
   - เพิ่มสคริปต์ใน `package.json`:
     - `npm run dev:host` -> เปิดหน้าต่างเครื่องแม่ (วางชิดซ้ายจอ)
     - `npm run dev:student` -> เปิดหน้าต่างเครื่องลูก (วางชิดขวาจอ)
     - `npm run dev:pair` -> เปิดทั้งเครื่องแม่และเครื่องลูกขึ้นมาพร้อมกันในเครื่องเดียว
2. **Window Manager (`src/main/window.ts`):**
   - สร้าง `BrowserWindow` หลักด้วยค่าเริ่มต้นที่ปลอดภัย:
     - `webPreferences: { preload: ..., nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: isDev }`
   - รองรับการสลับโหมดหน้าต่าง:
     - **Host Mode:** หน้าต่างปกติ ย่อ/ขยายได้ ขนาดเริ่มต้น `1280x800`
     - **Student Lobby Mode:** หน้าต่างขนาด `960x640` สำหรับค้นหาห้องและกรอก PIN
     - **Student Exam Kiosk Mode:** สลับเข้าสู่ `kiosk: true`, `fullscreen: true`, `alwaysOnTop: true` เมื่อเริ่มสอบ
2. **Renderer Shell & Zustand Store (`src/renderer/src/`):**
   - `store/app-store.ts`: เก็บ `role`, `connectionState`, `activeNotification`
   - `components/RoleSelector.tsx`: หน้าแรกเมื่อเปิดแอป ให้เลือกว่าจะเปิดในฐานะ **"เครื่องแม่ (ผู้คุมสอบ / อาจารย์)"** หรือ **"เครื่องนักเรียน (เข้าห้องสอบ)"** (หรือรับผ่าน CLI flag เช่น `--role=student` สำหรับตั้ง shortcut ในห้องคอม)

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [x] **0.1.1** สร้างโครงโปรเจกต์ `electron-vite` (React + TypeScript)
- [x] **0.1.2** ตั้งค่า Tailwind CSS, PostCSS, และฟอนต์ที่อ่านง่ายทั้งภาษาไทยและอังกฤษ (Tailwind v4 ใช้ `@tailwindcss/vite` ไม่ต้องมี PostCSS/Autoprefixer แยก)
- [x] **0.1.3** ตั้งค่า `vitest.config.ts` สำหรับรัน Unit Test ของทั้ง `shared` และ `main` (รันผ่าน Electron-as-Node เพื่อให้โหลด better-sqlite3 ABI ของ Electron ได้)
- [x] **0.2.1** เขียน `src/main/crypto/primitives.ts` (AES-256-GCM, HMAC-SHA256, SHA-256, Ed25519)
- [x] **0.2.2** เขียน Unit Test ทดสอบการเข้ารหัส/ถอดรหัส AES-256-GCM และการตรวจ HMAC/Ed25519
- [x] **0.3.1** กำหนด Zod schemas และ TypeScript types สำหรับ IPC ทั้งหมดใน `src/shared/ipc-channels.ts`
- [x] **0.3.2** สร้าง `src/main/ipc/router.ts` พร้อมการตรวจ `senderFrame` และ Zod validation
- [x] **0.3.3** สร้าง `src/preload/index.ts` และ `src/preload/index.d.ts`
- [x] **0.4.1** ติดตั้ง `better-sqlite3` และตั้งค่า `electron-builder` ให้ rebuild native module ตรงกับเวอร์ชัน Electron (postinstall: install-app-deps)
- [x] **0.4.2** สร้าง `src/main/storage/db.ts` และระบบตารางเริ่มต้น
- [x] **0.5.1** สร้างหน้าจอ Role Selection และ Layout พื้นฐานของ Host / Student ด้วย React + Tailwind

---

## 4. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Unit Tests (`npm run test`):**
   - ทดสอบ `AES-256-GCM`: เข้ารหัสแล้วถอดรหัสได้ข้อมูลเดิม, ถ้าแก้ ciphertext หรือ tag แม้แต่ 1 บิตต้อง throw error ทันที
   - ทดสอบ `IPC Router`: ส่ง payload ที่ผิดรูปแบบ Zod schema ต้องถูกปฏิเสธด้วยข้อความ error ที่ปลอดภัย
   - ทดสอบ `SQLite Storage`: สร้างตาราง เขียนข้อมูลเข้ารหัสลง DB และอ่านกลับมาถอดรหัสได้ถูกต้อง
2. **Manual Verification:**
   - รัน `npm run dev` หน้าต่างแอปเปิดขึ้นมาโดยไม่มี warning เรื่อง Content-Security-Policy (CSP) หรือ unsafe-eval ใน Console
   - ทดสอบคลิกเลือกบทบาท **Host** และ **Student** แล้วเปลี่ยนหน้าจอพร้อมส่ง IPC ไปเปลี่ยนสถานะที่ Main process ได้สำเร็จ


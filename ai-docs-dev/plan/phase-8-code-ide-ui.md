# Phase 8: `code-ide` Module (Part 1) — Multi-File & Folder IDE UI, Stack Categories (Frontend / Backend / Database / CLI) & Project Upload Builder

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
พัฒนาส่วน **User Interface (Frontend/Renderer)** และโครงสร้างไฟล์โจทย์โปรเจกต์ (`.ztcode`) ของโมดูลการสอบเขียนโปรแกรม **`code-ide` (`src/modules/code-ide/`)** ที่ฝังอยู่ภายในแอป โดยออกแบบให้เป็น **Project-Based Multi-File & Folder IDE เต็มรูปแบบ** ทั้งฝั่งนักเรียนและฝั่งอาจารย์ รองรับการเลือก **ประเภทโจทย์ (Project Track: CLI / Algorithm, Frontend, Backend API, Database / SQL)**, การเลือกภาษา, และการอัปโหลดโปรเจกต์ตั้งต้นพร้อม **Offline Libraries / Dependencies** เพื่อให้ใช้งานไลบรารีต่างๆ ได้จริงในห้องสอบออฟไลน์

### สิ่งที่ต้องได้เมื่อจบ Phase 8
- **โครงสร้างข้อมูล `CodeExamPackageSchema` และไฟล์ `.ztcode` แบบ Multi-File & Folder Tree:** รองรับทั้งไฟล์โค้ด, โฟลเดอร์ซ้อนหลายระดับ (Nested Folders), ไฟล์ฐานข้อมูลตั้งต้น (`.sql`, `.sqlite`), และชุดไลบรารีออฟไลน์ (`DependencyBundle` เช่น `.jar`, Python wheels/site-packages, หรือ `node_modules` / ESM bundles)
- **หมวดหมู่โจทย์และภาษาที่รองรับครบทุกสแต็ก (`ProjectCategory` & `SupportedLanguage`):**
  1. **Core / CLI / Systems Programming:** `c`, `cpp` (C++), `rust`, `go` (Golang), `java`, `python`, `javascript`, `typescript`, `php` (รองรับหลายไฟล์/Header/Package/Module + ไลบรารีเสริม)
  2. **Frontend Web UI:** `html-css-js` (HTML + CSS + JS หลายไฟล์/โฟลเดอร์), `react` (JSX / TSX + CSS + Component folders + UI libraries)
  3. **Backend / REST API:** `node-backend` (JS/TS เช่น Express / Fastify / Hono), `python-backend` (Flask / FastAPI), `go-backend` (Go `net/http` / Gin / Fiber), `php-backend` (PHP Built-in Server / REST scripts), `java-backend` — นักเรียนจัดโครงสร้างโฟลเดอร์ (`routes/`, `controllers/`, `services/`, `models/`) และทดสอบผ่าน Built-in API Client / HTTP Test Runner
  4. **Database / SQL (& Backend + DB):** `sql-sqlite` (อนุญาตให้นักเรียนรันคำสั่ง `DELETE`, `DROP TABLE`, `TRUNCATE`, `UPDATE`, `ALTER` ได้อย่างอิสระ โดยระบบจะเก็บต้นฉบับไว้และ **Spawn ฐานข้อมูลจำลองลูกใหม่พร้อมข้อมูลตั้งต้นเดิม (Original Seed Data)** ให้ทุกครั้งที่กดรันหรือเริ่ม Test Case ใหม่!)
- **Student In-App Project IDE Workspace:** หน้าจอ IDE ภายใน Kiosk Shell ที่มี **Full File & Folder Explorer Tree** (นักเรียนสามารถสร้างไฟล์ใหม่, สร้างโฟลเดอร์ใหม่, เปลี่ยนชื่อ, ลบ, หรือย้ายไฟล์ได้ภายใต้ขอบเขตที่อาจารย์อนุญาต), Multi-tab **Monaco Editor**, และแผงผลลัพธ์ด้านขวา/ล่างที่สลับตามประเภทโจทย์ (Console/Stdio, Live Web Preview, API Request Tester, หรือ SQL Table Result Viewer)
- **Teacher Project Problem Builder:** หน้าจอสร้างโจทย์สำหรับอาจารย์ที่มี **IDE View เหมือนฝั่งนักเรียน 100%** รองรับการ **Upload โปรเจกต์ตั้งต้น (Folder / `.zip`)**, การแนบ **Libraries / Packages**, การตั้งค่าสิทธิ์ไฟล์/โฟลเดอร์ (`readOnly`, `hiddenFromStudent`), และการเขียนชุดทดสอบตามประเภทโจทย์

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 8.1 โครงสร้างข้อมูลโจทย์โปรเจกต์ หมวดหมู่ภาษา และระบบ Library Bundle (`src/modules/code-ide/shared/code-schema.ts`)

1. **การเลือกหมวดหมู่โจทย์ (`ProjectCategory`) และภาษา/สแต็ก (`SupportedLanguage`):**
   ตอนตั้งโจทย์ อาจารย์สามารถเลือกได้ว่าจะให้ข้อนั้นเป็นโจทย์ประเภทใดและใช้ภาษาอะไร:
   ```ts
   export const ProjectCategorySchema = z.enum([
     'cli-algorithm', // โจทย์อัลกอริทึม / OOP / โปรแกรมรันผ่าน CLI หรือ Function (รองรับหลายไฟล์และโฟลเดอร์)
     'frontend',      // โจทย์หน้าเว็บ / UI Component (HTML/CSS/JS หรือ React หลายไฟล์/โฟลเดอร์)
     'backend',       // โจทย์สร้าง REST API / Backend Service (รองรับโฟลเดอร์ routes, controllers, middleware ฯลฯ)
     'database',      // โจทย์ Database / SQL Query / Schema Design (หรือ Backend + Database)
     'fullstack'      // โจทย์ที่มีทั้งส่วน Frontend + Backend (+ Database) ในโปรเจกต์เดียวกัน
   ])

   export const SupportedCodeLanguageSchema = z.enum([
     // Core, Systems & CLI / OOP
     'c',                // C (Multi-file .c / .h + gcc/clang)
     'cpp',              // C++ (Multi-file .cpp / .hpp + g++/clang++)
     'rust',             // Rust (Multi-file .rs / Cargo project + rustc/cargo --offline)
     'go',               // Golang (Multi-file .go / go.mod + go build/run)
     'java',             // Java (Multi-file / Packages + .jar libraries)
     'python',           // Python 3 (Multi-file / Modules + offline site-packages / wheels)
     'javascript',       // Node.js (CommonJS / ES Modules + offline node_modules)
     'typescript',       // TypeScript + esbuild / tsx + Node.js runtime
     'php',              // PHP CLI (Multi-file .php + include/require/vendor)
     // Frontend
     'html-css-js',      // Multi-file HTML + CSS + Vanilla JS + Frontend assets
     'react',            // React (JSX / TSX + CSS + Component folders + Offline npm vendor libs)
     // Backend API
     'node-backend',     // Node.js / TypeScript Backend (Express, Fastify, Hono, ฯลฯ)
     'python-backend',   // Python Backend (Flask, FastAPI, หรือ HTTP Server)
     'go-backend',       // Golang HTTP / REST Backend (net/http, Gin, Fiber, Chi)
     'php-backend',      // PHP Web / REST API Backend (php -S 127.0.0.1:<port>)
     'java-backend',     // Java HTTP / REST Backend
     // Database
     'sql-sqlite'        // SQL (อนุญาต DELETE / DROP ได้เต็มที่ โดยระบบ Spawn DB ใหม่พร้อม Data เดิมทุกครั้ง)
   ])
   ```

2. **โครงสร้างไฟล์และโฟลเดอร์แบบสมบูรณ์ (`VirtualProjectTree`):**
   รองรับทั้งไฟล์และโฟลเดอร์ซ้อนกันหลายชั้น (เช่น `src/components/Header.tsx`, `src/utils/math.ts`, `controllers/userController.js`, `db/migrations/01_init.sql`) พร้อมสิทธิ์การแก้ไข:
   ```ts
   export const VirtualNodeKindSchema = z.enum(['file', 'folder'])

   export const VirtualEntrySchema = z.object({
     path: z.string(),                          // พาธแบบ POSIX เช่น 'src/components' หรือ 'src/components/Button.tsx'
     kind: VirtualNodeKindSchema,               // 'file' หรือ 'folder'
     content: z.string().optional(),            // เนื้อหาไฟล์ (เฉพาะ kind === 'file') หรือ base64 สำหรับไฟล์ไบนารีขนาดเล็ก
     encoding: z.enum(['utf8', 'base64']).default('utf8'),
     readOnly: z.boolean().default(false),      // ล็อกไฟล์หรือทั้งโฟลเดอร์ไม่ให้นักเรียนแก้/ลบ (เช่น โฟลเดอร์ core/ หรือไฟล์ config)
     allowStudentCreateInside: z.boolean().default(true), // สำหรับโฟลเดอร์: อนุญาตให้นักเรียนสร้างไฟล์/โฟลเดอร์ย่อยข้างในได้หรือไม่
     hiddenFromStudent: z.boolean().default(false)        // ซ่อนไฟล์ชุดทดสอบหรือไฟล์ตรวจคำตอบไว้ใช้ตอนรันตรวจเท่านั้น
   })

   export const ProjectWorkspacePolicySchema = z.object({
     allowCreateFiles: z.boolean().default(true),       // อนุญาตให้นักเรียนสร้างไฟล์ใหม่ได้
     allowCreateFolders: z.boolean().default(true),     // อนุญาตให้นักเรียนสร้างโฟลเดอร์ใหม่ได้
     allowDeleteRename: z.boolean().default(true),      // อนุญาตให้ลบ/เปลี่ยนชื่อไฟล์ที่ไม่ได้ติด readOnly
     allowStudentFileUpload: z.boolean().default(false),// อนุญาตให้นักเรียนอัปโหลดไฟล์/ZIP จากเครื่องเข้าโปรเจกต์หรือไม่
     entryPointPath: z.string(),                        // ไฟล์หลักสำหรับรัน เช่น 'src/Main.java', 'src/server.ts', 'src/App.tsx', 'query.sql'
     maxProjectSizeBytes: z.number().default(10 * 1024 * 1024) // จำกัดขนาดโค้ดโปรเจกต์ของนักเรียน (ไม่นับรวมโฟลเดอร์ Library ของครู)
   })
   ```

3. **ระบบจัดการ Libraries / Dependencies และ Database ตั้งต้น (`Dependency & Database Config`):**
   เพื่อให้โจทย์สามารถใช้ไลบรารีภายนอกได้จริงโดยไม่ต้องต่ออินเทอร์เน็ตขณะสอบ:
   ```ts
   export const DependencyBundleSchema = z.object({
     bundleId: z.string(),
     ecosystem: z.enum([
       'npm',
       'pip',
       'maven-jar',
       'c-cpp-headers-libs',
       'cargo-vendor',
       'go-vendor',
       'composer-vendor',
       'frontend-vendor'
     ]),
     packages: z.array(z.object({
       name: z.string(),    // เช่น 'express', 'zod', 'lucide-react', 'numpy', 'gson.jar', 'serde', 'gin'
       version: z.string()
     })),
     archiveRelativePath: z.string(), // พาธของไฟล์รวมไลบรารี (.tar.zst / .zip) ที่แนบอยู่ในแพ็กเกจ .ztcode
     typeDefinitionsPath: z.string().optional() // ไฟล์ .d.ts สำหรับให้ Monaco Editor แสดง Auto-complete / IntelliSense
   })

   export const DatabaseConfigSchema = z.object({
     enabled: z.boolean().default(false),
     engine: z.enum(['sqlite']).default('sqlite'),
     seedSqlPath: z.string().optional(),      // เช่น 'db/seed.sql' สำหรับสร้างตารางและข้อมูลตั้งต้น (Master Seed)
     prebuiltDbPath: z.string().optional(),   // หรือไฟล์ '.sqlite' ต้นฉบับที่อาจารย์อัปโหลดมาให้เลย
     allowDestructiveQueries: z.boolean().default(true), // อนุญาตให้นักเรียนสั่ง DELETE, DROP, TRUNCATE, ALTER ใน DB จำลองได้เต็มที่
     respawnFreshDbOnEveryRun: z.boolean().default(true), // สร้าง (Spawn) DB ใหม่พร้อม Data ตั้งต้นเดิมทุกครั้งที่กด Run หรือรันแต่ละ Test Case
     exposeDbViewerToStudent: z.boolean().default(true) // ให้นักเรียนกดดู Schema / ตารางข้อมูลตั้งต้นใน IDE ได้
   })
   ```

4. **โครงสร้างชุดทดสอบครอบคลุมทั้ง 4 หมวด (`CodeTestCaseSchema`):**
   - **`CliTestCaseSchema` (`kind: 'stdio'` หรือ `'unit-harness'`):** สำหรับ Java, Python, JS, TS (ป้อน `stdin` ตรวจ `stdout` หรือรัน Unit Test file เช่น JUnit / pytest / vitest harness กับหลายไฟล์ของนักเรียน)
   - **`DomTestCaseSchema` (`kind: 'dom-assertion'`):** สำหรับ Frontend (`html-css-js`, `react`) ตรวจ DOM, CSS, และ Event Interaction
   - **`HttpApiTestCaseSchema` (`kind: 'http-api'`):** สำหรับ Backend (`node-backend`, `python-backend`, `java-backend`):
     ```ts
     export const HttpApiTestCaseSchema = z.object({
       testId: z.string(),
       kind: z.literal('http-api'),
       title: z.string(), // เช่น "POST /api/users ต้องสร้างผู้ใช้ใหม่และคืนค่า 201 พร้อม id"
       requests: z.array(z.object({
         method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
         path: z.string(), // เช่น '/api/users?role=admin'
         headers: z.record(z.string()).optional(),
         bodyJson: z.string().optional(),
         expectedStatus: z.number().int(),
         expectedBodyMatcher: z.enum(['exact-json', 'json-subset', 'regex', 'custom-script']),
         expectedBody: z.string()
       })),
       visibility: z.enum(['sample', 'hidden']),
       points: z.number().positive(),
       timeoutMs: z.number().int().default(5000)
     })
     ```
   - **`SqlTestCaseSchema` (`kind: 'sql-query'`):** สำหรับ Database (`sql-sqlite` หรือตรวจสถานะ DB หลังรัน):
     ```ts
     export const SqlTestCaseSchema = z.object({
       testId: z.string(),
       kind: z.literal('sql-query'),
       title: z.string(), // เช่น "ดึงรายชื่อแผนกที่มีเงินเดือนเฉลี่ยมากกว่า 50,000 เรียงจากมากไปน้อย"
       setupSqlOverride: z.string().optional(), // ข้อมูลพิเศษสำหรับ Hidden Test Case เพื่อกันนักเรียน hardcode คำตอบ
       verificationQuery: z.string().optional(), // กรณีโจทย์ให้นักเรียนรัน INSERT/UPDATE/CREATE TABLE แล้วครูใช้ SELECT ตรวจ
       expectedColumns: z.array(z.string()),
       expectedRows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
       checkColumnOrder: z.boolean().default(true),
       checkRowOrder: z.boolean().default(true),
       visibility: z.enum(['sample', 'hidden']),
       points: z.number().positive(),
       timeoutMs: z.number().int().default(2000)
     })
     ```

---

### 8.2 Student In-App Project IDE Workspace UI (`src/modules/code-ide/renderer/student/`)
ออกแบบหน้าจอ IDE สำหรับนักเรียนให้รองรับการทำงานแบบ **Multi-File & Multi-Folder Project** เหมือน VS Code ย่อส่วน และฝั่งอาจารย์ก็ใช้คอมโพเนนต์ชุดเดียวกันนี้ในการพรีวิวและตรวจงาน:

```text
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ [Core Kiosk HUD: วิชา Web & Backend Dev | ข้อ 3/4 | 📂 E:\StudentWork\65010001 | ⏳ 01:25] │
├───────────────┬──────────────────┬───────────────────────────────────┬──────────────────┤
│ 📄 โจทย์       │ 📁 PROJECT FILES │ [src/server.ts ×] [routes/user.ts]│ 🧪 แผงทดสอบ/ผลลัพธ์ │
│               │  [+File] [+Dir]  ├───────────────────────────────────┤ [API] [DB] [Test]│
│ ข้อที่ 3:       │ ▼ 📁 src         │ 1 import express from 'express'   │                  │
│ สร้าง REST API │   ▼ 📁 routes    │ 2 import { db } from './db/conn'  │ GET /api/users   │
│ เชื่อมต่อ SQLite│     📄 user.ts   │ 3 import { userRouter } from ...  │ Status: 200 OK   │
│               │     📄 auth.ts   │ 4                                 │ [                │
│ 📦 Libraries: │   ▼ 📁 db        │ 5 const app = express()           │   {"id": 1, ...} │
│ - express     │     🔒 conn.ts   │ 6 app.use(express.json())         │ ]                │
│ - zod         │   📄 server.ts   ├───────────────────────────────────┼──────────────────┤
│ - better-sql..│ ▼ 📁 db-seed     │ 🗄️ Database Schema Explorer       │ ✅ Test 1: ผ่าน   │
│               │   🔒 init.sql    │ Tables: users (id, name, role)    │ ❌ Test 2: 404   │
│ [🔄 Reset โค้ด]│ 📄 package.json  │         orders (id, user_id, ...) │                  │
├───────────────┴──────────────────┴───────────────────────────────────┴──────────────────┤
│ [📂 เปลี่ยนโฟลเดอร์เก็บงาน] [📤 Upload ไฟล์]   [▶ รัน / ทดสอบ Sample (Ctrl+Enter)] [🚀 ส่งงาน] │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **การเลือกโฟลเดอร์เก็บงานฝั่งนักเรียน (`StudentWorkspaceFolderPicker.tsx`):**
   - ตอนเข้าห้องสอบ (หน้า Lobby) หรือบนแถบด้านล่างของ IDE นักเรียนสามารถกดปุ่ม **`📂 เลือกโฟลเดอร์เก็บงาน (Select Local Workspace Folder)`** เพื่อเลือกโฟลเดอร์จริงบนเครื่องตัวเองที่จะใช้เก็บไฟล์โปรเจกต์ของข้อสอบชุดนี้ (หากไม่เลือก ระบบจะใช้พาธมาตรฐาน เช่น `Documents/LANExamWorkspace/<examId>_<studentId>/`)
   - ทุกครั้งที่นักเรียนสร้างไฟล์ใหม่ สร้างโฟลเดอร์ย่อย หรือพิมพ์แก้ไขโค้ดใน IDE ระบบจะ **เขียนลงโฟลเดอร์จริงที่นักเรียนเลือกไว้แบบ Real-time (`<StudentWorkspaceFolder>/Q<number>_<questionSlug>/...`)** ทำให้นักเรียนมีไฟล์งานจริงอยู่ในโฟลเดอร์ที่ตัวเองเลือกตลอดเวลา และป้องกันงานหาย 100% แม้ไฟดับ
2. **Interactive Project File & Folder Tree (`ProjectFileExplorerTree.tsx`):**
   - แสดงโครงสร้างโฟลเดอร์และไฟล์แบบ Collapsible Tree พร้อมไอคอนแยกตามนามสกุลไฟล์ (`.java`, `.py`, `.ts`, `.tsx`, `.html`, `.css`, `.sql`, `.json`) และไอคอนแม่กุญแจ `🔒` สำหรับไฟล์หรือโฟลเดอร์ที่ตั้งค่า `readOnly`
   - **การจัดการไฟล์และโฟลเดอร์โดยนักเรียน:**
     - ปุ่ม **`+ New File`**, **`+ New Folder`** และเมนูคลิกขวา (`Rename`, `Delete`, `Duplicate`) บนโฟลเดอร์ที่ได้รับอนุญาต
     - รองรับการลากย้ายไฟล์เข้าโฟลเดอร์ (Drag & Drop) หรือสร้างไฟล์พร้อมพาธย่อย เช่น พิมพ์ `components/cards/UserCard.tsx` แล้วระบบสร้างโฟลเดอร์ให้อัตโนมัติทั้งใน IDE และในโฟลเดอร์จริงบนดิสก์
   - **รายการ Libraries ที่ติดตั้งไว้ (`Installed Libraries Inspector`):**
     - แสดงรายการ Packages / Libraries ที่อาจารย์เตรียมไว้ให้ในโจทย์ข้อนั้น (เช่น `express@4.19`, `zod@3.23`, `gson-2.10.jar`, `numpy`) เพื่อให้นักเรียนเห็นชัดเจนว่าสามารถ `import` อะไรมาใช้ได้บ้าง
3. **Monaco Editor Multi-File & Cross-File IntelliSense (`MonacoCodeWorkspace.tsx`):**
   - ซิงก์ไฟล์ทั้งหมดใน `VirtualProjectTree` เข้าสู่ `monaco.editor.createModel(content, language, monaco.Uri.file(path))`
   - ทำให้นักเรียนที่เขียนหลายไฟล์ (เช่น แยกโฟลเดอร์ `utils/calc.ts` แล้ว `import { sum } from './utils/calc'` ใน `server.ts` หรือ `App.tsx`) ได้รับ **Auto-complete และตรวจ Type ข้ามไฟล์ได้จริงทันที!**
   - โหลดไฟล์ `.d.ts` ของ Libraries ที่อาจารย์เลือกไว้เข้าสู่ `monaco.languages.typescript.typescriptDefaults.addExtraLib(...)`
4. **แผงผลลัพธ์อัจฉริยะ 4 โหมดตามประเภทโจทย์ (`AdaptiveExecutionPanel.tsx`):**
   - **โหมด 1: CLI / Algorithm (`CliTestRunnerPanel.tsx`):** แสดงผล Sample Test Cases (`stdin` / `expectedStdout` / `actualStdout`) + แท็บ Custom Input Console
   - **โหมด 2: Frontend Web & React (`WebReactPreviewPanel.tsx`):** แสดง Sandboxed Live Preview (`iframe`) ที่โหลดทั้งโปรเจกต์ (รวม CSS, รูปภาพในโปรเจกต์, และ Component ย่อยทุกโฟลเดอร์) + Console Logs + ผลตรวจ DOM Assertions
   - **โหมด 3: Backend API (`BackendApiTesterPanel.tsx`):**
     - มี **Mini API Client (คล้าย Postman / Thunder Client ขนาดย่อม)** ให้นักเรียนเลือก `GET / POST / PUT / DELETE`, พิมพ์ URL Path (เช่น `/api/products`), ใส่ JSON Body แล้วกดยิงทดสอบกับเซิร์ฟเวอร์ของตัวเองที่รันอยู่ใน Sandbox ได้ทันที!
     - แท็บแสดงผลรัน **Sample HTTP API Test Cases** และ Server Console Logs (`stdout`/`stderr` ของเซิร์ฟเวอร์)
   - **โหมด 4: Database & SQL (`DatabaseWorkbenchPanel.tsx`):**
     - แท็บ **Schema & Data Browser:** แสดงรายชื่อตาราง (Tables), คอลัมน์ (Columns & Types), และข้อมูลตั้งต้น (Sample Rows) ในฐานข้อมูล SQLite
     - **ระบบ Ephemeral DB Respawn (ลบข้อมูล/ลบตารางได้เต็มที่):** นักเรียนสามารถทดสอบคำสั่ง `DELETE FROM`, `DROP TABLE`, `ALTER TABLE`, `UPDATE` ได้อย่างอิสระ โดยระบบจะเก็บต้นฉบับ (`Master Seed`) แยกไว้ และ **Spawn ฐานข้อมูลจำลองตัวใหม่พร้อมข้อมูลเดิม (Original Data)** ให้ทุกครั้งที่กดรัน หรือกดปุ่ม **`🔄 Spawn Fresh DB (คืนค่าฐานข้อมูลและข้อมูลตั้งต้นเดิม)`**
     - แท็บ **Query Result Table:** แสดงผลลัพธ์ของคำสั่ง SQL ที่นักเรียนรันออกมาเป็นตาราง (Data Grid) เปรียบเทียบกับตารางคำตอบที่คาดหวัง (`Expected Rows` vs `Actual Rows`)

---

### 8.3 Teacher Project Problem Builder & Library Uploader UI (`src/modules/code-ide/renderer/builder/`)
ออกแบบหน้าจอตั้งโจทย์ของอาจารย์ให้เห็นและทำงานกับโครงสร้างไฟล์/โฟลเดอร์ **เหมือนหน้าจอของนักเรียนทุกประการ** พร้อมเครื่องมือตั้งค่าโจทย์:

1. **ตัวเลือกหมวดหมู่โจทย์และภาษา (`TrackAndLanguageSelector.tsx`):**
   - ขั้นที่ 1: เลือกประเภทโจทย์ (**`CLI / Algorithm`**, **`Frontend UI`**, **`Backend API`**, **`Database / SQL`**, หรือ **`Full-Stack / Backend + DB`**)
   - ขั้นที่ 2: เลือกภาษา/สแต็ก (เช่น เลือก `Backend API` -> เลือก `Node.js / TypeScript (Express)`, `Python (FastAPI/Flask)`, หรือ `Java`)
   - ขั้นที่ 3: เลือกเปิด/ปิดออปชันเสริม เช่น **"เปิดใช้งานฐานข้อมูล SQLite ในโจทย์ข้อนี้"**
2. **การ Upload โปรเจกต์ตั้งต้นและจัดการโฟลเดอร์ (`ProjectTemplateUploader.tsx`):**
   - อาจารย์สามารถสร้างไฟล์/โฟลเดอร์เองใน File Tree บนหน้าจอ หรือกดปุ่ม **`📂 Upload โฟลเดอร์โปรเจกต์ / ไฟล์ .zip`**:
     - ระบบจะอ่านโครงสร้างโฟลเดอร์และไฟล์ทั้งหมดขึ้นมาแสดงใน File Tree ทันที
     - ระบบช่วยคัดกรองโฟลเดอร์ขยะออกให้อัตโนมัติ (เช่น `.git`, `.DS_Store`, `dist`, `build`) หรือแยก `node_modules` / `.venv` / `lib/*.jar` ไปเข้าส่วน **Dependency Bundle**
   - อาจารย์สามารถสลับมุมมองระหว่าง:
     - **มุมมอง `Starter Project (สิ่งที่นักเรียนจะเห็นตอนเริ่มสอบ)`**: ตั้งค่าได้ว่าจะล็อกไฟล์/โฟลเดอร์ไหนเป็น `🔒 Read-Only` หรือซ่อนไฟล์ไหนเป็น `👁️‍🗨️ Hidden Grading File`
     - **มุมมอง `Reference Solution (โปรเจกต์เฉลยของอาจารย์)`**: อาจารย์สามารถอัปโหลดโฟลเดอร์เฉลย หรือเขียนโค้ดเฉลยแบบหลายไฟล์/โฟลเดอร์เก็บไว้ใช้ตรวจสอบและเทียบ Diff กับงานนักเรียน
3. **ตัวจัดการ Libraries & Packages ออฟไลน์ (`OfflineDependencyManager.tsx`):**
   - **ชุดไลบรารีมาตรฐานพร้อมใช้ในคลังของแอป (Built-in Offline Presets):** อาจารย์แค่ติ๊กเลือก เช่น:
     - *Frontend / React:* `lucide-react`, `clsx`, `tailwind-css (offline runtime)`, `dayjs`, `zod`
     - *Node / TS Backend:* `express`, `fastify`, `hono`, `cors`, `better-sqlite3`, `zod`, `jsonwebtoken`, `bcryptjs`
     - *Python:* `pytest`, `pydantic`, `flask`, `fastapi`, `sqlite3` (built-in)
     - *Java:* `junit-platform-console-standalone.jar`, `gson.jar`, `sqlite-jdbc.jar`
   - **การอัปโหลด Custom Library เพิ่มเติม:** อาจารย์สามารถกดอัปโหลดไฟล์ `.jar` (สำหรับ Java), ไฟล์ `.whl` / โฟลเดอร์ package (สำหรับ Python), หรือโฟลเดอร์ `node_modules` / package `.tgz` (สำหรับ JS/TS) เพื่อฝังเข้าไปในไฟล์ข้อสอบ `.ztcode` ได้โดยตรง
4. **การเลือกโฟลเดอร์เก็บงานฝั่งครู (`TeacherWorkspaceFolderConfig.tsx`):**
   - ตอนสร้างโจทย์หรือตอนเปิดห้องสอบ ครูสามารถกดเลือก **`📂 โฟลเดอร์หลักสำหรับเก็บงานของห้องสอบ (Teacher Workspace Root Folder)`** บนเครื่องครูได้ (เช่น `D:\ExamWorkspace\CS202_Final\`)
   - ระบบจะใช้โฟลเดอร์ที่ครูเลือกนี้เป็นที่เก็บทั้งเทมเพลตโจทย์ และสร้าง **Subfolder แยกตามรหัสนักเรียน (`<TeacherWorkspaceFolder>/<studentId>/`)** ให้อัตโนมัติเมื่อนักเรียนแต่ละคนส่งงานหรือซิงก์โค้ดเข้ามา
5. **ปุ่ม `"▶ ทดสอบรันโปรเจกต์เฉลยของอาจารย์กับทุก Test Case"`:**
   - ทดสอบรันโปรเจกต์เฉลยของอาจารย์ (รวมทุกไฟล์ ทุกโฟลเดอร์ ทุก Library และ Database Seed) กับทั้ง Sample และ Hidden Test Cases เพื่อยืนยันว่าโจทย์และชุดทดสอบทำงานถูกต้อง 100% ก่อนบันทึกเป็นไฟล์ `.ztcode`

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **8.1.1** อัปเดตและสร้าง Zod schemas สำหรับ `ProjectCategorySchema`, `SupportedCodeLanguageSchema`, `VirtualEntrySchema` (รองรับทั้ง `'file'` และ `'folder'`), `DependencyBundleSchema`, `DatabaseConfigSchema`, `HttpApiTestCaseSchema`, และ `SqlTestCaseSchema`
- [ ] **8.1.2** สร้างระบบแพ็กและโหลดไฟล์ `.ztcode` รูปแบบ Archive ที่บรรจุทั้งโครงสร้างโฟลเดอร์โปรเจกต์, ไฟล์ Database Seed (`.sql`/`.sqlite`), และชุด Offline Dependency Bundles
- [ ] **8.2.1** พัฒนา `StudentWorkspaceFolderPicker.tsx` และ `ProjectFileExplorerTree.tsx` ที่รองรับการเลือกโฟลเดอร์เก็บงานจริงบนเครื่องนักเรียน และการสร้าง/ลบ/เปลี่ยนชื่อ/ย้าย ทั้งไฟล์และโฟลเดอร์ย่อยหลายระดับ (Nested Folders) โดยเคารพสิทธิ์ `readOnly`
- [ ] **8.2.2** ตั้งค่า Monaco Editor แบบ Multi-Model (`monaco.Uri.file(path)`) เพื่อให้รองรับการ `import` ข้ามไฟล์/ข้ามโฟลเดอร์และโหลด `.d.ts` ของ Libraries แบบออฟไลน์
- [ ] **8.2.3** สร้างแผงทดสอบครบทั้ง 4 โหมด: `CliTestRunnerPanel.tsx`, `WebReactPreviewPanel.tsx`, `BackendApiTesterPanel.tsx` (พร้อม Mini API Client), และ `DatabaseWorkbenchPanel.tsx` (พร้อม SQL Table Viewer)
- [ ] **8.3.1** สร้างหน้าจอ `CodeExamBuilder.tsx` และ `TeacherWorkspaceFolderConfig.tsx` รองรับการเลือกโฟลเดอร์เก็บงานฝั่งครู, เลือกประเภทโจทย์ (CLI / Frontend / Backend / Database), การ Upload โฟลเดอร์หรือไฟล์ `.zip` เป็นโปรเจกต์ตั้งต้น/โปรเจกต์เฉลย, และการเลือกใช้ Libraries

---

## 4. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **Multi-Folder Tree Operations & Permission Test:** ทดสอบการสร้างโฟลเดอร์ย่อย สร้างไฟล์ เปลี่ยนชื่อ และลบไฟล์ใน `VirtualProjectTree` พร้อมตรวจว่าการแก้ไขหรือลบไฟล์/โฟลเดอร์ที่ติด `readOnly: true` ถูกปฏิเสธ 100%
   - **`.ztcode` Project & Dependency Archive Round-Trip Test:** ทดสอบแพ็กและโหลดชุดข้อสอบที่มีครบทั้ง 4 ประเภท (CLI, Frontend, Backend, Database) พร้อมโครงสร้างโฟลเดอร์ซ้อน 3 ชั้น, ไฟล์ `.sqlite` ตั้งต้น, และไฟล์ Library Bundle กลับมาได้ครบถ้วนและตัดข้อมูล `hidden` ออกก่อนส่งให้นักเรียน
2. **Manual Verification:**
   - ทดสอบฝั่งอาจารย์อัปโหลดโฟลเดอร์โปรเจกต์หลายไฟล์ เลือกโหมด `Frontend`, `Backend`, และ `Database` เลือก Libraries แล้วสลับดูฝั่งนักเรียน -> เห็นโครงสร้างโฟลเดอร์และไฟล์ตรงกันเป๊ะ นักเรียนสร้างไฟล์/โฟลเดอร์เพิ่มได้ และ Monaco Editor รู้จักการ `import` ข้ามโฟลเดอร์จริง

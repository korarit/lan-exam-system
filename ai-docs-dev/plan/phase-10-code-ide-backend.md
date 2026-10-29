# Phase 10: `code-ide` Module (Part 3) — Project Submission Upload, Multi-Stack Auto-Grader & Teacher Same-as-Student IDE Inspector

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
พัฒนาส่วน **Embedded Backend (`HostExamModuleBackend<'code-ide'>`)** ที่ทำงานอยู่ใน Electron Main Process ของเครื่องแม่ (Host) และหน้าจอตรวจงานสำหรับอาจารย์ โดยรองรับการรับ-ส่ง **โปรเจกต์หลายไฟล์และหลายโฟลเดอร์ (`VirtualProjectTree` + Assets)**, การกระจาย **Offline Dependency Bundles** ให้เครื่องนักเรียนเมื่อเริ่มสอบ, การประมวลผลตรวจให้คะแนนอัตโนมัติทั้ง 4 หมวดหมู่โจทย์ (**CLI, Frontend, Backend API, Database/SQL**), และหน้าจอ **Teacher Project IDE Inspector** ที่ให้อาจารย์เปิดดูโครงสร้างโฟลเดอร์ ไฟล์โค้ด และพรีวิวผลรันของนักเรียนได้ **เหมือนกับที่นักเรียนเห็นบนหน้าจอทุกประการ**

### สิ่งที่ต้องได้เมื่อจบ Phase 10
- คลาส `CodeIdeModuleBackend` ที่จัดการกระจายโจทย์พร้อมชุด Libraries ออฟไลน์ไปยังเครื่องนักเรียน และรับการส่งงานทั้งโปรเจกต์ (รองรับทั้งการส่งจาก File Tree ใน IDE และการอัปโหลดโปรเจกต์/ไฟล์เข้าส่งงาน)
- **ระบบจัดการโฟลเดอร์เก็บงานฝั่งครูพร้อม Subfolder รหัสนักเรียนอัตโนมัติ (`Teacher Workspace Folder & <studentId> Subfolder Sync`):** ครูสามารถเลือกโฟลเดอร์หลักสำหรับเก็บงานบนเครื่องแม่ และระบบจะสร้างโฟลเดอร์ย่อยตามรหัสนักเรียน (`<TeacherWorkspaceFolder>/<studentId>/`) เพื่อบันทึกโครงสร้างไฟล์และโฟลเดอร์ทั้งหมดของนักเรียนแต่ละคนลงดิสก์เครื่องครูโดยอัตโนมัติทันทีที่ส่งงาน (และอัปเดตตามรอบ Autosave)
- ระบบ **`GradingWorkerQueue`** ที่เครื่องแม่ที่รันตรวจโปรเจกต์ของนักเรียนกับชุดทดสอบลับ (**Hidden Grading Test Cases**) ครบทุกหมวด (CLI, Frontend DOM, Backend HTTP API, และ Database SQL)
- หน้าจอ **Teacher Project Review & Mirror IDE View (`StudentProjectInspectorModal.tsx`)**: อาจารย์เห็น **Folder & File Tree เหมือนฝั่งนักเรียนเป๊ะ**, คลิกสลับดูได้ทุกไฟล์ในโปรเจกต์, เทียบ Diff รายไฟล์หรือทั้งโฟลเดอร์กับเฉลยของอาจารย์, และกดเปิดโฟลเดอร์ `<studentId>` ของนักเรียนคนนั้นใน File Explorer ของเครื่องครูได้ทันที

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 10.1 Project & Dependency Dispatcher, การซิงก์โฟลเดอร์ `<studentId>` ฝั่งครู และระบบส่งงาน (`src/modules/code-ide/main/code-module-backend.ts`)
1. **การตั้งค่าโฟลเดอร์หลักเก็บงานฝั่งครู (`TeacherWorkspaceDirectoryManager`):**
   - ครูเลือกโฟลเดอร์หลักสำหรับเก็บงานของห้องสอบ (เช่น `D:\CS101_Exam_Submissions\`) ผ่านหน้าตั้งค่าห้องสอบหรือหน้า Dashboard
   - เมื่อนักเรียนแต่ละคนเข้าห้องสอบและเริ่มทำข้อสอบ ระบบที่เครื่องแม่จะสร้าง **Subfolder ด้วยรหัสนักเรียน (`<TeacherWorkspaceFolder>/<studentId>/`)** รอไว้ทันที:
     ```text
     <TeacherSelectedFolder>/                  (โฟลเดอร์ที่ครูเลือกไว้)
     ├── _teacher_template/                    (โฟลเดอร์เก็บไฟล์โจทย์ตั้งต้นและเฉลยของครู)
     ├── 65010001/                             (Subfolder รหัสนักเรียนคนที่ 1)
     │   ├── Q1_Java_OOP_Shop/
     │   │   └── src/
     │   │       ├── Main.java
     │   │       └── models/Product.java
     │   ├── Q2_React_Dashboard/
     │   │   └── src/
     │   │       ├── App.tsx
     │   │       └── components/StatsCard.tsx
     │   ├── Q3_Node_Backend_API/
     │   │   ├── src/server.ts
     │   │   └── routes/users.ts
     │   └── grading-report.json
     ├── 65010002/                             (Subfolder รหัสนักเรียนคนที่ 2)
     │   └── ...
     └── summary-scores.csv
     ```
   - **Sanitized Student ID & Vault Protection Guard:**
     - ทำความสะอาดรหัสนักเรียน (`sanitizeFolderName(studentId)`) เพื่อป้องกันตัวอักษรพิเศษหรือ Path Traversal (`../`) ก่อนนำมาสร้างเป็นชื่อ Subfolder บนเครื่องครู
     - **การปกป้องไฟล์ในโฟลเดอร์ครูไม่ให้ถูกลบ (`Vault Anti-Delete Protection`):** เมื่อเครื่องแม่รันตรวจงานใน `GradingWorkerQueue` จะ **ไม่รันโค้ดภายใน `<TeacherSelectedFolder>/<studentId>/` โดยตรงเด็ดขาด** แต่จะคัดลอกไปรันในโฟลเดอร์ชั่วคราวภายใต้ `AntiDeleteRuntimeGuard` (จาก Phase 9.2) เสมอ ทำให้ต่อให้นักเรียนส่งโค้ดที่มีคำสั่ง `rm -rf` / `shutil.rmtree` / `fs.rmSync` เข้ามา โฟลเดอร์งานของครูและของนักเรียนทุกคนใน `<TeacherSelectedFolder>` จะปลอดภัย 100% ไม่สามารถถูกลบได้!
2. **การส่งโจทย์และซิงก์ Libraries ไปยังเครื่องนักเรียน (`initializeStudentSession`):**
   - ส่งรายละเอียดโจทย์, หมวดหมู่โจทย์ (`projectCategory`), โครงสร้างโฟลเดอร์ตั้งต้น `starterEntries` (เฉพาะรายการที่ `hiddenFromStudent === false`), ไฟล์ Database Seed สำหรับตัวอย่าง, และรายการ `sampleTestCases` ไปยังเครื่องนักเรียน (ซึ่งฝั่งนักเรียนจะนำไปบันทึกลงในโฟลเดอร์ที่นักเรียนเลือกไว้บนเครื่องตัวเองทันที)
   - ส่งไฟล์ `DependencyBundle` (ชุดไลบรารีที่อาจารย์เลือกไว้) ผ่าน LAN Chunked Stream ไปแคชไว้ที่เครื่องนักเรียนตั้งแต่ช่วงอยู่ในห้อง Lobby เพื่อให้พร้อมใช้งานทันทีเมื่อกดเริ่มสอบ
   - เก็บ `hiddenTestCases`, `setupSqlOverride`, และโปรเจกต์เฉลย `referenceSolutionEntries` ไว้ที่เครื่องแม่เท่านั้น
3. **การรับ Autosave และการ Upload ส่งงานลง Subfolder `<studentId>` (`handleAutosaveDraft` & `handleProjectSubmission`):**
   - **Incremental / Full Tree Autosave:** ทุก 5 วินาทีเมื่อมีการแก้ไฟล์ สร้างไฟล์ หรือสร้างโฟลเดอร์ใหม่ในโปรเจกต์ของนักเรียน ระบบจะส่ง Snapshot ของ `VirtualProjectTree` มาเก็บไว้ในตาราง `code_draft_snapshots` ที่เครื่องแม่ และซิงก์อัปเดตลงในโฟลเดอร์ `<TeacherSelectedFolder>/<studentId>/<questionSlug>/`
   - **การส่งงานโปรเจกต์ (`Submit Project Solution`):**
     - นักเรียนกดส่งงานจากโครงสร้างไฟล์และโฟลเดอร์ทั้งหมดที่อยู่ในโฟลเดอร์งาน/IDE ของตัวเอง
     - ระบบตรวจสอบความถูกต้องของขนาดโปรเจกต์ (`maxProjectSizeBytes`), กรองโฟลเดอร์ไลบรารีที่ไม่ต้องส่งซ้ำออก (`node_modules`, `.venv`), แล้วแพ็กโครงสร้างไฟล์และโฟลเดอร์ทั้งหมดของนักเรียนส่งขึ้นเครื่องแม่
     - เครื่องแม่บันทึกลงตาราง `code_submissions` แบบเข้ารหัส (AES-256-GCM), เขียนไฟล์และโฟลเดอร์ทั้งหมดลงใน **`<TeacherSelectedFolder>/<studentId>/<questionSlug>/`** ทันที, และส่งเข้าคิวตรวจ **`GradingWorkerQueue`**

---

### 10.2 Multi-Stack Auto-Grading Queue (`src/modules/code-ide/main/code-grader-queue.ts`)
รองรับการตรวจโปรเจกต์หลายไฟล์ในทุกหมวดหมู่โจทย์อย่างปลอดภัยโดยไม่ทำให้เครื่องแม่ค้างเมื่อนักเรียนส่งงานพร้อมกัน:

1. **Bounded Concurrency Worker Queue:**
   - จำกัดจำนวนการรันตรวจขนานกันตามจำนวนคอร์ของ CPU เครื่องแม่ (`maxConcurrentRuns = Math.max(2, os.cpus().length - 2)`)
   - สำหรับโจทย์หมวด `backend`: จัดสรรพอร์ต `127.0.0.1:<port>` แยกกันต่อ Worker เพื่อไม่ให้พอร์ตชนกันขณะตรวจงานของนักเรียนหลายคนพร้อมกัน
2. **การตรวจให้คะแนนตามประเภทโจทย์ (`Multi-Stack Grading Dispatch`):**
   - **`cli-algorithm`:** แตกไฟล์และโฟลเดอร์ของนักเรียน + ผูก Libraries + รันตรวจทุก `CliTestCase` (Sample + Hidden)
   - **`frontend`:** Bundle ไฟล์และโฟลเดอร์ทั้งหมดของนักเรียนด้วย `esbuild` + Offline Vendor Libraries + รันตรวจทุก `DomTestCase` ใน `HeadlessDomRunner`
   - **`backend`:** รันเซิร์ฟเวอร์ของนักเรียนใน Sandbox (+ ผูก SQLite Database หากเปิดใช้) + ยิงตรวจทุก `HttpApiTestCase` (ตรวจทั้ง Status Code, JSON Body, และสถานะฐานข้อมูลหลังยิง API)
   - **`database`:** สร้างฐานข้อมูล SQLite จาก Seed (และใช้ `setupSqlOverride` สำหรับ Hidden Test Cases เพื่อป้องกันการแอบจำคำตอบจากข้อมูลตัวอย่าง) + รันไฟล์ `.sql` ของนักเรียน + ตรวจตารางผลลัพธ์กับ `SqlTestCase`

---

### 10.3 Teacher Mirror IDE Inspector, Project Diff & Re-grade UI (`src/modules/code-ide/renderer/responses/`)
ออกแบบให้อาจารย์เห็นและสำรวจโปรเจกต์ของนักเรียนได้ **เหมือนหน้าจอ IDE ของนักเรียนทุกประการ**:

1. **ตารางสรุปผลคะแนนแยกตามข้อและประเภทโจทย์ (`CodeSubmissionsTable.tsx`):**
   - แสดงรายชื่อนักเรียน, ป้ายกำกับประเภทโจทย์และภาษา (เช่น `[Backend: TS/Express]`, `[Frontend: React]`, `[DB: SQL]`, `[CLI: Java]`), จำนวนไฟล์/โฟลเดอร์ที่ส่ง, แถบสีแสดงจำนวน Test Cases ที่ผ่าน (`🟢 12/12`, `🟡 8/12`), และสถานะความปลอดภัย
2. **หน้าต่างเปิดดูโปรเจกต์นักเรียนแบบ Mirror IDE (`StudentProjectInspectorModal.tsx`):**
   - ใช้คอมโพเนนต์ **`ProjectFileExplorerTree`** และ **`MonacoCodeWorkspace`** ตัวเดียวกับฝั่งนักเรียน!
   - **สิ่งที่อาจารย์ทำได้ในหน้านี้:**
     - **สำรวจ Folder & File Tree ทั้งหมด:** เห็นทุกโฟลเดอร์และทุกไฟล์ที่นักเรียนสร้างขึ้น (พร้อมป้ายบอกไฟล์ไหนเป็นไฟล์ตั้งต้น ไฟล์ไหนนักเรียนแก้ไข `[M]` และไฟล์ไหนนักเรียนสร้างเพิ่มใหม่ `[A]`)
     - **โหมด Project Diff เทียบกับเฉลย (`Side-by-Side Multi-File Diff`):** สลับดูเปรียบเทียบไฟล์ต่อไฟล์และโครงสร้างโฟลเดอร์ระหว่างโปรเจกต์ของนักเรียนกับโปรเจกต์เฉลยของอาจารย์
     - **โหมดดูผลรันเหมือนหน้าจอนักเรียน (`Live Preview / API / SQL Workbench`):** อาจารย์สามารถกดเปิดดูหน้าเว็บ Live Preview ของนักเรียน, ลองกดยิง API ทดสอบเซิร์ฟเวอร์ของนักเรียน, หรือดูตารางผลลัพธ์ SQL ของนักเรียนได้ตรงนั้นเลย
     - **Code Playback Timeline (รองรับทั้งไฟล์และโฟลเดอร์):** เลื่อนแถบเวลาดูพัฒนาการตั้งแต่เริ่มสอบว่านักเรียนค่อยๆ สร้างโฟลเดอร์และพิมพ์โค้ดทีละไฟล์อย่างไร
     - **การให้คะแนนเพิ่มเติม (Manual Rubric & Comments):** ปรับคะแนนหรือเขียนคอมเมนต์รายไฟล์/รายข้อได้
3. **ปุ่มสั่งตรวจโปรเจกต์ใหม่ทั้งห้อง (`Re-grade All Submissions`):**
   - หากอาจารย์แก้ไข Test Case หรือปรับเพิ่ม Library / Timeout หลังสอบเสร็จ สามารถกดสั่งให้ `GradingWorkerQueue` รันตรวจโปรเจกต์ของนักเรียนทุกคนใหม่ได้อัตโนมัติ

---

### 10.4 Project Tree & Score Exporter (`src/modules/code-ide/main/code-exporter.ts`)
1. **การส่งออกคะแนนเป็นไฟล์ Excel / CSV (UTF-8 BOM):**
   - ส่งออกตารางคะแนนรวม, คะแนนรายข้อ, ประเภทโจทย์/ภาษา, จำนวน Test Cases ที่ผ่าน, และคะแนน Manual Rubric
2. **การส่งออกโฟลเดอร์โปรเจกต์ของนักเรียนทั้งห้อง (`Export Full Student Projects Bundle`):**
   - สร้างโฟลเดอร์หรือไฟล์ ZIP ที่คง **โครงสร้างโฟลเดอร์ย่อย (Nested Folders) ของนักเรียนแต่ละคนไว้ครบ 100%** พร้อมไฟล์ `package.json` / `requirements.txt` / สคริปต์ฐานข้อมูล เพื่อให้อาจารย์สามารถนำโฟลเดอร์ไปเปิดใน VS Code หรือ IntelliJ ข้างนอกได้ทันที:
     ```text
     exported-submissions-<roomId>/
     ├── summary-scores.csv
     ├── 65010001_Somchai/
     │   ├── Q1_Java_OOP_Shop/
     │   │   ├── src/
     │   │   │   ├── Main.java
     │   │   │   └── models/
     │   │   │       ├── Product.java
     │   │   │       └── Cart.java
     │   │   └── grading-report.json
     │   ├── Q2_React_Dashboard/
     │   │   ├── src/
     │   │   │   ├── App.tsx
     │   │   │   └── components/
     │   │   │       └── StatsCard.tsx
     │   │   ├── package.json
     │   │   └── grading-report.json
     │   ├── Q3_Node_Backend_API/
     │   │   ├── src/
     │   │   │   ├── server.ts
     │   │   │   └── routes/
     │   │   │       └── users.ts
     │   │   ├── db/
     │   │   │   └── seed.sql
     │   │   └── grading-report.json
     │   └── Q4_Database_SQL/
     │       ├── answer.sql
     │       └── grading-report.json
     └── 65010002_Somsri/
         └── ...
     ```

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **10.1.1** สร้าง `CodeIdeModuleBackend` และ `TeacherWorkspaceDirectoryManager` รองรับการเลือกโฟลเดอร์หลักฝั่งครู การสร้าง Subfolder ตามรหัสนักเรียน (`<TeacherSelectedFolder>/<studentId>/`) และการกระจาย `DependencyBundle` ไปยังเครื่องนักเรียนผ่าน LAN
- [ ] **10.1.2** สร้างระบบรับการส่งงานทั้งโปรเจกต์ (`VirtualProjectTree` upload & validation) ที่บันทึกทั้งลง SQLite และเขียนลงโฟลเดอร์ `<studentId>` บนเครื่องครูโดยอัตโนมัติ
- [ ] **10.2.1** อัปเกรด `GradingWorkerQueue` ให้ตรวจให้คะแนนครบทั้ง 4 หมวด (`cli-algorithm`, `frontend`, `backend`, `database`) พร้อมระบบจัดสรรพอร์ตไม่ให้ชนกันสำหรับโจทย์ Backend
- [ ] **10.3.1** สร้าง `StudentProjectInspectorModal.tsx` ที่แสดง Folder Tree + Multi-tab Monaco Editor เหมือนฝั่งนักเรียนทุกประการ พร้อมโหมดเทียบ Diff รายไฟล์และ Code Playback Timeline
- [ ] **10.3.2** สร้างฟีเจอร์ `Re-grade All Submissions` เมื่ออาจารย์ปรับแก้ Test Cases
- [ ] **10.4.1** สร้าง `CodeExporter` ที่ส่งออกทั้งไฟล์ CSV สรุปคะแนน และโฟลเดอร์โปรเจกต์ของนักเรียนทุกคนโดยรักษาลำดับชั้นของโฟลเดอร์ย่อยไว้ครบถ้วน

---

## 4. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **Multi-Folder Submission & Strip Node_Modules Test:** ทดสอบส่งโปรเจกต์ที่มีโฟลเดอร์ซ้อนกัน 4 ชั้น -> ระบบต้องบันทึกโครงสร้างไฟล์และโฟลเดอร์ทั้งหมดได้ครบถ้วนโดยไม่ส่งโฟลเดอร์ไลบรารีซ้ำซ้อน
   - **Concurrent Backend & SQL Grading Test:** จำลองการส่งงานโจทย์ Backend API และ Database SQL จากนักเรียน 20 คนพร้อมกันเข้า `GradingWorkerQueue` -> แต่ละ Worker ต้องได้พอร์ตและอินสแตนซ์ฐานข้อมูลแยกกัน ตรวจให้คะแนนถูกต้องโดยไม่มีพอร์ตชนกัน (`EADDRINUSE`)
2. **Manual Verification:**
   - นักเรียนสร้างโฟลเดอร์และไฟล์ใหม่ใน IDE แล้วกดส่งงาน -> อาจารย์เปิดดูใน `StudentProjectInspectorModal` เห็นโฟลเดอร์และไฟล์ทั้งหมดตรงกับฝั่งนักเรียนเป๊ะ เปิดดู Diff และกด Export ออกมาเป็นโฟลเดอร์จริงบนดิสก์ได้ครบถ้วน

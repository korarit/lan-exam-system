# Phase 11: `code-ide` Module (Part 4) — Multi-Stack End-to-End Testing, Stress & Security Verification

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
ทดสอบโมดูล **`code-ide`** (จาก Phase 8, 9, และ 10) อย่างครบวงจร ทั้งในด้านการทำงานกับ **โปรเจกต์หลายไฟล์และหลายโฟลเดอร์ (Multi-File & Nested Folders)**, การเรียกใช้งาน **Offline Libraries / Packages**, การตรวจให้คะแนนครบทั้ง **4 หมวดหมู่โจทย์ (CLI / Algorithm, Frontend UI, Backend API, และ Database / SQL)**, ความทนทานต่อโค้ดที่เป็นอันตราย, การทำงานร่วมกับระบบตรวจจับการโกง (Phase 3a), และการจำลองสอบจริงแบบเปิดเครื่องแม่และเครื่องลูกบนคอมพิวเตอร์เครื่องเดียวกัน (`dev:pair`)

### สิ่งที่ต้องได้เมื่อจบ Phase 11
- ชุดทดสอบอัตโนมัติ (`tests/modules/code-ide/`) ครอบคลุมการรันโปรเจกต์หลายไฟล์/หลายโฟลเดอร์พร้อม Libraries ในทุกหมวดหมู่โจทย์
- ผ่านการทดสอบ Stress Test (Infinite Loops, Server Port Conflicts, SQL Cross-Join Bombs, Memory/Stdout Floods) โดยไม่ทำให้หน้าจอ IDE หรือเครื่องแม่ค้าง
- ผ่านการทดสอบ End-to-End ตั้งแต่การที่อาจารย์อัปโหลดโปรเจกต์ตั้งต้น + เลือก Libraries -> เปิดห้องสอบ -> นักเรียนสร้างไฟล์/โฟลเดอร์เพิ่มและเขียนโค้ดกด Run -> ส่งงาน -> อาจารย์เปิดดูโครงสร้างโฟลเดอร์ของนักเรียนใน Mirror IDE Inspector -> ส่งออก CSV และโฟลเดอร์โปรเจกต์

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 11.1 Multi-File, Multi-Folder & Multi-Stack Execution Test Suite (`tests/code-ide/multi-stack.spec.ts`)
สร้างชุดโจทย์โปรเจกต์ทดสอบมาตรฐานที่ครอบคลุมทั้ง **4 หมวดหมู่โจทย์และทุกภาษาที่รองรับ** โดยใช้โครงสร้างหลายไฟล์/หลายโฟลเดอร์และเรียกใช้ Offline Libraries จริง:

1. **หมวด CLI / Systems / OOP Multi-File + Libraries (`c`, `cpp`, `rust`, `go`, `java`, `python`, `javascript`, `typescript`, `php`):**
   - **C (`gcc`) & C++ (`g++`):** ทดสอบโปรเจกต์ที่มี `main.c`/`main.cpp`, `include/calc.h`, `src/calc.c` พร้อมทดสอบการดักจับ Compile Error และ Runtime Crash (`Segmentation fault` / Division by zero)
   - **Rust (`rustc` / `cargo`):** ทดสอบโปรเจกต์หลายโมดูล (`src/main.rs`, `src/utils.rs`)
   - **Go (`go`):** ทดสอบโปรเจกต์หลายไฟล์ (`main.go`, `pkg/mathutil/sum.go`)
   - **PHP (`php`):** ทดสอบโปรเจกต์หลายไฟล์ที่มีการ `require_once` ข้ามโฟลเดอร์
   - **Java (`javac` + `java`):** ทดสอบโปรเจกต์ที่มีโฟลเดอร์แพ็กเกจ (`src/Main.java`, `src/models/User.java`) และเรียกใช้ไฟล์ `.jar` เสริม (เช่น `gson.jar`)
   - **Python (`python3`) & JS/TS (`node` + `esbuild`):** ทดสอบโปรเจกต์หลายโมดูลพร้อมการโหลด Offline library
2. **หมวด Frontend Multi-File & Component Folders (`html-css-js`, `react`):**
   - **HTML/CSS/JS:** ทดสอบโปรเจกต์ที่มี `index.html`, `styles/layout.css`, `scripts/app.js`
   - **React (`.tsx`):** ทดสอบโปรเจกต์ที่มี `src/App.tsx`, `src/components/Navbar.tsx`, `src/hooks/useFilter.ts` และเรียกใช้ Offline UI Library แล้วรันตรวจด้วย `DomTestCase`
3. **หมวด Backend REST API + Database (`node-backend`, `python-backend`, `go-backend`, `php-backend`):**
   - ทดสอบโปรเจกต์ Backend ที่มีโครงสร้างโฟลเดอร์ `routes/`, `db/` เชื่อมต่อกับฐานข้อมูล SQLite ตั้งต้น (`db/seed.sql`)
   - ทดสอบยิงชุดทดสอบ `HttpApiTestCase` ครบทั้ง `GET`, `POST`, `PUT`, `DELETE` พร้อมตรวจทั้ง HTTP Status Code, JSON Response, และตรวจว่าข้อมูลถูกบันทึกลงตาราง SQLite จริง
4. **หมวด Database / SQL — ทดสอบการลบข้อมูล/ลบตารางและการ Spawn DB ใหม่พร้อม Data เดิม (`sql-sqlite`):**
   - ทดสอบโจทย์ SQL ที่มีฐานข้อมูลตั้งต้น 3 ตาราง (`students`, `courses`, `enrollments`)
   - **ทดสอบคำสั่งลบ (`DELETE FROM`, `DROP TABLE`):** รันคำสั่ง SQL ของนักเรียนที่สั่ง `DELETE FROM enrollments WHERE score < 50;` หรือสั่ง `DROP TABLE courses;` ในรอบแรก -> ระบบต้องอนุญาตให้ลบได้และตรวจผลลัพธ์ถูกต้อง จากนั้นเมื่อรัน Test Case ถัดไปหรือกดรันใหม่ ระบบต้อง **Spawn ฐานข้อมูลใหม่ที่มีตาราง `courses` และข้อมูล `enrollments` ตั้งต้นเดิมกลับมาครบ 100%**!

---

### 11.2 Hostile Code, Resource Limit & Sandbox Stress Tests (`tests/code-ide/sandbox-stress.spec.ts`)
จำลองสถานการณ์ที่โค้ดโปรเจกต์ของนักเรียนทำงานผิดปกติหรือจงใจโจมตีระบบ:

1. **Infinite Loop, Hanging Backend Server & Child Process Tree Kill Test:**
   - รันโค้ดที่มี `while (true) {}` ใน CLI, Frontend Render Loop, และใน Route Handler ของ Backend API
   - **เกณฑ์ผ่าน:** ตัวรันต้องตัดจบการทำงานภายใน `timeoutMs + 300ms` คืนสถานะ `TIME_LIMIT_EXCEEDED`, คืนพอร์ต Localhost ทันที, และไม่มีโปรเซส `java`, `python`, หรือ `node` ค้างอยู่ใน OS
2. **SQL Heavy Query / Cartesian Join Interruption Test:**
   - รันคำสั่ง SQL ที่ทำ Recursive CTE ไม่รู้จบหรือ Cross Join ตารางขนาดใหญ่เกินเวลา `timeoutMs`
   - **เกณฑ์ผ่าน:** `SqlDatabaseRunner` ต้องสั่ง `interrupt()` และตัดจบภายในเวลาที่กำหนดโดยไม่ทำให้โปรเซสหลักค้าง
3. **Teacher Runtime Anti-File-Deletion & Read-Only Tampering Protection Test (เน้นหลักสำคัญที่สุด):**
   - จำลองให้นักเรียนส่งโค้ดที่มีคำสั่งลบไฟล์และโฟลเดอร์บนระบบไฟล์จริงในทุกภาษาขึ้นมารันตรวจบนเครื่องครู:
     - C / C++: `remove("...")`, `unlink("...")`, `std::filesystem::remove_all("..")`, `system("del ...")`
     - Rust / Go: `std::fs::remove_dir_all("..")`, `os.RemoveAll("..")`, `exec.Command(...)`
     - PHP: `unlink("...")`, `rmdir("..")`, `shell_exec("...")`
     - Python: `os.remove(...)`, `shutil.rmtree("..")`, `os.system("rmdir /s /q ...")`
     - Node/TS: `fs.rmSync("..", { recursive: true })`, `fs.unlinkSync(...)`, `child_process.execSync("del /f /s /q ...")`
     - Java: `Files.delete(...)`, `new File("...").delete()`, `Runtime.getRuntime().exec(...)`
   - จำลองการส่ง `VirtualProjectTree` จากฝั่งนักเรียนที่พยายามใส่พาธ `../../evil.sh` หรือแอบแก้ไฟล์ `readOnly: true`
   - **เกณฑ์ผ่าน:** `AntiDeleteRuntimeGuard` และ `WorkspaceMaterializer` ต้องบล็อกคำสั่งลบไฟล์บนดิสก์ทั้งหมดทันที คืนสถานะ Error/Security Violation โดยที่ไฟล์ในโฟลเดอร์ `<TeacherSelectedFolder>/<studentId>/` ของครูและไฟล์ระบบอยู่ครบ 100% ไม่ถูกลบแม้แต่ไบต์เดียว! (ขณะที่คำสั่ง SQL `DELETE` / `DROP TABLE` ในโจทย์ SQL ยังสามารถลบข้อมูลในฐานข้อมูลจำลองได้ตามปกติและ Spawn ใหม่ได้ทุกครั้ง)
4. **Missing Runtime Detection (No Auto-Download) Test:**
   - จำลองสภาพแวดล้อมที่ไม่พบ `javac` หรือ `python` -> ระบบต้องแสดงข้อความแจ้งให้ครูหรือนักเรียนติดตั้งเองอย่างชัดเจน (ไม่มีการพยายามดาวน์โหลด Runtime แยกจากอินเทอร์เน็ต) และเมื่อผู้ใช้ระบุพาธที่ติดตั้งแล้วกด `Re-scan` ระบบต้องพร้อมใช้งานทันที
5. **Stdout Flood & Memory Limit Enforcement Test:**
   - ทดสอบโค้ดที่พิมพ์ข้อมูลเกิน `256 KB` หรือจองหน่วยความจำเกิน `256 MB` -> ต้องถูกตัดจบอย่างปลอดภัยและลบโฟลเดอร์ชั่วคราว `ztcode-exec-<runId>` สะอาดทุกครั้ง

---

### 11.3 Security & Anti-Cheat Integration Tests (`tests/code-ide/security-integration.spec.ts`)
1. **Legitimate Execution & Loopback Backend Allowance:**
   - เมื่อนักเรียนกดรันโปรเจกต์หลายไฟล์ หรือรัน Backend API บน `127.0.0.1:<assignedPort>` ใน Sandbox ระบบ `ProcessInspector` และ `NetworkInspector` ต้องไม่แจ้งเตือนผิดพลาด (Zero False-Positive)
2. **True-Positive Detection on Student Code Calling External Network / AI APIs:**
   - จำลองให้นักเรียนเขียนโค้ดในไฟล์ย่อย `src/utils/helper.py` หรือใน Backend Route เพื่อแอบยิงออกไปหา `https://api.openai.com/...` หรือ IP ภายนอกนอกเหนือจาก `127.0.0.1`:
   - **เกณฑ์ผ่าน:** `NetworkInspector` / `DNS Cache Diff` ต้องตรวจจับได้ทันทีและส่ง Event **`STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL` (`CRITICAL`)** ไปยังเครื่องแม่พร้อมแนบไฟล์โค้ดของนักเรียน!
3. **Hidden Test Cases & Hidden Seed Data Zero-Leakage Audit:**
   - ตรวจสอบทุกข้อมูลที่ส่งไปยังเครื่องนักเรียนว่าไม่มี `hidden` test cases, `setupSqlOverride`, `hiddenFromStudent` files, หรือ `referenceSolutionEntries` รั่วไหลไปที่เครื่องนักเรียนแม้แต่ไบต์เดียว

---

### 11.4 Same-Machine End-to-End Simulation (`tests/code-ide/e2e-exam-flow.spec.ts`)
จำลองการสอบจริงครบวงจรในเครื่องเดียว (`1 Host + 2 Student Instances`):
1. **ขั้นที่ 1 (Teacher Project Builder & Root Folder Selection):**
   - ครูเลือกโฟลเดอร์เก็บงานหลักของห้องสอบ (`<TeacherWorkspaceFolder>`) และสร้างชุดข้อสอบ `.ztcode` ที่มี 4 ข้อครบทั้ง 4 หมวด:
     - ข้อ 1 (`CLI - Java`): โปรเจกต์หลายคลาส + `gson.jar`
     - ข้อ 2 (`Frontend - React`): โปรเจกต์หลายโฟลเดอร์ (`components/`, `styles/`)
     - ข้อ 3 (`Backend - Node/TS Express + SQLite`): โปรเจกต์สร้าง REST API เชื่อมฐานข้อมูล
     - ข้อ 4 (`Database - SQL`): โจทย์เขียนคำสั่ง SQL Query บนตารางตั้งต้น
2. **ขั้นที่ 2 (Lobby, Student Folder Selection & Dependency Sync):**
   - นักเรียนทั้ง 2 เครื่อง (`65010001` และ `65010002`) เลือกโฟลเดอร์เก็บงานบนเครื่องตัวเอง (`<StudentWorkspaceFolder>`), รับซิงก์ `DependencyBundle`, และรายงานความพร้อม `🟢 พร้อมสอบครบทุกสแต็ก`
3. **ขั้นที่ 3 (Student Multi-File Coding & Submission):**
   - นักเรียนสร้างไฟล์และโฟลเดอร์ใหม่ใน IDE (ตรวจสอบว่าไฟล์ถูกเขียนลงใน `<StudentWorkspaceFolder>` จริง), ทดสอบกด `Run Sample` ในทั้ง 4 หมวด, แล้วกดส่งงานขึ้นเครื่องแม่
4. **ขั้นที่ 4 (Teacher `<studentId>` Subfolder Verification & Mirror IDE Inspection):**
   - ตรวจสอบบนดิสก์เครื่องครูว่ามี Subfolder **`<TeacherWorkspaceFolder>/65010001/`** และ **`<TeacherWorkspaceFolder>/65010002/`** ถูกสร้างขึ้นอัตโนมัติพร้อมโครงสร้างไฟล์และโฟลเดอร์ครบทุกข้อตรงกับของนักเรียน
   - เครื่องแม่ตรวจให้คะแนนทั้ง 4 ข้อผ่าน `GradingWorkerQueue` และอาจารย์เปิด `StudentProjectInspectorModal` เห็นโครงสร้างโฟลเดอร์และไฟล์เหมือนที่นักเรียนเขียนทุกประการ

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **11.1.1** เขียนชุดทดสอบอัตโนมัติสำหรับโปรเจกต์หลายไฟล์/หลายโฟลเดอร์ + Offline Libraries ในหมวด **CLI (`Java`, `Python`, `JS/TS`)**
- [ ] **11.1.2** เขียนชุดทดสอบอัตโนมัติสำหรับโปรเจกต์หลายโฟลเดอร์ในหมวด **Frontend (`HTML/CSS/JS`, `React`)**
- [ ] **11.1.3** เขียนชุดทดสอบอัตโนมัติสำหรับหมวด **Backend REST API (`Node/TS`, `Python`)** และการตรวจด้วย `HttpApiTestCase`
- [ ] **11.1.4** เขียนชุดทดสอบอัตโนมัติสำหรับหมวด **Database / SQL (`SQLite`)** และการตรวจด้วย `SqlTestCase`
- [ ] **11.2.1** เขียนชุดทดสอบ Stress & Tampering Test (Infinite Loop, Hanging Server, SQL Timeout, Path Traversal, และ Read-Only File Protection)
- [ ] **11.3.1** เขียนชุดทดสอบการทำงานร่วมกับ `ProcessInspector` และ `NetworkInspector` (อนุญาต Loopback เฉพาะพอร์ต Backend Sandbox แต่จับกุมการต่อเน็ตนอกทันที)
- [ ] **11.4.1** สร้างสคริปต์และชุดทดสอบ End-to-End จำลองการสอบทั้ง 4 หมวดด้วยโหมดรันคู่ในเครื่องเดียว (`dev:pair`)

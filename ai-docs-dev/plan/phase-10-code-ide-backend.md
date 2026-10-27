# Phase 10: `code-ide` Module (Part 3) — Embedded Backend, Auto-Grader & Code Export

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
พัฒนาส่วน **Embedded Backend (`HostExamModuleBackend<'code-ide'>`)** ที่ทำงานอยู่ใน Electron Main Process ของเครื่องแม่ (Host) ทำหน้าที่จัดการการส่งโจทย์เขียนโค้ดให้เครื่องนักเรียน รับซอร์สโค้ดที่นักเรียนกดส่ง ประมวลผลการตรวจให้คะแนนอัตโนมัติกับชุดทดสอบลับ (**Hidden Grading Test Cases**) ทั้งแบบ CLI (Java, Python, JS, TS) และแบบ DOM/UI (HTML/CSS, React) เก็บประวัติการส่งโค้ดลง SQLite และส่งออกผลคะแนนพร้อมไฟล์ซอร์สโค้ดของนักเรียนทุกคน

### สิ่งที่ต้องได้เมื่อจบ Phase 10
- คลาส `CodeIdeModuleBackend` ที่ implement `HostExamModuleBackend` และลงทะเบียนเข้า `ExamModuleRegistry`
- ระบบเลือกโหมดการรันชุดทดสอบ:
  - **Sample Test Cases:** รันที่เครื่องนักเรียนเพื่อให้เห็นผลเร็วขณะเขียนโค้ด
  - **Hidden Grading Test Cases:** รันที่เครื่องแม่เมื่อกดส่งคำตอบ (โดยมี Worker Queue จำกัดจำนวนการรันพร้อมกันเพื่อไม่ให้ CPU เครื่องแม่เต็ม) เนื่องจากชุดทดสอบลับอยู่ที่เครื่องแม่เท่านั้น นักเรียนจึงไม่มีทางแงะดู Test Cases ลับได้
- หน้าจอ **Teacher Code Review & Grading Dashboard (`HostResponsesView`)**: ดูคะแนนที่ได้ตามจำนวน Test Cases ที่ผ่าน, เปิดอ่านโค้ดของนักเรียนพร้อมเทียบกับโค้ดเฉลย (Side-by-Side Diff), สั่งรันตรวจใหม่ทั้งห้อง (`Re-grade All Code`), และ Export คะแนนเป็น CSV พร้อมโฟลเดอร์ซอร์สโค้ดของนักเรียนทุกคน

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 10.1 Host Authoritative Code Dispatcher & Submission Queue (`src/modules/code-ide/main/code-module-backend.ts`)
1. **การส่งโจทย์ไปยังเครื่องนักเรียน (`initializeStudentSession`):**
   - ส่งเฉพาะรายละเอียดโจทย์, `starterFiles` (ที่ `hiddenFromStudent === false`), และรายการ `sampleTestCases` (`visibility === 'sample'`) ไปยังเครื่องนักเรียน
   - เก็บ `hiddenTestCases` (`visibility === 'hidden'`) และ `referenceSolutionFiles` ไว้ที่เครื่องแม่เท่านั้น
2. **การรับ Autosave และการส่งคำตอบ (`handleAutosaveDraft` & `handleStudentAction`):**
   - ทุกครั้งที่นักเรียนแก้โค้ด ระบบจะส่ง Snapshot ของ `VirtualFileTree` มาเก็บไว้ในตาราง `code_draft_snapshots` ที่เครื่องแม่ทุก 5 วินาที (กันไฟดับ/เครื่องค้าง)
   - เมื่อนักเรียนกด **`🚀 ส่งคำตอบข้อนี้ (Submit Solution)`**:
     - บันทึกไฟล์ทั้งหมดลงตาราง `code_submissions` แบบเข้ารหัส (AES-256-GCM) พร้อมเวลาที่ส่ง
     - นำงานส่งเข้า **`GradingWorkerQueue`** ที่ฝั่งเครื่องแม่ đểรันตรวจกับทั้ง Sample และ Hidden Test Cases

---

### 10.2 Multi-Language Auto-Grading Queue (`src/modules/code-ide/main/code-grader-queue.ts`)
เพื่อป้องกันไม่ให้กรณีที่นักเรียน 40 คนกดส่งโค้ดพร้อมกันในนาทีสุดท้ายทำให้ CPU ของเครื่องแม่ค้าง:

1. **Bounded Concurrency Worker Queue:**
   - ใช้คิวตรวจงานที่จำกัดจำนวนการรันขนานกันตามจำนวนคอร์ของ CPU เครื่องแม่ (เช่น `maxConcurrentRuns = Math.max(2, os.cpus().length - 2)`)
   - แสดงสถานะการตรวจแบบ Real-time บนหน้าจอครู (`กำลังตรวจในคิว... -> ตรวจเสร็จแล้ว: ผ่าน 9/10 เคส`)
2. **การคำนวณคะแนนรายข้อ (`CodeGradingSummary`):**
   - รันโค้ดที่นักเรียนส่งมากับทุก Test Case (`Sample` + `Hidden`) โดยใช้ `ProcessSandbox` และ `HeadlessDomRunner` จาก Phase 9:
     ```ts
     export interface TestCaseExecutionResult {
       testId: string
       title: string
       visibility: 'sample' | 'hidden'
       status: 'passed' | 'wrong-answer' | 'tle' | 'mle' | 'runtime-error' | 'compile-error'
       pointsEarned: number
       maxPoints: number
       durationMs: number
       actualOutputPreview?: string
       errorMessage?: string
     }
     ```
   - คำนวณคะแนนรวมของข้อนั้นจากผลรวม `pointsEarned` ของทุก Test Case ที่สถานะเป็น `'passed'`
   - รองรับการให้ครูตั้งคะแนนส่วนเพิ่มสำหรับตรวจโครงสร้างโค้ดด้วยตนเอง (Manual Code Quality / Style Rubric)

---

### 10.3 Teacher Code Review, Diff Viewer & Re-grade UI (`src/modules/code-ide/renderer/responses/`)
1. **ตารางสรุปผลคะแนนเขียนโค้ด (`CodeSubmissionsTable.tsx`):**
   - แสดงรายชื่อนักเรียน, ภาษาที่ใช้, จำนวนข้อที่ส่ง, แถบสีแสดงสัดส่วน Test Cases ที่ผ่านของแต่ละข้อ (เช่น `🟢 10/10`, `🟡 7/10 (3 TLE)`, `🔴 0/10 (Compile Error)`), เวลาที่ใช้, และสถานะความปลอดภัยจาก Triage
2. **หน้าต่างเปิดดูโค้ดและผลรันรายบุคคล (`StudentCodeInspectorModal.tsx`):**
   - เปิดดูไฟล์โค้ดทั้งหมดที่นักเรียนส่งมาใน **Monaco Read-Only / Diff Editor** (สามารถเปิดโหมดเทียบโค้ดของนักเรียนกับโค้ดเฉลยของครู หรือเทียบประวัติการพิมพ์โค้ดจาก Autosave Snapshots ตามเวลาเพื่อดูว่านักเรียนค่อยๆ เขียนโค้ดขึ้นมาเองหรือจู่ๆ โค้ดโผล่มาทั้งก้อนในครั้งเดียว!)
   - แสดงรายละเอียดผลรันของทุก Test Case (ทั้ง Sample และ Hidden) พร้อมช่องให้ครูปรับคะแนนหรือเขียนคอมเมนต์เพิ่มเติมได้
3. **ปุ่มสั่งตรวจโค้ดใหม่ทั้งห้อง (`Re-grade All Code Submissions`):**
   - หากครูปรับแก้ Test Case หรือเพิ่มเวลา Timeout หลังสอบเสร็จ สามารถกดสั่งให้ `GradingWorkerQueue` รันตรวจโค้ดของนักเรียนทุกคนใหม่ได้อัตโนมัติ

---

### 10.4 Code & Score Exporter (`src/modules/code-ide/main/code-exporter.ts`)
1. **การส่งออกคะแนนเป็นไฟล์ Excel / CSV (UTF-8 BOM):**
   - ส่งออกตารางคะแนนรวม, คะแนนรายข้อ, จำนวน Test Cases ที่ผ่าน (`Passed / Total`), เวลาเฉลี่ยในการรัน, และสถานะความปลอดภัย
2. **การส่งออกไฟล์ซอร์สโค้ดของนักเรียนทั้งห้อง (`Export Student Source Code Bundle`):**
   - สร้างโฟลเดอร์หรือไฟล์ ZIP ที่จัดระเบียบตามรหัสนักเรียนและข้อสอบ:
     ```text
     exported-submissions-<roomId>/
     ├── summary-scores.csv
     ├── 65010001_Somchai/
     │   ├── Q1_Java_Matrix/
     │   │   ├── Main.java
     │   │   └── grading-report.json
     │   └── Q2_React_Counter/
     │       ├── App.tsx
     │       ├── styles.css
     │       └── grading-report.json
     └── 65010002_Somsri/
         └── ...
     ```

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **10.1.1** สร้าง `CodeIdeModuleBackend` ที่ implement `HostExamModuleBackend` และลงทะเบียนเข้า `ExamModuleRegistry`
- [ ] **10.1.2** สร้างตาราง SQLite สำหรับเก็บ `code_draft_snapshots`, `code_submissions`, และ `code_test_results`
- [ ] **10.2.1** สร้าง `GradingWorkerQueue` ที่จำกัดจำนวนการรันขนานกันที่ฝั่งเครื่องแม่ และตรวจทั้ง Sample + Hidden Test Cases
- [ ] **10.2.2** สร้างระบบเก็บ Timeline ของ Code Snapshots (Code Playback History) จากการ Autosave เพื่อช่วยครูดูพัฒนาการการเขียนโค้ดของนักเรียน
- [ ] **10.3.1** สร้าง UI `CodeSubmissionsTable.tsx` และ `StudentCodeInspectorModal.tsx` (พร้อม Monaco Diff Viewer & Code Playback Slider)
- [ ] **10.3.2** สร้างฟีเจอร์ `Re-grade All Code Submissions` เมื่อครูแก้ไข Test Cases
- [ ] **10.4.1** สร้าง `CodeExporter` ส่งออกทั้งไฟล์ CSV คะแนน และโฟลเดอร์ซอร์สโค้ดของนักเรียนทุกคน

---

## 4. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **Worker Queue Concurrency Test:** จำลองการส่งโค้ดจากนักเรียน 30 คนเข้ามาพร้อมกันโดยตั้ง `maxConcurrentRuns = 4` -> งานทั้งหมดต้องถูกทยอยตรวจจนครบ 30 คนโดยไม่เกิด Race condition และไม่เกินจำนวนโปรเซสสูงสุดที่กำหนด
   - **Partial Test Case Scoring Test:** ส่งโค้ดที่ผ่าน Sample 2 เคส (เคสละ 5 คะแนน) และผ่าน Hidden 3 จาก 5 เคส (เคสละ 10 คะแนน) -> คะแนนรวมต้องคำนวณได้ `40 / 60` คะแนนอย่างแม่นยำ
2. **Manual Verification:**
   - ทดสอบกดส่งโค้ดจากหน้าต่างนักเรียน -> บนหน้าจอครูเห็นผลการตรวจทุก Test Case (รวมถึง Hidden Test Cases) เปิดดูโค้ดด้วย Monaco Diff Viewer เลื่อนดู Code Playback Timeline และกดส่งออกโฟลเดอร์ซอร์สโค้ดพร้อมไฟล์ CSV ได้ครบถ้วน


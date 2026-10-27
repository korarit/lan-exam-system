# Phase 8: `code-ide` Module (Part 1) — Multi-Language IDE UI, Problem Builder & Web/React Preview

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
พัฒนาส่วน **User Interface (Frontend/Renderer)** และโครงสร้างไฟล์โจทย์ (`.ztcode`) ของโมดูลการสอบเขียนโปรแกรม **`code-ide` (`src/modules/code-ide/`)** ที่ฝังอยู่ภายในแอป รองรับการเขียนโค้ดและแสดงผลครบทั้ง **6 กลุ่มภาษา/เทคโนโลยี**:
1. **Java** (`.java`)
2. **Python** (`.py`)
3. **JavaScript** (`.js`)
4. **TypeScript** (`.ts`)
5. **HTML + CSS (+ JS)** (`.html`, `.css`, `.js`)
6. **React (JSX / TSX + CSS)** (`.jsx`, `.tsx`, `.css`)

### สิ่งที่ต้องได้เมื่อจบ Phase 8
- โครงสร้างข้อมูล `CodeExamPackageSchema` และระบบบันทึก/โหลดไฟล์โจทย์เขียนโปรแกรม (`.ztcode`)
- **Student In-App IDE Workspace:** หน้าจอ IDE ภายใน Kiosk Shell ที่มีโจทย์ด้านซ้าย, File Tree + Multi-tab **Monaco Editor** ตรงกลาง, และแผงผลลัพธ์ด้านขวา/ล่างที่สลับตามประเภทภาษา (แสดง **Test & Console Output** สำหรับ Java/Python/JS/TS หรือแสดง **Sandboxed Live Web Preview + DOM Test Results** สำหรับ HTML/CSS และ React)
- **Teacher Code Problem Builder:** หน้าจอสร้างโจทย์เขียนโค้ดสำหรับครู กำหนดโครงสร้างไฟล์ตั้งต้น (Starter Files), โค้ดเฉลยอ้างอิง (Solution Files), และชุดทดสอบ (Sample Test Cases & Hidden Grading Test Cases)

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 8.1 โครงสร้างข้อมูลโจทย์เขียนโค้ดและไฟล์ `.ztcode` (`src/modules/code-ide/shared/code-schema.ts`)
1. **รายการภาษาและโหมดการรันที่รองรับ (`SupportedLanguage`):**
   ```ts
   export const SupportedCodeLanguageSchema = z.enum([
     'java',       // รันผ่าน javac + java (CLI / Stdout หรือ Method Harness)
     'python',     // รันผ่าน python3 (CLI / Stdout หรือ Function Harness)
     'javascript', // รันผ่าน Node.js runtime (CLI / Stdout หรือ Function Harness)
     'typescript', // Transpile ด้วย esbuild/ts + รันผ่าน Node.js runtime
     'html-css',   // เรนเดอร์ใน Sandboxed Preview + ตรวจด้วย DOM Assertions
     'react'       // Bundle ด้วย esbuild (JSX/TSX) + Offline React Vendor + ตรวจด้วย DOM Assertions
   ])
   ```
2. **โครงสร้างไฟล์โปรเจกต์จำลอง (`VirtualFileTree`):**
   - โจทย์แต่ละข้อสามารถมีได้ทั้งแบบ **ไฟล์เดียว** (เช่น `Main.java`, `solution.py`) หรือ **หลายไฟล์** (เช่น โจทย์ React ที่มี `App.tsx`, `components/Counter.tsx`, `styles.css` หรือโจทย์ HTML/CSS ที่มี `index.html`, `style.css`, `script.js`):
   ```ts
   export const VirtualFileSchema = z.object({
     path: z.string(),             // เช่น 'src/App.tsx' หรือ 'Main.java'
     content: z.string(),
     readOnly: z.boolean().default(false), // ล็อกไฟล์บางตัวไม่ให้นักเรียนแก้ (เช่น ไฟล์ Interface หรือ CSS ตั้งต้น)
     hiddenFromStudent: z.boolean().default(false) // ไฟล์ชุดทดสอบที่ซ่อนไว้ใช้ตอนรันตรวจ
   })
   ```
3. **โครงสร้างชุดทดสอบ (`CodeTestCaseSchema`):**
   รองรับทั้งการตรวจแบบ **Standard I/O / Function Return** (สำหรับ Java, Python, JS, TS) และการตรวจแบบ **DOM / UI Assertion** (สำหรับ HTML/CSS และ React):
   ```ts
   export const CliTestCaseSchema = z.object({
     testId: z.string(),
     kind: z.literal('stdio'),
     title: z.string(),
     stdin: z.string(),
     expectedStdout: z.string(),
     comparisonMode: z.enum(['trimmed-lines', 'exact', 'numeric-tolerance', 'json-equal']).default('trimmed-lines'),
     visibility: z.enum(['sample', 'hidden']), // 'hidden' เก็บไว้ที่เครื่องแม่เท่านั้น ห้ามส่งไป Client!
     points: z.number().positive(),
     timeoutMs: z.number().int().default(2000)
   })

   export const DomTestCaseSchema = z.object({
     testId: z.string(),
     kind: z.literal('dom-assertion'),
     title: z.string(), // เช่น "เมื่อกดปุ่ม #add-btn ตัวเลขใน #count ต้องเพิ่มขึ้นเป็น 1"
     assertionScript: z.string(), // สคริปต์ตรวจ DOM/Style/Event ในหน้า Preview
     visibility: z.enum(['sample', 'hidden']),
     points: z.number().positive(),
     timeoutMs: z.number().int().default(3000)
   })
   ```

---

### 8.2 Student In-App IDE Workspace UI (`src/modules/code-ide/renderer/student/`)
ออกแบบหน้าจอ IDE สำหรับนักเรียนให้อยู่ภายใต้กรอบ Kiosk HUD และ Watermark ของ Core Platform โดยแบ่งพื้นที่แบบปรับขนาดได้ (Resizable Split Panes):

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│ [Core Kiosk HUD: วิชา Object-Oriented & Web Programming | ข้อ 2/5 | ⏳ 01:42:10] │
├────────────────────┬────────────────────────────────────┬─────────────────────┤
│ 📄 โจทย์ (Problem)  │ 📁 Files   [App.tsx] [styles.css]  │ ▶ Live Preview      │
│                    ├────────────────────────────────────┤ (สำหรับ HTML/React) │
│ ข้อที่ 2:            │ 1  import React, { useState } ...  │ ┌─────────────────┐ │
│ สร้าง Component     │ 2  export function Counter() {     │ │ Count: 0        │ │
│ นับคะแนน...         │ 3    const [count, setCount] = ... │ │ [+ เพิ่ม] [- ลด] │ │
│                    │ 4    return (                      │ └─────────────────┘ │
│ ตัวอย่างผลลัพธ์:      │ 5      <div className="card">      ├─────────────────────┤
│ - มีปุ่ม #inc, #dec  │ 6        <span id="val">{count}    │ 🧪 ผลการรันทดสอบ    │
│                    │ 7      </div>                      │ ✅ Test 1: ผ่าน (12ms)│
│ [🔄 คืนค่าโค้ดตั้งต้น] │                                    │ ❌ Test 2: คาดหวัง 1  │
│                    │        (Monaco Editor)             │    แต่ได้ 0          │
│                    ├────────────────────────────────────┴─────────────────────┤
│                    │ [▶ รันโค้ด / ทดสอบ Sample (Ctrl+Enter)]  [🚀 ส่งคำตอบข้อนี้] │
└────────────────────┴──────────────────────────────────────────────────────────┘
```

1. **Monaco Editor Offline Integration (`MonacoCodeWorkspace.tsx`):**
   - โหลด Monaco Editor จาก Local Bundle 100% (ไม่ดึงจาก CDN)
   - ตั้งค่า Syntax Highlighting, Auto-closing brackets, Indentation, Error squiggles, และ Type definitions แบบออฟไลน์สำหรับ:
     - `java`, `python`, `javascript`, `typescript`, `html`, `css`, `typescriptreact` (`.tsx`), `javascriptreact` (`.jsx`)
   - รองรับการสลับแท็บไฟล์ (`VirtualFileTree`), ปุ่ม **`Reset to Starter Code`** (ย้อนกลับไปโค้ดตั้งต้นของครูโดยมี Modal ยืนยัน), และบันทึก Autosave ทุก 5 วินาที
2. **Dual-Mode Output & Runner Panel (`ExecutionOutputPanel.tsx`):**
   - **โหมด CLI (`java`, `python`, `javascript`, `typescript`):**
     - แท็บ **Test Results:** แสดงรายการ Sample Test Cases พร้อมสถานะ `✅ Passed`, `❌ Wrong Answer` (เทียบ `Expected` vs `Actual Output`), `⏱️ Time Limit Exceeded`, หรือ `💥 Runtime / Compile Error` (พร้อมไฮไลต์เลขบรรทัดที่เกิด Error ใน Monaco Editor)
     - แท็บ **Custom Input Console:** ให้นักเรียนพิมพ์ `stdin` ของตัวเองเพื่อทดลองกด `Run` ดูผลลัพธ์ `stdout` / `stderr`
   - **โหมด Web & React (`html-css`, `react`):**
     - แท็บ **Sandboxed Live Preview:** แสดงผลหน้าเว็บหรือ React Component ที่คอมไพล์แล้วใน `iframe` ที่เปิด `sandbox="allow-scripts"` (ปิดการเข้าถึงเครือข่ายและแยก Context ออกจากแอปสอบ) พร้อมแถบแสดง `console.log` / `console.error` ด้านล่าง
     - แท็บ **UI / DOM Test Cases:** แสดงผลการตรวจ Sample DOM Assertions (เช่น ตรวจว่ามี Element, สี/Layout ตรงตามโจทย์, หรือกดปุ่มแล้ว State เปลี่ยนถูกต้อง)

---

### 8.3 Teacher Code Problem Builder UI (`src/modules/code-ide/renderer/builder/`)
1. **หน้าจอสร้างและแก้ไขโจทย์เขียนโค้ด (`CodeExamBuilder.tsx`):**
   - เลือกภาษาของโจทย์แต่ละข้อ (`Java`, `Python`, `JavaScript`, `TypeScript`, `HTML/CSS`, `React`)
   - เมื่อเลือกภาษา ระบบจะสร้าง **Starter Template มาตรฐาน** ให้อัตโนมัติ:
     - **Java:** `Main.java` พร้อม `public class Main { public static void main(String[] args) { ... } }`
     - **Python:** `main.py`
     - **JS / TS:** `solution.js` หรือ `solution.ts`
     - **HTML / CSS:** `index.html`, `styles.css`, `script.js`
     - **React:** `App.tsx`, `styles.css`, `index.tsx` (ล็อก `index.tsx` เป็น `readOnly`)
   - **ตัวจัดการไฟล์ (`StarterFileManager`):** ครูสามารถเพิ่มไฟล์, ตั้งค่า `readOnly` (ไฟล์ที่ห้ามนักเรียนแก้), และเขียน **Reference Solution (โค้ดเฉลยของครู)**
   - **ปุ่ม `"▶ ทดสอบรันเฉลยของครูกับทุก Test Case"`:** ให้ครูกดทดสอบได้ทันทีในหน้า Builder ว่าโค้ดเฉลยของครูรันผ่านทั้ง Sample และ Hidden Test Cases ครบ 100% ก่อนบันทึกไฟล์ `.ztcode`

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **8.1.1** สร้าง Zod schemas สำหรับ `SupportedCodeLanguageSchema`, `VirtualFileSchema`, `CliTestCaseSchema`, `DomTestCaseSchema`, และ `CodeExamPackageSchema`
- [ ] **8.1.2** สร้างระบบ Save / Load ไฟล์ชุดข้อสอบเขียนโปรแกรม `.ztcode` (รองรับการเข้ารหัสด้วยรหัสผ่านครูเหมือน `.ztform`)
- [ ] **8.2.1** ตั้งค่า Monaco Editor แบบออฟไลน์พร้อม Workers และ Type definitions สำหรับ JS, TS, React (`.tsx`/`.jsx`), HTML, CSS, Python, และ Java
- [ ] **8.2.2** สร้าง `FileExplorerTree.tsx` และระบบ Multi-tab Editor ที่เคารพแฟล็ก `readOnly` ของแต่ละไฟล์
- [ ] **8.2.3** สร้าง `CliTestRunnerPanel.tsx` แสดงผลเปรียบเทียบ `Input / Expected / Actual / Stderr / Execution Time`
- [ ] **8.2.4** สร้าง `WebReactPreviewPanel.tsx` แสดงผล HTML/CSS และ React ใน Sandboxed Iframe พร้อม Console Drawer
- [ ] **8.3.1** สร้างหน้าจอ `CodeExamBuilder.tsx` สำหรับครู พร้อม Starter Templates ทั้ง 6 ภาษาและตัวจัดการ Sample / Hidden Test Cases

---

## 4. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **Schema & Strip Hidden Tests:** ทดสอบว่าฟังก์ชันสร้างโจทย์ส่งให้นักเรียนตัด `hidden` test cases, `referenceSolutionFiles`, และไฟล์ที่มี `hiddenFromStudent: true` ออก 100%
   - **`.ztcode` File Round-Trip Test:** ทดสอบบันทึกและโหลดชุดข้อสอบที่มีครบทั้ง 6 ภาษากลับมาได้ข้อมูลไฟล์และชุดทดสอบครบถ้วน
2. **Manual Verification:**
   - เปิดหน้า Builder สร้างโจทย์ทั้ง 6 ภาษา (Java, Python, JS, TS, HTML/CSS, React) และสลับเข้าโหมด Preview ของนักเรียน -> Monaco Editor แสดง Syntax Highlighting ถูกต้องทุกภาษา สลับไฟล์ใน Tree ได้ และล็อกไฟล์ `readOnly` ไม่ให้พิมพ์แก้ได้จริง


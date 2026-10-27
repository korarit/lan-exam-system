# Phase 11: `code-ide` Module (Part 4) — End-to-End Testing, Stress & Security Verification

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
ทดสอบโมดูล **`code-ide`** (จาก Phase 8, 9, และ 10) อย่างครบวงจร ทั้งในด้านความถูกต้องของการรันโค้ดทั้ง 6 ภาษา (**Java, Python, JavaScript, TypeScript, HTML/CSS, React**), ความทนทานต่อโค้ดที่เป็นอันตรายหรือเขียนผิดพลาด (Infinite Loops, Memory Bombs, Stdout Floods), การทำงานร่วมกับระบบตรวจจับการโกง (Phase 3a), และการจำลองสอบจริงแบบเปิดเครื่องแม่และเครื่องลูกบนคอมพิวเตอร์เครื่องเดียวกัน (`dev:pair`)

### สิ่งที่ต้องได้เมื่อจบ Phase 11
- ชุดทดสอบอัตโนมัติ (`tests/modules/code-ide/`) ครอบคลุมทั้ง 6 ภาษาและกรณีขอบเขต (Edge Cases) ทั้งหมด
- ผ่านการทดสอบ Stress Test เมื่อรันโค้ดที่ค้างหรือกินทรัพยากรหนักโดยไม่ทำให้หน้าจอ IDE หรือเครื่องแม่ค้าง
- ผ่านการทดสอบ End-to-End ตั้งแต่สร้างไฟล์ `.ztcode` -> เปิดห้องสอบ -> นักเรียนเขียนโค้ดกด Run Sample -> ส่งคำตอบ -> เครื่องแม่รันตรวจ Hidden Test Cases -> ส่งออก CSV และซอร์สโค้ด

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 11.1 Multi-Language Execution & Grading Test Suite (`tests/code-ide/languages.spec.ts`)
สร้างชุดโจทย์และโค้ดทดสอบมาตรฐานสำหรับทั้ง **6 ภาษา/เทคโนโลยี** โดยทดสอบครบทั้ง 4 กรณีต่อภาษา (`1. โค้ดที่ถูก 100%`, `2. โค้ดที่ตอบผิดบางเคส`, `3. โค้ดที่มี Syntax/Compile Error`, `4. โค้ดที่เกิด Runtime Exception`):

1. **Java (`javac` + `java`):**
   - ทดสอบโจทย์แบบคลาสเดียว (`Main.java`) และหลายคลาส (`Main.java` + `Helper.java`)
   - ทดสอบการรับค่าภาษาไทยและ UTF-8 ผ่าน `Scanner(System.in)` และ `System.out.println`
   - ทดสอบกรณีเกิด `NullPointerException`, `ArrayIndexOutOfBoundsException`, และ Compile Error ว่าดึงเลขบรรทัดมาแสดงใน Monaco Editor ได้ตรงจุด
2. **Python (`python3`):**
   - ทดสอบการรับค่า `sys.stdin.read()` / `input()` และการคำนวณทั้งตัวเลขและข้อความ
   - ทดสอบกรณี `SyntaxError`, `IndentationError`, และ `ZeroDivisionError`
3. **JavaScript & TypeScript (`node` + `esbuild`):**
   - ทดสอบโค้ดที่ใช้ TypeScript Interfaces / Generics ว่าถูกแปลงด้วย `esbuild` และรันผ่าน Node.js ได้ผลลัพธ์ถูกต้อง
   - ทดสอบการแจ้งเตือน Type/Syntax Error พร้อมตำแหน่งบรรทัดที่ถูกต้องจาก Source Map
4. **HTML + CSS (`HeadlessDomRunner`):**
   - ทดสอบโจทย์สร้างหน้าเว็บที่มีการตรวจด้วย `DomTestCase`:
     - ตรวจโครงสร้าง DOM (`document.querySelectorAll('.card').length === 3`)
     - ตรวจ Computed CSS Styles (`getComputedStyle(el).display === 'flex'`, `flexDirection`, สี, ขนาด)
     - ตรวจการทำงานของ Vanilla JS Event (`button.click()` แล้วข้อความใน DOM เปลี่ยนตามที่กำหนด)
5. **React (`JSX / TSX` + Offline React Bundle + `HeadlessDomRunner`):**
   - ทดสอบโจทย์ React ที่มีหลาย Component (`App.tsx` import `Counter.tsx` และ `styles.css`)
   - ทดสอบการใช้งาน React Hooks (`useState`, `useEffect`, `useMemo`) แบบออฟไลน์ 100%
   - ทดสอบการจำลองคลิกปุ่มและกรอกฟอร์มใน React Component แล้วตรวจว่า DOM อัปเดตตรงตาม Hidden DOM Test Cases

---

### 11.2 Hostile Code, Resource Limit & Sandbox Stress Tests (`tests/code-ide/sandbox-stress.spec.ts`)
จำลองสถานการณ์ที่โค้ดของนักเรียนทำงานผิดปกติหรือจงใจทำให้ระบบค้าง:

1. **Infinite Loop & Child Process Tree Termination Test:**
   - รันโค้ดที่มี `while (true) {}` ใน Java, Python, JS/TS, และใน React Render loop
   - รันโค้ดที่พยายามสร้างโปรเซสลูกซ้อนขึ้นมาอีกที (Subprocess spawning)
   - **เกณฑ์ผ่าน:** ตัวรันต้องตัดจบการทำงานภายใน `timeoutMs + 300ms` คืนสถานะ `TIME_LIMIT_EXCEEDED` และตรวจสอบด้วย `systeminformation.processes()` ว่าไม่มีโปรเซส `java`, `python`, หรือ `node` ค้างอยู่ในเครื่องเลยแม้แต่ตัวเดียว
2. **Stdout / Stderr Flood Protection Test:**
   - รันโค้ดที่สั่งพิมพ์ข้อมูลขนาดใหญ่ไม่หยุด เช่น `while True: print("X" * 100000)`
   - **เกณฑ์ผ่าน:** ตัวรันต้องตัดข้อมูลที่ `256 KB` สั่งหยุดโปรเซสทันที และคืนสถานะ `OUTPUT_LIMIT_EXCEEDED` โดยที่หน่วยความจำของ Electron Main Process ไม่พุ่งสูงขึ้น
3. **Memory Limit Enforcement Test:**
   - รันโค้ดที่พยายามจอง Array ขนาดใหญ่เกินพิกัด (เช่น จองแรม > 512 MB)
   - **เกณฑ์ผ่าน:** JVM (`-Xmx256m`) และ Node (`--max-old-space-size=256`) ต้องตัดการทำงานด้วย Out-Of-Memory Error อย่างปลอดภัยโดยไม่กระทบตัวแอปสอบ
4. **Filesystem Isolation Check:**
   - ทดสอบตรวจสอบว่าโฟลเดอร์ชั่วคราว `ztcode-exec-<runId>` ถูกลบทิ้งสะอาดทุกครั้งหลังรันเสร็จ ทั้งในกรณีรันผ่านปกติและกรณีเกิด Timeout / Error

---

### 11.3 Security & Anti-Cheat Integration Tests (`tests/code-ide/security-integration.spec.ts`)
ทดสอบการทำงานร่วมกันระหว่างโมดูล `code-ide` กับระบบตรวจจับการโกง (Phase 3a):

1. **No False-Positive on Legitimate Code Execution:**
   - เมื่อนักเรียนกดปุ่ม `▶ Run Sample Tests` ใน IDE ของแอป โปรเซส `javac`, `java`, `python`, `node` ที่ถูกสร้างโดย `ProcessSandbox` ของเราต้อง **ไม่** ถูก `ProcessInspector` แจ้งเตือนว่าเป็นโปรเซสแปลกปลอม
2. **True-Positive Detection on Student Code Calling External Network / AI APIs:**
   - จำลองให้นักเรียนเขียนโค้ด Python ในช่อง Editor ของแอป:
     ```python
     import urllib.request
     urllib.request.urlopen("https://api.openai.com/v1/models", timeout=1)
     ```
     แล้วกด `Run`:
   - **เกณฑ์ผ่าน:** `NetworkInspector` / `DNS Cache Diff` ต้องตรวจจับได้ทันทีว่าโปรเซสลูกของการรันโค้ดพยายามเรียกโดเมน AI ภายนอก และส่ง Event **`STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL` (`CRITICAL`)** ไปยังเครื่องแม่ ทำให้การ์ดนักเรียนขึ้นสีแดงบน Dashboard ทันที!
3. **Hidden Test Cases Zero-Leakage Audit:**
   - ดักจับทุก Packet ที่วิ่งผ่านท่อ TLS และทุกข้อความใน IPC ของฝั่งนักเรียน ตรวจสอบว่าไม่มีข้อมูลของ `hidden` test cases (`stdin`, `expectedStdout`, `assertionScript`) หรือ `referenceSolutionFiles` ปรากฏในฝั่งเครื่องนักเรียนเลย 100%

---

### 11.4 Same-Machine End-to-End Simulation (`tests/code-ide/e2e-exam-flow.spec.ts`)
ทดสอบจำลองการสอบจริงครบวงจรในเครื่องเดียว (`1 Host + 2 Student Instances`):
1. **ขั้นที่ 1 (Host Builder):** สร้างชุดข้อสอบ `.ztcode` ที่มี 3 ข้อ (ข้อ 1: Python, ข้อ 2: Java, ข้อ 3: React) พร้อม Sample และ Hidden Test Cases
2. **ขั้นที่ 2 (Lobby & Toolchain Check):** เปิดห้องสอบ -> นักเรียนทั้ง 2 เครื่องเชื่อมต่อเข้ามา -> หน้าจอครูแสดงสถานะความพร้อมของ Runtime (`Java ✅ | Python ✅ | Node/React ✅`)
3. **ขั้นที่ 3 (Live Coding & Sample Run):**
   - นักเรียนคนที่ 1 เขียนโค้ดถูกต้องครบทั้ง 3 ข้อ กด `Run Sample` ผ่านทั้งหมด และกด `Submit`
   - นักเรียนคนที่ 2 เขียนข้อ 1 ผ่านครึ่งเดียว, ข้อ 2 ติด Infinite Loop (`TLE`), และข้อ 3 ทำถูกต้อง
4. **ขั้นที่ 4 (Auto-Grading & Export):**
   - `GradingWorkerQueue` ที่เครื่องแม่ตรวจให้คะแนนทั้งสองคนเสร็จสมบูรณ์
   - ทดสอบเปิดหน้า `StudentCodeInspectorModal` ดูผลรายเคส, เลื่อนดู Code Playback Timeline, ทดสอบกด `Re-grade All`, และกด Export เป็นไฟล์ CSV + โฟลเดอร์ซอร์สโค้ด

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **11.1.1** เขียนชุดทดสอบอัตโนมัติสำหรับการรันและตรวจคำตอบภาษา **Java** และ **Python**
- [ ] **11.1.2** เขียนชุดทดสอบอัตโนมัติสำหรับการรันและตรวจคำตอบภาษา **JavaScript** และ **TypeScript**
- [ ] **11.1.3** เขียนชุดทดสอบอัตโนมัติสำหรับการ Bundling และรัน DOM Assertions ของ **HTML/CSS** และ **React (`.jsx`/`.tsx`)**
- [ ] **11.2.1** เขียนชุดทดสอบ Stress Test สำหรับ Infinite Loop, Process Tree Kill, Stdout Flood, และ Memory Limit
- [ ] **11.3.1** เขียนชุดทดสอบการทำงานร่วมกับ `ProcessInspector` และ `NetworkInspector` (ตรวจจับโค้ดที่แอบต่อเน็ตนอก และตรวจว่า Hidden Test Cases ไม่รั่วไหล)
- [ ] **11.4.1** สร้างสคริปต์และชุดทดสอบ End-to-End จำลองการสอบเขียนโปรแกรมครบวงจรด้วยโหมดรันคู่ในเครื่องเดียว (`dev:pair`)


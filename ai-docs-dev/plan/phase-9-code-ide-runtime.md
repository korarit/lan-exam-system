# Phase 9: `code-ide` Module (Part 2) — External OS Runtime Bridge & Execution Engine

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
พัฒนาเอนจินสำหรับ **คอมไพล์และรันโค้ด (`Runtime Execution Engine`)** ของโมดูล `code-ide` โดยเรียกใช้งาน **Compiler / Interpreter ด้านนอกที่ติดตั้งอยู่ในเครื่อง (External OS Runtimes)** เหมือนที่ IDE มาตรฐาน (เช่น VS Code, IntelliJ, PyCharm) ทำ สำหรับ **Java, Python, JavaScript, และ TypeScript** พร้อมตัว Bundler และ Headless DOM Runner แบบออฟไลน์สำหรับ **HTML/CSS และ React** โดยมีระบบจำกัดเวลา (Timeout), จำกัดหน่วยความจำ/ขนาดเอาต์พุต, และประสานงานกับระบบตรวจจับการโกง (Phase 3a) อย่างปลอดภัย

### สิ่งที่ต้องได้เมื่อจบ Phase 9
- ระบบ **Runtime Detector & Toolchain Doctor** ค้นหาและตรวจสอบความพร้อมของ `java`/`javac`, `python`/`python3`, และ `node` ในเครื่อง พร้อมหน้าจอตั้งค่าพาธหากไม่ได้อยู่ใน System PATH
- ตัวรันโค้ดสำหรับ **Java, Python, JavaScript, และ TypeScript** ในโฟลเดอร์ชั่วคราวแยกต่อการรัน (`Isolated Run Directory`) พร้อมระบบฆ่าโปรเซสทั้งตระกูล (Process Tree Kill) ทันทีเมื่อเกิด Infinite Loop (Time Limit Exceeded)
- ตัว Bundler ออฟไลน์ความเร็วสูง (ใช้ `esbuild` + Offline React Vendor Bundle) และตัวรันตรวจ DOM Assertions สำหรับ **HTML/CSS และ React** โดยไม่ต้องต่ออินเทอร์เน็ตหรือรัน `npm install`

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 9.1 External OS Runtime Locator & Toolchain Doctor (`src/modules/code-ide/main/runtime-locator.ts`)
เหมือนกับที่ IDE ทั่วไปเรียกใช้ SDK/Runtime ในเครื่อง ระบบจะต้องค้นหาและตรวจสอบเวอร์ชันของเครื่องมือก่อนเริ่มสอบ:

1. **การค้นหาพาธของ Runtime อัตโนมัติ (`discoverRuntimes()`):**
   - **Java (`javac` & `java`):**
     - ลองค้นหาจาก `process.env.JAVA_HOME`, คำสั่ง `where javac` (Windows) / `which javac` (macOS/Linux), และพาธมาตรฐาน เช่น `C:\Program Files\Eclipse Adoptium\jdk-*\bin`, `C:\Program Files\Java\jdk-*\bin`, `/Library/Java/JavaVirtualMachines/*/Contents/Home/bin`, `/usr/lib/jvm/*/bin`
     - ทดสอบรัน `javac -version` และ `java -version` เพื่อดึงเลขเวอร์ชัน (เช่น `OpenJDK 21.0.4`)
   - **Python (`python3` / `python` / `py`):**
     - ค้นหาจาก System PATH และพาธมาตรฐาน (`%LOCALAPPDATA%\Programs\Python\Python3*\python.exe`, `/usr/bin/python3`, `/opt/homebrew/bin/python3`)
     - ทดสอบรัน `python -I --version`
   - **Node.js / JavaScript / TypeScript:**
     - ค้นหา `node` จากเครื่อง หรือสามารถใช้ไบนารีของระบบผ่านโหมดควบคุมภายใน พร้อมใช้ `esbuild` (ที่ฝังมากับแอป) ทำหน้าที่แปลง TypeScript (`.ts`) เป็น JavaScript (`.js`) ในหน่วยความจำภายในเวลา `< 15 ms` โดยไม่ต้องพึ่ง `tsc` ภายนอก
2. **Pre-Exam Toolchain Readiness Check (ตรวจความพร้อมตั้งแต่ในห้อง Lobby):**
   - เมื่อนักเรียนเข้าห้องสอบที่ใช้โมดูล `code-ide` (เช่น วิชา Java + Python):
   - เครื่องนักเรียนจะตรวจสอบทันทีว่าเครื่องคอมพิวเตอร์ตัวนั้นมี `javac` และ `python` พร้อมใช้งานหรือไม่ แล้วส่งสถานะ `RUNTIME_READINESS_REPORT` ไปแสดงบนหน้าจอครู:
     - `🟢 เครื่องที่ 12: Java 21 ✅ | Python 3.12 ✅`
     - `🔴 เครื่องที่ 18: ไม่พบ javac ในเครื่อง!` (ครูสามารถเดินไปตั้งค่าพาธ JDK หรือย้ายเครื่องให้นักเรียนได้ตั้งแต่ก่อนกดเริ่มสอบ!)

---

### 9.2 Process Sandbox, Timeout Killer & Output Limiter (`src/modules/code-ide/main/process-sandbox.ts`)
เมื่อนักเรียนเขียนโค้ดที่มี `while (true) {}` หรือสั่งพิมพ์ข้อความไม่รู้จบ ตัวรันต้องจัดการได้อย่างเด็ดขาดโดยไม่ทำให้แอปสอบค้าง:

1. **การเตรียมโฟลเดอร์ชั่วคราวแยกต่อการรัน (`Ephemeral Workspace`):**
   - สร้างโฟลเดอร์ใหม่ที่ `os.tmpdir()/ztcode-exec-<runId>/`
   - เขียนไฟล์โค้ดของนักเรียนลงในโฟลเดอร์นั้นด้วยรหัสตัวอักษร `UTF-8`
   - ล้าง Environment Variables ที่ไม่จำเป็นออก (`env: { PATH: minimalSafePath, PYTHONIOENCODING: 'utf-8', LANG: 'en_US.UTF-8' }`) เพื่อไม่ให้สคริปต์แอบอ่านตัวแปรความลับของระบบ
2. **การรันตามภาษา (Language Execution Adapters):**
   - **Python Adapter:**
     - รันคำสั่ง: `python -I -B -u <entryFile.py>` (`-I` = isolated mode ไม่โหลด user site-packages ที่แอบฝังไว้, `-B` = ไม่เขียน `.pyc`, `-u` = unbuffered stdout/stderr)
   - **Java Adapter:**
     - **ขั้นที่ 1 (Compile):** รัน `javac -encoding UTF-8 -d . <allJavaFiles>` (จำกัดเวลาคอมไพล์ `10,000 ms`)
     - หากคอมไพล์ไม่ผ่าน (`exitCode !== 0`): แปลงข้อความจาก `stderr` ออกเป็นโครงสร้าง `{ file, line, column, message }` ส่งกลับไปไฮไลต์เส้นหยักสีแดงใน Monaco Editor ทันที
     - **ขั้นที่ 2 (Execute per Test Case):** รัน `java -Dfile.encoding=UTF-8 -Xmx256m -XX:+UseSerialGC <MainClass>` (จำกัด Heap memory ที่ `256 MB` ต่อการรัน)
   - **JavaScript & TypeScript Adapter:**
     - หากเป็น `.ts` ให้แปลงเป็น `.js` ด้วย `esbuild.transform(code, { loader: 'ts', target: 'es2022', sourcemap: 'inline' })`
     - รันด้วย `node --max-old-space-size=256 --disallow-code-generation-from-strings <entryFile.js>`
3. **การป้อน `stdin` การจำกัดขนาด `stdout/stderr` และการฆ่า Process Tree:**
   - เขียนข้อมูล `testCase.stdin` เข้าไปยัง `child.stdin` แล้วสั่ง `child.stdin.end()`
   - **Output Truncation Guard:** สะสมข้อมูลจาก `child.stdout` และ `child.stderr` ไม่เกิน `256 KB` ต่อสตรีม หากเกินขีดจำกัดให้หยุดรับข้อมูล, สั่งฆ่าโปรเซส, และคืนสถานะ `OUTPUT_LIMIT_EXCEEDED`
   - **Strict Timeout & Process Tree Termination:**
     - ตั้งจับเวลาตาม `testCase.timeoutMs` (เช่น `2,000 ms`)
     - หากหมดเวลาแล้วโปรเซสยังไม่จบ:
       - **บน Windows:** สั่ง `taskkill /PID <child.pid> /T /F` เพื่อฆ่าทั้งโปรเซสหลักและโปรเซสลูกทั้งหมดที่อาจถูก fork ออกมา
       - **บน macOS / Linux:** รัน `spawn` ด้วย `{ detached: true }` แล้วสั่ง `process.kill(-child.pid, 'SIGKILL')` เพื่อฆ่าทั้ง Process Group ทันที
     - ลบโฟลเดอร์ `ztcode-exec-<runId>` ทิ้งทุกครั้งในบล็อก `finally`

---

### 9.3 Offline Bundler & Headless DOM Runner สำหรับ HTML/CSS และ React (`src/modules/code-ide/main/web-react-runner.ts`)
สำหรับการสอบเขียนเว็บด้วย **HTML/CSS** หรือ **React (`.jsx`/`.tsx`)** ในห้องสอบที่ปิดอินเทอร์เน็ต:

1. **Offline React & TypeScript Bundler (ไม่ต้องใช้ `npm install`):**
   - แอปฝังไฟล์ไลบรารีมาตรฐาน (`react.production.min.js`, `react-dom-client.production.min.js`) ไว้ใน Local Assets ของแอปแล้ว
   - เมื่อนักเรียนกด `Run` หรือกดส่งคำตอบโจทย์ React:
     - ใช้ `esbuild` อ่านไฟล์ `.tsx` / `.jsx` / `.ts` / `.css` จาก `VirtualFileTree` ในหน่วยความจำของนักเรียน
     - แปลง `import React from 'react'` และ `import ReactDOM from 'react-dom/client'` ให้ชี้ไปยัง Offline React Runtime ที่ฝังไว้
     - สร้างออกมาเป็นเอกสาร HTML ชุดสมบูรณ์พร้อมแสดงผลและทดสอบภายในเวลา `< 50 ms`!
2. **Sandboxed Headless DOM Test Runner:**
   - สร้าง `BrowserWindow({ show: false, width: 1024, height: 768, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'nopersist:dom-test-runner' } })`
   - บล็อกทุก Request ใน `session.fromPartition('nopersist:dom-test-runner')` ที่พยายามออกสู่อินเทอร์เน็ตภายนอก (`callback({ cancel: true })`)
   - โหลด HTML/React bundle ของนักเรียนเข้าไปเรนเดอร์
   - รันสคริปต์ `DomTestCase.assertionScript` ของแต่ละข้อผ่าน `webContents.executeJavaScript(...)` พร้อมจับเวลา Timeout (เช่น `3,000 ms`)
   - เก็บผลลัพธ์ `{ passed: boolean, errorMessage?: string, consoleLogs: string[] }` ส่งกลับไปแสดงผล

---

### 9.4 การทำงานร่วมกับระบบตรวจจับการโกง (`Phase 3a Guard Integration`)
เพื่อไม่ให้การรัน `javac`, `java`, `python`, หรือ `node` ที่เกิดจากการกดปุ่ม `Run` ในแอปสอบ ถูก `ProcessInspector` (Phase 3a) เข้าใจผิดว่าเป็นโปรเซสแปลกปลอม แต่ในขณะเดียวกันยังป้องกันไม่ให้นักเรียนเขียนโค้ด Python/Java เพื่อแอบยิง API ออกไปหา AI ข้างนอก:

1. **PID Registration with `ProcessInspector`:**
   - เมื่อ `ProcessSandbox` สั่ง `spawn` โปรเซสลูก (`pid`) จะลงทะเบียน `pid` และ `runId` เข้าสู่ `AuthorizedChildProcessRegistry` ชั่วคราวจนกว่าโปรเซสนั้นจะจบการทำงาน
2. **Strict Network Monitoring on Student Code (`NetworkInspector` Hook):**
   - แม้ `pid` ของโค้ดที่นักเรียนรันจะได้รับอนุญาตให้ประมวลผลได้ แต่ใน Mode 1 และ Mode 2 **ไม่อนุญาตให้โปรเซสโค้ดของนักเรียนเปิด Socket ออกสู่เครือข่ายเด็ดขาด!**
   - หากนักเรียนเขียนโค้ด Python เช่น `import urllib.request; urllib.request.urlopen("https://api.openai.com/...")` แล้วกด Run:
     - ตัว `NetworkInspector` และ DNS Cache Diff (Phase 3a) จะตรวจพบทันทีว่าโปรเซสลูกของการรันโค้ดพยายามเชื่อมต่อไปยังโดเมนภายนอก และยิงแจ้งเตือนสีแดง **`STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL` (`CRITICAL`)** พร้อมแนบซอร์สโค้ดที่นักเรียนเพิ่งกดรันส่งไปให้ครูดูบน Dashboard ทันที!

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **9.1.1** สร้าง `RuntimeLocator` ค้นหาและตรวจสอบเวอร์ชันของ `javac`, `java`, `python`, และ `node` บน Windows, macOS, และ Linux
- [ ] **9.1.2** สร้างระบบรายงานความพร้อมของ Runtime (`RUNTIME_READINESS_REPORT`) ไปแสดงบนหน้า Lobby ของครู
- [ ] **9.2.1** สร้าง `ProcessSandbox` ที่จัดการโฟลเดอร์ชั่วคราว, ป้อน `stdin`, จำกัดขนาด `stdout/stderr` (256 KB), และฆ่า Process Tree เมื่อ Timeout
- [ ] **9.2.2** สร้าง Language Adapters สำหรับ **Python**, **Java** (พร้อมตัวแปลงข้อความ Compile Error ให้ชี้เลขบรรทัด), **JavaScript**, และ **TypeScript** (`esbuild`)
- [ ] **9.3.1** สร้าง Offline React & HTML/CSS Bundler ด้วย `esbuild` และฝัง Offline React Vendor Runtime
- [ ] **9.3.2** สร้าง `HeadlessDomRunner` สำหรับรันตรวจโจทย์ HTML/CSS และ React ด้วย DOM Assertions ในหน้าต่างซ่อนที่ตัดขาดเครือข่าย
- [ ] **9.4.1** เชื่อมต่อ `AuthorizedChildProcessRegistry` เข้ากับ `ProcessInspector` และ `NetworkInspector` (Phase 3a)

---

## 4. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **6-Language Execution Test:** ทดสอบรันโค้ดตัวอย่างทั้ง 6 ภาษา (Java, Python, JS, TS, HTML/CSS, React) แล้วตรวจว่าได้ผลลัพธ์ถูกต้องครบทุกภาษา
   - **Infinite Loop Kill Test:** ทดสอบรันโค้ดที่มี `while(true){}` ใน Python, Java, และ JS โดยตั้ง `timeoutMs: 1000` -> โปรเซสต้องถูกฆ่าภายใน ~1 วินาที คืนสถานะ `TIME_LIMIT_EXCEEDED` และไม่มีโปรเซสค้าง (`orphan process`) เหลืออยู่ใน OS
   - **Compilation Error Mapping Test:** ส่งโค้ด Java และ TypeScript ที่มี Syntax Error ในบรรทัดที่ 5 -> ต้องได้โครงสร้าง Error ที่ระบุ `line: 5` กลับมาถูกต้อง
2. **Manual Verification:**
   - ทดสอบเขียนโค้ด React และ HTML/CSS ในหน้า IDE ของนักเรียนแล้วกด Run -> หน้าจอ Live Preview แสดงผลทันทีโดยไม่ต้องต่ออินเทอร์เน็ต และผลการตรวจ Sample DOM Assertions แสดงสถานะผ่าน/ไม่ผ่านถูกต้อง


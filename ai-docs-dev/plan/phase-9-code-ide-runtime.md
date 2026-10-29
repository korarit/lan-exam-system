# Phase 9: `code-ide` Module (Part 2) — Multi-File Runtime Engine, Offline Library Linker, Backend Server Sandbox & SQL Engine

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
พัฒนาเอนจินสำหรับ **คอมไพล์ รัน และทดสอบโปรเจกต์หลายไฟล์/หลายโฟลเดอร์ (`Multi-File Project Execution Engine`)** ของโมดูล `code-ide` ให้รองรับครบทุกประเภทโจทย์และทุกภาษาที่ออกแบบไว้ใน Phase 8 ได้แก่:
1. **Core / Systems / CLI Multi-File Projects (`c`, `cpp`, `rust`, `go`, `java`, `python`, `javascript`, `typescript`, `php`)** พร้อมการเชื่อมโยง Offline Libraries (`-I`/`-L`, `cargo --offline`, `-mod=vendor`, `CLASSPATH`, `PYTHONPATH`, `NODE_PATH`, `include_path`)
2. **Frontend Multi-File Projects (`html-css-js`, `react`)** ที่สามารถ `import` คอมโพเนนต์ข้ามโฟลเดอร์และดึง Offline Vendor Packages มา Bundle ได้ทันทีโดยไม่ต้องต่อเน็ต
3. **Backend API Projects (`node-backend`, `python-backend`, `go-backend`, `php-backend`, `java-backend`)** ที่รันเซิร์ฟเวอร์จำลองบน Ephemeral Localhost Port (`127.0.0.1:<port>`) ภายใน Sandbox และยิงชุดทดสอบ HTTP Requests (`GET/POST/PUT/DELETE`) ตรวจคำตอบอัตโนมัติ
4. **Database / SQL Projects (`sql-sqlite` & Backend + DB)** ที่อนุญาตให้ใช้คำสั่งลบข้อมูล/ลบตาราง (`DELETE`, `DROP TABLE`, `TRUNCATE`, `UPDATE`) ได้อย่างอิสระ โดยระบบจะเก็บต้นฉบับ (`Master Seed`) ไว้และ **Spawn ฐานข้อมูล SQLite ตัวใหม่พร้อมข้อมูลตั้งต้นเดิม (Original Seed Data)** ให้ทุกครั้งที่กดรันหรือตรวจแต่ละ Test Case!

### สิ่งที่ต้องได้เมื่อจบ Phase 9
- **ระบบตรวจสอบ Runtime แบบไม่ดาวน์โหลดแยก (`Runtime Detector & User-Installed Policy`):** ค้นหาและตรวจสอบความพร้อมของ `gcc`/`clang` (C), `g++`/`clang++` (C++), `rustc`/`cargo` (Rust), `go` (Golang), `php` (PHP), `java`/`javac` (Java), `python`/`python3` (Python), และ `node` (Node.js) ในเครื่อง **โดยแอปจะไม่ดาวน์โหลดหรือติดตั้ง Runtime แยกให้อัตโนมัติ** หากเครื่องของครูหรือนักเรียนยังไม่มี Runtime ของภาษาที่ใช้ ระบบจะแจ้งเตือนชัดเจนว่าขาดตัวไหนเพื่อให้ผู้ใช้ติดตั้งลงเครื่องเอง พร้อมปุ่มกดตรวจสอบซ้ำ (`Re-check`) หรือเลือกพาธเอง
- **ระบบป้องกันการลบไฟล์และทำลายไฟล์บนเครื่องครู (`Teacher & Student Runtime Anti-Delete File Guard` — สำคัญสูงสุด):** ป้องกันไม่ให้โค้ดของนักเรียนในทุกภาษาสั่งลบไฟล์งานในโฟลเดอร์ของครู (`<TeacherSelectedFolder>/<studentId>`) หรือลบไฟล์ระบบ (ส่วนในโจทย์ **SQL** อนุญาตให้ลบข้อมูล/ลบตารางในฐานข้อมูลจำลองได้เต็มที่ เพราะระบบจะ Spawn ฐานข้อมูลใหม่พร้อมข้อมูลเดิมจากต้นฉบับให้ทุกครั้ง)
- ระบบ **Workspace Materializer & Offline Library Linker** ที่เขียนโครงสร้างโฟลเดอร์หลายระดับของนักเรียนลงใน `Isolated Run Directory` พร้อมเชื่อมโยงโฟลเดอร์ Libraries ทุกภาษา
- ตัวรันเฉพาะทางสำหรับทั้ง **4 หมวดหมู่โจทย์ (CLI Runner, Frontend Bundler & DOM Runner, Backend Ephemeral Server & HTTP Tester, และ SQLite Respawning Sandbox Runner)** พร้อมระบบฆ่าโปรเซสทั้งตระกูล (Process Tree Kill)

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 9.1 External OS Runtime Detector — แจ้งเตือนเมื่อไม่พบและให้ผู้ใช้ติดตั้งเอง (`src/modules/code-ide/main/runtime-locator.ts`)
> **หลักการสำคัญ:** แอปจะ **ไม่ดาวน์โหลด Runtime (C/C++ Compiler, Rust, Go, PHP, JDK, Python, Node.js) แยกจากอินเทอร์เน็ตหรือแอบติดตั้งเองเด็ดขาด** แต่จะตรวจหาจากที่ติดตั้งอยู่ในเครื่องเหมือน IDE มาตรฐาน หากไม่พบจะแจ้งให้ครูหรือนักเรียนเป็นผู้ติดตั้งลงเครื่องเอง

1. **การค้นหาพาธของ Runtime ในเครื่อง (`discoverRuntimes()`):**
   - **C & C++ (`gcc`/`g++` หรือ `clang`/`clang++`):** ค้นหาจาก System PATH และพาธมาตรฐาน (เช่น MinGW-w64, MSYS2 `C:\msys64\ucrt64\bin`, TDM-GCC, LLVM/Clang, Xcode Command Line Tools, `/usr/bin`) พร้อมทดสอบรัน `gcc --version` และ `g++ --version`
   - **Rust (`rustc` & `cargo`):** ค้นหาจาก `%USERPROFILE%\.cargo\bin`, `~/.cargo/bin`, และ System PATH พร้อมทดสอบรัน `rustc --version`
   - **Go / Golang (`go`):** ค้นหาจาก `GOROOT`, `C:\Program Files\Go\bin`, `/usr/local/go/bin`, และ System PATH พร้อมทดสอบรัน `go version`
   - **PHP (`php`):** ค้นหาจาก System PATH และพาธมาตรฐาน (เช่น `C:\php`, `C:\xampp\php`, `C:\laragon\bin\php\php-*`, Homebrew/Linux PATH) พร้อมทดสอบรัน `php -v`
   - **Java (`javac` & `java`):** ค้นหาจาก `JAVA_HOME`, System PATH, และโฟลเดอร์มาตรฐานบนเครื่อง พร้อมทดสอบรัน `javac -version` และ `java -version`
   - **Python (`python3` / `python`):** ค้นหาจาก System PATH และพาธมาตรฐาน พร้อมทดสอบรัน `python --version`
   - **Node.js (`node`):** ค้นหา `node` ในเครื่อง พร้อมทดสอบรัน `node --version` (ส่วน `esbuild` และ `better-sqlite3` สำหรับ SQL เป็นเอนจินภายในของตัวแอปอยู่แล้ว)
2. **การแจ้งเตือนเมื่อไม่พบ Runtime (`MissingRuntimePrompt` ทั้งฝั่งครูและฝั่งนักเรียน):**
   - **ฝั่งครู (ตอนสร้างโจทย์หรือเปิดห้องสอบ):** หากครูเลือกโจทย์ภาษาใด (เช่น C++, Rust, Go, PHP, Java, Python) แต่เครื่องครูยังไม่ได้ลง Compiler/Runtime ของภาษานั้น ระบบจะแสดงแบนเนอร์แจ้งเตือนทันที:
     - เช่น `⚠️ ไม่พบ C++ Compiler (g++) / Go / PHP ในเครื่องของคุณ กรุณาติดตั้งลงในเครื่องด้วยตนเองก่อนใช้งานโหมดรันทดสอบและตรวจข้อสอบภาษานี้`
     - มีปุ่ม **`🔄 ตรวจสอบใหม่อีกครั้ง (Re-scan)`** (กดได้ทันทีหลังติดตั้งเสร็จโดยไม่ต้องปิดแอป) และปุ่ม **`📂 เลือกโฟลเดอร์ที่ติดตั้งไว้ด้วยตนเอง (Browse SDK Path)`**
   - **ฝั่งนักเรียน (ในหน้า Lobby ก่อนเริ่มสอบ):** เครื่องนักเรียนจะตรวจสอบเฉพาะ Runtime ของภาษาที่ชุดข้อสอบนั้นใช้จริง:
     - หากไม่พบ จะแจ้งเตือนบนหน้าจอนักเรียนและส่งสถานะ `🔴 เครื่องที่ 18: ยังไม่ได้ติดตั้ง g++ / Go (กรุณาติดตั้งลงเครื่องก่อนเริ่มสอบ)` ไปแสดงบนหน้าจอครูทันที เพื่อให้ครูหรือนักเรียนติดตั้งเองให้เรียบร้อยแล้วกด **`🔄 ตรวจสอบอีกครั้ง`**

---

### 9.2 ระบบป้องกันการลบไฟล์และทำลายไฟล์บนเครื่องครู (`src/modules/code-ide/main/anti-delete-guard.ts`)
> **เป้าหมายหลักด้านความปลอดภัย:** เมื่อเครื่องครูรับโค้ดของนักเรียนมารันตรวจให้คะแนน โค้ดของนักเรียนอาจมีคำสั่งลบไฟล์บนดิสก์ (เช่น `remove()`, `std::filesystem::remove_all()`, `os.RemoveAll()`, `std::fs::remove_dir_all()`, `unlink()`, `shutil.rmtree()`, `fs.rmSync()`) ตัว Runtime บนเครื่องครูต้อง **บล็อกการลบไฟล์บนระบบไฟล์จริงอย่างเด็ดขาด 100%** (ยกเว้นคำสั่ง SQL `DELETE` / `DROP TABLE` ที่อนุญาตให้ลบข้อมูลในฐานข้อมูลจำลองได้เต็มที่ เพราะระบบจะ Spawn ฐานข้อมูลใหม่พร้อมข้อมูลเดิมทุกครั้ง!)

1. **ชั้นที่ 1: แยกโฟลเดอร์เก็บงานจริงออกจากโฟลเดอร์รัน 100% (`Strict Vault Isolation`):**
   - **ห้ามรันโค้ดของนักเรียนภายในโฟลเดอร์ `<TeacherSelectedFolder>/<studentId>/` บนเครื่องครูเด็ดขาด!**
   - โฟลเดอร์ `<TeacherSelectedFolder>/<studentId>/` ที่ครูเลือกไว้ทำหน้าที่เป็น **คลังเก็บไฟล์งาน (Storage Vault)** เท่านั้น
   - ทุกครั้งที่จะคอมไพล์หรือรันโค้ด ระบบจะคัดลอกไฟล์ไปที่โฟลเดอร์ชั่วคราวแยกเฉพาะกิจ `os.tmpdir()/ztcode-exec-<runId>/` และ **ล้างค่า Environment Variables ทั้งหมด** (ไม่ส่งพาธโฟลเดอร์ของครู, ไม่ส่ง `USERPROFILE` / `HOME` จริงเข้าไปในโปรเซสลูก)
2. **ชั้นที่ 2: บล็อกคำสั่งลบไฟล์และคำสั่ง Shell ระดับ Compiler / Runtime ของแต่ละภาษา (`Language-Level Anti-Delete Guards`):**
   - **สำหรับ C และ C++ (`Header Poisoning` + `Linker Symbol Wrapping -Wl,--wrap`):**
     - ตอนคอมไพล์ด้วย `gcc` / `g++` ระบบจะบังคับแนบไฟล์ Header ป้องกัน (`-include ztcode_anti_delete.h`) และใช้แฟล็ก Linker `-Wl,--wrap=remove,-Wl,--wrap=unlink,-Wl,--wrap=_unlink,-Wl,--wrap=rmdir,-Wl,--wrap=_wremove,-Wl,--wrap=_wunlink,-Wl,--wrap=system,-Wl,--wrap=_wsystem,-Wl,--wrap=popen,-Wl,--wrap=_popen,-Wl,--wrap=DeleteFileA,-Wl,--wrap=DeleteFileW,-Wl,--wrap=RemoveDirectoryA,-Wl,--wrap=RemoveDirectoryW`
     - นอกจากนี้ยังบล็อกเนมสเปซ `std::filesystem::remove` และ `std::filesystem::remove_all` ทำให้โค้ด C/C++ ที่พยายามสั่งลบไฟล์หรือรันคำสั่ง `system("del ...")` ถูกสกัดกั้นทันทีตั้งแต่ขั้น Compile/Link หรือถูกตัดจบด้วยข้อความ `🚫 [Runtime Guard] File deletion is prohibited`!
   - **สำหรับ Rust (`AST/Source Gate` + `Offline Sandbox Policy`):**
     - ตรวจสอบซอร์สโค้ดและ Macro ก่อนคอมไพล์เพื่อบล็อกการเรียกใช้ `std::fs::remove_file`, `std::fs::remove_dir`, `std::fs::remove_dir_all`, `std::fs::rename`, และ `std::process::Command` พร้อมจำกัดสิทธิ์โปรเซสที่รันไม่ให้แก้ไขหรือลบไฟล์นอก `<runDir>`
   - **สำหรับ Go / Golang (`Go AST Gate` + `go build -overlay` Stdlib Lockdown):**
     - ใช้ฟีเจอร์ `-overlay overlay.json` ของ Go Compiler แทนที่ฟังก์ชัน `os.Remove`, `os.RemoveAll`, `os.Rename`, `syscall.Unlink`, `syscall.Rmdir`, และแพ็กเกจ `os/exec` ให้คืนค่า `ErrPermission ("🚫 [Runtime Guard] File deletion and shell execution are prohibited")` ทันทีที่ถูกเรียกใช้!
   - **สำหรับ PHP (`php.ini` `open_basedir` Jail + `disable_functions`):**
     - รัน `php` ด้วยออปชันบังคับระดับ Zend Engine:
       - `-d open_basedir="<runDir>;<depsCacheDir>"` (จำกัดให้ PHP อ่านไฟล์ได้เฉพาะในโฟลเดอร์รันชั่วคราวเท่านั้น ไม่สามารถทะลุออกไปยังไดรฟ์อื่นหรือโฟลเดอร์ครูได้ 100%)
       - `-d disable_functions="unlink,rmdir,rename,exec,shell_exec,system,passthru,popen,proc_open,pcntl_exec,chmod,chown,symlink,link"` (ปิดฟังก์ชันลบไฟล์และรันคำสั่ง Shell ทั้งหมด!)
   - **สำหรับ Python (`sys.addaudithook` Lockdown):**
     - โหลด `sitecustomize.py` ที่ใช้ `sys.addaudithook` บล็อก `os.remove`, `os.unlink`, `os.rmdir`, `shutil.rmtree`, `os.rename`, `os.system`, `subprocess.Popen` และบล็อกการเขียนไฟล์นอก `<runDir>`
   - **สำหรับ Node.js / JavaScript / TypeScript (`Preload fs & child_process Lockdown`):**
     - โหลด `--import ./anti-delete-preload.mjs` บล็อก `fs.unlink`, `fs.rm`, `fs.rmdir`, `child_process` และการเขียนไฟล์นอก `<runDir>`
   - **สำหรับ Java (`Java Agent Bytecode Instrumentation Guard`):**
     - แนบ `-javaagent:ztcode-fs-guard.jar` บล็อก `File.delete()`, `Files.delete()`, `Files.deleteIfExists()`, `Runtime.exec()`, และ `ProcessBuilder.start()`
3. **ชั้นที่ 3: สแกนโค้ดอันตรายก่อนรัน (`Pre-Run Destructive Code Scanner`):**
   - สแกนซอร์สโค้ดทุกไฟล์ในโปรเจกต์ของนักเรียนก่อนคอมไพล์/รัน หากพบความพยายามเรียก API ลบไฟล์ในระบบไฟล์จริงหรืออ้างอิงพาธระดับไดรฟ์ (`C:\`, `D:\`, `../../`) จะระงับการรันและแจ้งเตือน **`🚨 ตรวจพบคำสั่งที่พยายามลบไฟล์ในระบบ`** ให้ครูเห็นทันที!

---

### 9.3 Local Disk Workspace Sync, Materializer & Offline Library Linker (`src/modules/code-ide/main/workspace-materializer.ts`)
รองรับการเก็บไฟล์งานจริงลงในโฟลเดอร์ที่นักเรียนเลือกไว้บนเครื่อง (`Student Local Workspace Folder`) ควบคู่กับการสร้างพื้นที่รันทดสอบที่ปลอดภัย:

1. **การซิงก์ไฟล์โปรเจกต์ลงโฟลเดอร์ที่นักเรียนเลือก (`syncStudentLocalWorkspaceDisk`):**
   - เมื่อนักเรียนเลือกโฟลเดอร์เก็บงาน (เช่น `E:\StudentWork\65010001\`) ระบบจะสร้างโฟลเดอร์แยกตามข้อสอบ (เช่น `E:\StudentWork\65010001\Q1_Java_OOP\`) และเขียนไฟล์ตั้งต้น (`starterEntries`) ลงไปทันที
   - ทุกครั้งที่นักเรียนสร้างไฟล์ สร้างโฟลเดอร์ย่อย เปลี่ยนชื่อ หรือบันทึกโค้ดใน IDE ระบบจะอัปเดตไฟล์จริงในโฟลเดอร์นั้นแบบ Real-time
   - **การสร้างโฟลเดอร์รันทดสอบแยกเฉพาะกิจ (`materializeExecutionSandbox`):**
     - ตอนกด `Run` หรือตอนตรวจให้คะแนน ระบบจะคัดลอกไฟล์จากโปรเจกต์ของนักเรียนไปยัง `os.tmpdir()/ztcode-exec-<runId>/` แล้ว **เขียนทับไฟล์ `readOnly` และเติมไฟล์ `hiddenFromStudent` จากต้นฉบับของอาจารย์เสมอ** (ป้องกันกรณีนักเรียนแอบเปิดโฟลเดอร์บนดิสก์ไปแก้ไฟล์ที่ถูกล็อกไว้)
     - **Path Traversal Guard:** ตรวจสอบทุก `entry.path` ด้วย `path.resolve` ว่ายังคงอยู่ภายใต้โฟลเดอร์งานเท่านั้น ป้องกันพาธที่พยายามเขียนทะลุออกนอกโฟลเดอร์ (`../../`)
2. **การเชื่อมโยง Offline Libraries (`linkOfflineDependencies`):**
   - เมื่อเริ่มห้องสอบ แอปจะแตกไฟล์ `DependencyBundle` ของโจทย์ข้อนั้นไว้ที่โฟลเดอร์แคชอ่านอย่างเดียว (`os.tmpdir()/ztcode-deps-cache/<bundleId>/`) เพียงครั้งเดียว
   - เมื่อนักเรียนกด `Run` หรือเมื่อเครื่องแม่รันตรวจ:
     - **สำหรับ Node.js / TypeScript / React:** สร้าง Directory Junction (บน Windows) หรือ Symlink (บน macOS/Linux) จาก `ztcode-exec-<runId>/node_modules` ชี้ไปยังแคชไลบรารี หรือตั้งค่า `NODE_PATH` ให้ชี้ไปยังแคช ทำให้โปรเจกต์ของนักเรียนเรียก `import express from 'express'` หรือ `import { z } from 'zod'` ได้ทันทีภายใน `< 5 ms`!
     - **สำหรับ Python:** ตั้งค่า `PYTHONPATH` ให้รวมโฟลเดอร์รากของโปรเจกต์นักเรียน (เพื่อให้ `import utils.helper` ข้ามโฟลเดอร์ได้) และโฟลเดอร์ Offline site-packages/wheels ที่อาจารย์แนบมา
     - **สำหรับ Java:** ค้นหาไฟล์ `.java` ทั้งหมดในทุกโฟลเดอร์ย่อย (รองรับโครงสร้าง `package com.exam...`) และตั้งค่า `-cp ".;<depsCacheDir>/*"` ตอนรัน `javac` และ `java` เพื่อให้เรียกใช้ไฟล์ `.jar` ที่อาจารย์แนบมาได้ทั้งหมด

---

### 9.4 Execution Engines สำหรับทั้ง 4 หมวดหมู่โจทย์

#### 9.4.1 หมวด CLI / Systems / Algorithm & Multi-File OOP (`src/modules/code-ide/main/runners/cli-runner.ts`)
- **C (`gcc`) & C++ (`g++`) Multi-File Runner:**
  - ค้นหาไฟล์ `.c` หรือ `.cpp` ทั้งหมดในโปรเจกต์ พร้อมตั้งค่า `-I<projectRoot>` และ `-I<depsIncludeDir>` เพื่อให้ `#include "utils/math.h"` ข้ามโฟลเดอร์ได้
  - คอมไพล์เพียงครั้งเดียวต่อรอบการรัน: `g++ -std=c++20 -O2 <allCppFiles> -I. -include ztcode_anti_delete.h <wrapFlags> -o app.exe`
  - แปลงข้อความ Compile Error จาก `gcc`/`g++` ให้ระบุ `{ filePath, line, column, message }` ส่งกลับไปไฮไลต์ใน Monaco Editor
  - รันไบนารี `app.exe` กับแต่ละ Test Case พร้อมจำกัดเวลาและขนาดเอาต์พุต
- **Rust (`rustc` / `cargo --offline`) Multi-File Runner:**
  - หากเป็นโปรเจกต์มี `Cargo.toml` จะรัน `cargo build --offline` (เชื่อมต่อกับแคช `cargo-vendor` ของโจทย์) หรือรัน `rustc --edition 2021 <entry.rs> -o app.exe` สำหรับโปรเจกต์หลายโมดูล (`mod utils;`)
- **Go / Golang (`go`) Multi-File Runner:**
  - คอมไพล์โปรเจกต์ด้วย `go build -mod=vendor -overlay overlay.json -o app.exe .` (รองรับหลายแพ็กเกจย่อยในโปรเจกต์ของนักเรียน) แล้วนำ `app.exe` ไปรันกับทุก Test Case ด้วยความเร็วสูง
- **PHP (`php`) Multi-File Runner:**
  - รันด้วย `php -n -d open_basedir="<runDir>;<depsCacheDir>" -d disable_functions="..." <entryFile.php>` รองรับการ `require_once` / `include` ไฟล์ข้ามโฟลเดอร์และ Composer `vendor/autoload.php`
- **Java (`javac` + `java`) Multi-File & Package Runner:**
  - คอมไพล์ไฟล์ `.java` ทุกไฟล์ในโปรเจกต์พร้อมกัน: `javac -encoding UTF-8 -cp "<classpath>" -d build @sources.txt`
  - รันคลาสหลักพร้อม Anti-Delete Guard: `java -javaagent:ztcode-fs-guard.jar -Dfile.encoding=UTF-8 -Xmx256m -cp "build;<classpath>" <entryMainClass>`
- **Python / JS / TS Multi-File Runner:**
  - รันไฟล์ Entry Point (เช่น `main.py` หรือ `src/index.ts`) ภายใต้ Anti-Delete Guard (`sitecustomize.py` สำหรับ Python และ `--import ./anti-delete-preload.mjs` สำหรับ Node.js)

#### 9.4.2 หมวด Frontend Web & React Multi-File Bundler (`src/modules/code-ide/main/runners/frontend-runner.ts`)
- ใช้ **`esbuild` Bundle Mode** โดยมี Virtual/Temp Directory ของโปรเจกต์นักเรียนเป็น `absWorkingDir`:
  - รองรับการที่นักเรียนสร้างโฟลเดอร์ `src/components/Navbar.tsx`, `src/hooks/useCart.ts`, `src/styles/card.css` แล้ว `import` เชื่อมโยงกันอย่างอิสระ
  - เชื่อมต่อกับ Offline Vendor Packages ที่อาจารย์เลือกไว้ (เช่น `react`, `react-dom`, `lucide-react`)
- รันตรวจด้วย `HeadlessDomRunner` (หน้าต่าง `BrowserWindow` ซ่อนที่เปิด `sandbox: true, nodeIntegration: false` และตัดขาดทั้งระบบไฟล์และเครือข่ายภายนอก 100%)

#### 9.4.3 หมวด Backend REST API Server Runner (`src/modules/code-ide/main/runners/backend-api-runner.ts`)
สำหรับการสอบเขียน Backend (รองรับ **`node-backend`**, **`python-backend`**, **`go-backend`**, **`php-backend`**, และ **`java-backend`**):
1. **Ephemeral Localhost Port Allocation & Anti-Delete Sandbox:**
   - ขอพอร์ตว่างเฉพาะกิจจาก OS บน `127.0.0.1` (เช่น `PORT=49152`) และรันเซิร์ฟเวอร์ภายใต้ **Anti-Delete Guard** (ข้อ 9.2)
   - สำหรับ **`php-backend`**: รัน Built-in Web Server ด้วย `php -n -d open_basedir="<runDir>" -d disable_functions="..." -S 127.0.0.1:<PORT> -t <docRoot> <router.php>`
   - สำหรับ **`go-backend`**: คอมไพล์เซิร์ฟเวอร์ Go ด้วย `go build -overlay overlay.json` แล้วรันพร้อมส่งตัวแปร `PORT`
   - หากโจทย์เปิดใช้ Database ด้วย ระบบจะ **Spawn ฐานข้อมูล SQLite ตัวใหม่พร้อมข้อมูลตั้งต้นเดิม** ใน `<runDir>` สำหรับรอบการรันนั้นโดยเฉพาะ
2. **Server Readiness Probe:**
   - รอให้เซิร์ฟเวอร์ของนักเรียนเปิดพอร์ตพร้อมรับการเชื่อมต่อ (ตรวจ TCP readiness บน `127.0.0.1:<PORT>` ภายใน `startupTimeoutMs` เช่น `3,000 ms`)
3. **Automated HTTP Test Suite Execution:**
   - ยิง HTTP Requests ตามลำดับที่กำหนดไว้ใน `HttpApiTestCase.requests` (`GET`, `POST`, `PUT`, `DELETE`) ไปที่ `http://127.0.0.1:<PORT>...`
   - ตรวจสอบ Status Code, Response Headers, JSON Body, และสถานะข้อมูลในฐานข้อมูล SQLite หลังยิง API
4. **Guaranteed Server Teardown:**
   - ทันทีที่รันจบแต่ละชุดทดสอบ จะสั่งฆ่า Process Tree ของเซิร์ฟเวอร์นักเรียนทันที เพื่อคืนพอร์ตและล้างฐานข้อมูลชั่วคราว

#### 9.4.4 หมวด Database / SQL Runner — ลบข้อมูล/ลบตารางได้เต็มที่ พร้อมระบบ Spawn DB ใหม่พร้อม Data เดิมอัตโนมัติ (`src/modules/code-ide/main/runners/sql-runner.ts`)
สำหรับการสอบวิชา Database / SQL (`sql-sqlite`):
1. **Master Seed Preservation & Fresh Database Spawning (`spawnFreshDatabaseWithOriginalData`):**
   - เก็บสคริปต์สร้างตารางและข้อมูลตั้งต้นของอาจารย์ (`Master Seed`: `seed.sql` หรือ `master.sqlite` รวมถึง `setupSqlOverride` ของ Hidden Test Cases) ไว้เป็นต้นฉบับที่ห้ามแก้ไขในหน่วยความจำ/แคชของระบบ
   - **ทุกครั้งที่นักเรียนกดรัน หรือก่อนเริ่มรันแต่ละ Test Case:** ระบบจะ **Spawn (สร้าง) อินสแตนซ์ฐานข้อมูล SQLite ลูกใหม่เอี่ยม** แล้วโหลดโครงสร้างตารางและข้อมูลตั้งต้นเดิม (`Original Data`) เข้าไปใหม่ทุกครั้งภายในเวลา `< 3 ms` (ด้วย SQLite In-Memory / Backup API `masterDb.backup(ephemeralDb)`)!
2. **Full Destructive SQL Allowance (`DELETE`, `DROP TABLE`, `TRUNCATE`, `ALTER`, `UPDATE`):**
   - นักเรียนสามารถเขียนและรันคำสั่ง **`DELETE FROM ...`**, **`DROP TABLE ...`**, **`ALTER TABLE ...`**, **`UPDATE ...`**, หรือ **`INSERT INTO ...`** ได้อย่างอิสระ 100% โดยไม่ต้องกลัวว่าข้อมูลตั้งต้นของโจทย์จะพังหรือหายถาวร
   - เพราะแม้คำสั่งของนักเรียนจะลบข้อมูลทิ้งทั้งหมด (`DELETE FROM users;`) หรือลบตารางทิ้ง (`DROP TABLE users;`) ในรอบนั้น ทันทีที่รัน Test Case ถัดไป หรือเมื่อนักเรียนกดรันใหม่อีกครั้ง ระบบก็จะ **Spawn ฐานข้อมูลลูกใหม่ที่มีข้อมูลตั้งต้นเดิมกลับมาให้ครบถ้วน 100% เสมอ!**
   - ทั้งนี้ยังคงบล็อกเฉพาะคำสั่ง `ATTACH DATABASE` ผ่าน `db.setAuthorizer(...)` เพื่อไม่ให้คำสั่ง SQL กระโดดออกไปเปิดไฟล์อื่นบนดิสก์ของเครื่องครูหรือเครื่องนักเรียน
3. **Query Execution & Result Comparison:**
   - รันไฟล์ `.sql` ของนักเรียนบนฐานข้อมูลที่เพิ่ง Spawn ขึ้นมาใหม่ (พร้อมจำกัดเวลาผ่าน `db.interrupt()` หากเขียน Cross Join ที่ค้างนานเกิน `timeoutMs`)
   - กรณีโจทย์เป็นคำสั่ง `SELECT`: นำผลลัพธ์ `columns` และ `rows` ที่ได้มาเปรียบเทียบกับ `expectedColumns` และ `expectedRows`
   - กรณีโจทย์เป็นคำสั่งแก้ไขหรือลบข้อมูล (`DELETE / UPDATE / INSERT / CREATE / DROP`): รันคำสั่งของนักเรียนก่อน แล้วรัน `testCase.verificationQuery` ของอาจารย์บนฐานข้อมูลลูกนั้นเพื่อตรวจว่าข้อมูลที่ถูกลบหรือถูกอัปเดตตรงตามโจทย์หรือไม่!

---

### 9.5 การทำงานร่วมกับระบบตรวจจับการโกง (`Phase 3a Guard Integration`)
1. **PID Registration with `ProcessInspector`:**
   - ทุกโปรเซสที่เกิดจาก `ProcessSandbox` (ทั้ง CLI, Backend Server, และ Compiler) จะลงทะเบียน `pid` เข้าสู่ `AuthorizedChildProcessRegistry` ชั่วคราว
2. **Loopback-Only Allowance สำหรับโหมด Backend API (`NetworkInspector` Rule):**
   - สำหรับโจทย์หมวด `backend`: อนุญาตให้โปรเซสลูกของโค้ดนักเรียนเปิดพอร์ตฟังและรับส่งข้อมูลเฉพาะบน **`127.0.0.1` (Loopback) ตามพอร์ต `PORT` ที่ได้รับจัดสรรเท่านั้น**
   - หากโค้ดของนักเรียนพยายามเชื่อมต่อออกไปหา IP ภายนอกหรือยิง API หา AI ข้างนอก (`0.0.0.0` / External IP / DNS Query): `NetworkInspector` จะบล็อกและยิงแจ้งเตือนสีแดง **`STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL` (`CRITICAL`)** ไปยังหน้าจออาจารย์ทันที!

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **9.1.1** พัฒนา `RuntimeLocator` ตรวจหา `javac`/`java`, `python`, `node` ในเครื่อง **โดยไม่ดาวน์โหลดแยก** พร้อมหน้าจอแจ้งเตือนให้ครูหรือนักเรียนติดตั้งเองเมื่อไม่พบ และปุ่ม `Re-scan` / `Browse Path`
- [ ] **9.2.1** สร้าง **`AntiDeleteRuntimeGuard`** ป้องกันการลบไฟล์และเขียนไฟล์นอกพื้นที่ทดสอบครบทุกภาษา (Python `sys.addaudithook`, Node.js Preload `fs` & `child_process` lockdown, Java `-javaagent` bytecode guard, และ SQLite Authorizer)
- [ ] **9.2.2** สร้าง `DestructiveCodeScanner` สแกนโค้ดก่อนรันบนเครื่องครูเพื่อดักจับคำสั่งอันตรายที่พยายามลบไฟล์หรือเรียก Shell
- [ ] **9.3.1** สร้าง `WorkspaceMaterializer` และ `OfflineLibraryLinker` โดยแยกโฟลเดอร์เก็บงานจริงของครู (`<TeacherSelectedFolder>/<studentId>`) ออกจากโฟลเดอร์รันชั่วคราว (`ztcode-exec-<runId>`) 100%
- [ ] **9.4.1** พัฒนา `CliMultiFileRunner`, `FrontendProjectRunner`, `BackendApiRunner`, และ `SqlDatabaseRunner` ให้ทำงานภายใต้ `AntiDeleteRuntimeGuard`
- [ ] **9.5.1** เชื่อมต่อ `AuthorizedChildProcessRegistry` และกฎ Loopback-only สำหรับ Backend Sandbox เข้ากับ `ProcessInspector` และ `NetworkInspector` (Phase 3a)

---

## 4. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **Anti-File-Deletion Protection Test (สำคัญที่สุด):** จำลองโค้ดนักเรียนใน Python (`os.remove`, `shutil.rmtree`), Node/TS (`fs.rmSync`, `fs.unlinkSync`, `child_process.execSync('del ...')`), และ Java (`Files.delete`, `Runtime.getRuntime().exec`) ที่พยายามลบไฟล์ในโฟลเดอร์ `<TeacherSelectedFolder>` หรือไฟล์ข้างนอก -> **ต้องถูกบล็อกทันทีด้วย Permission/Security Error และไฟล์ของครู/เพื่อนนักเรียนต้องอยู่ครบ 100% ไม่ถูกแตะต้องแม้แต่ไฟล์เดียว!**
   - **Missing Runtime Notification Test:** จำลองกรณีเครื่องไม่มี `javac` หรือ `python` ใน PATH -> ระบบต้องไม่พยายามดาวน์โหลดเอง แต่คืนสถานะแจ้งเตือนให้ผู้ใช้ติดตั้งเองพร้อมรองรับการระบุพาธด้วยตนเอง
   - **Multi-Folder & Library Import Test:** ทดสอบรันโปรเจกต์ที่มีโฟลเดอร์ซ้อนกัน (`src/utils/`, `src/models/`) และมีการเรียกใช้ Offline Library -> ต้องคอมไพล์และรันผ่านโดยไม่ต้องต่ออินเทอร์เน็ต
   - **Backend API & SQL Runner Test:** ทดสอบรันโปรเจกต์ Backend API และ SQL เทียบกับชุดทดสอบ -> ตรวจได้คะแนนถูกต้องและปิดโปรเซสคืนพอร์ตสะอาด 100%
   - **Infinite Loop & Server Hang Kill Test:** ทดสอบรันโค้ดที่มี `while(true){}` -> ต้องถูกฆ่าทั้ง Process Tree ภายในเวลาที่กำหนด
2. **Manual Verification:**
   - ทดสอบสร้างโปรเจกต์หลายไฟล์ในทั้ง 4 หมวด (CLI, Frontend, Backend API, Database SQL) กดรันทดสอบจากหน้า IDE ของนักเรียน -> แสดงผลลัพธ์ถูกต้องครบทุกหมวด

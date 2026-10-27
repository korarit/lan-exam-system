# Phase 3a: Deep Cheat Detection Engine (Multi-Layer Client Sensors)

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
สร้างเอนจินตรวจจับการทุจริตเชิงลึก (**Deep Cheat Detection Suite**) ที่ฝั่งเครื่องนักเรียน โดยเน้น **"ตรวจจับให้แม่นยำ แม้ผู้สอบพยายามซ่อนตัว เปลี่ยนชื่อไฟล์ หรือใช้เครื่องมือสมัยใหม่"** แล้วส่งหลักฐานทั้งหมดไปฟ้องเครื่องแม่แบบ Real-time

ครอบคลุมการตรวจจับ 7 มิติหลัก:
1. **Dynamic Signed Policy & Anti-Evasion Scheduler:** กติกาตรวจจับส่งมาจากเครื่องแม่และสุ่มเวลาตรวจเพื่อกันคนอ่านซอร์สโค้ดแล้วกะจังหวะหลบ
2. **Deep Process & Execution Tree Inspector:** ตรวจจับการเปลี่ยนชื่อไฟล์ `.exe` (ตรวจจาก PE Header / Binary Metadata), ดักจับโปรเซสที่เปิดแล้วปิดเร็วระดับมิลลิวินาที (Real-time Process Creation Trace), และตรวจจับ Local AI (Ollama, LM Studio, llama.cpp)
3. **Network, DNS Cache, Local Port & Tunnel Detector:** ตรวจจับการแอบต่อเน็ตนอก, การเปิด VPN/WireGuard/Cloudflare Tunnel, และการอ่าน **OS DNS Resolver Cache** เพื่อจับชื่อโดเมน AI แม้ปิดหน้าเว็บไปแล้ว
4. **Stealth Overlay & Window Affinity Detector:** ตรวจจับโปรแกรมโกงยุคใหม่ที่สร้างหน้าต่างโปร่งใสลอยทับข้อสอบ (`WS_EX_TOPMOST | WS_EX_TRANSPARENT`) หรือซ่อนตัวเองจากการจับภาพหน้าจอ (`WDA_EXCLUDEFROMCAPTURE`)
5. **Synthetic Input & Clipboard Cross-Device Detector:** ตรวจจับการจำลองคีย์บอร์ด/เมาส์ (`LLKHF_INJECTED` จาก Auto-typer / Macro / Remote control) และการส่งข้อความผ่าน Shared Clipboard (Phone Link / Universal Clipboard / VM Clipboard)
6. **Self-Memory / Loaded Module & Debugger Guard:** ตรวจจับการฉีด DLL / Frida (`frida-agent`), Debugger (`TracerPid` / `CheckRemoteDebuggerPresent`), และ Cheat Engine
7. **VM, Remote Session & Hardware Hotplug Detector:** ตรวจจับการรันใน Virtual Machine, การเปิด Remote Desktop/Screen Share, และการเสียบจอหรืออุปกรณ์เพิ่มระหว่างสอบ

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 3a.1 Dynamic Signed Detection Policy & Anti-Evasion Scheduler (`src/main/guard/policy-engine.ts`)
เนื่องจากโปรเจกต์เป็น Open Source หากเราเขียนรายการ Blacklist ตายตัวไว้ในโค้ด หรือตั้งเวลาตรวจทุกๆ 3.00 วินาทีคงที่ ผู้สอบที่อ่านโค้ดจะสามารถเปลี่ยนชื่อไฟล์หรือเขียนสคริปต์ให้ทำงานเสร็จในช่องว่างระหว่างรอบการตรวจได้

1. **โครงสร้าง `SignedDetectionPolicy` (ส่งจากเครื่องแม่ตอนเข้าห้องสอบและอัปเดตระหว่างสอบได้):**
   ```ts
   const ProcessSignatureRuleSchema = z.object({
     ruleId: z.string(),
     category: z.enum([
       'ai-assistant',      // ChatGPT app, Claude, Copilot, Cursor, Windsurf, Ollama, LM Studio
       'stealth-overlay',   // Cluely, Interview Coder, Overwolf, custom transparent overlays
       'remote-control',    // AnyDesk, TeamViewer, RustDesk, Parsec, Sunshine, Chrome Remote Desktop
       'screen-recorder',   // OBS, ShareX, Bandicam, Discord, Zoom, Skype, Teams
       'memory-debugger',   // Cheat Engine, x64dbg, WinDbg, IDA, Ghidra, Frida, Process Hacker, System Informer
       'network-tunnel',    // ngrok, cloudflared, tailscale, wireguard, openvpn, proxifier, v2ray, clash
       'automation-macro',  // AutoHotkey, AutoIt, TinyTask, Power Automate
       'unauthorized-browser' // Chrome, Edge, Brave, Firefox, Opera, Arc (เมื่ออยู่ในโหมดห้ามเปิดเบราว์เซอร์นอก)
     ]),
     severity: z.enum(['warning', 'critical']),
     scoreWeight: z.number().int().positive(),
     matchers: z.object({
       exeNames: z.array(z.string()).optional(),          // เช่น ['ollama.exe', 'ollama_llama_server.exe']
       originalFilenames: z.array(z.string()).optional(), // อ่านจาก PE VersionInfo กันการเปลี่ยนชื่อไฟล์ .exe!
       productNames: z.array(z.string()).optional(),      // อ่านจาก PE Header / macOS Info.plist
       bundleIds: z.array(z.string()).optional(),         // สำหรับ macOS เช่น 'com.openai.chat'
       cmdSubstrings: z.array(z.string()).optional(),     // เช่น ['--api-key', 'openai', 'deepseek', 'claude']
       windowTitles: z.array(z.string()).optional(),      // Regex/Substring ของชื่อหน้าต่าง
       localPorts: z.array(z.number().int()).optional(),  // เช่น [11434, 1234, 8080, 4891]
       sha256Hashes: z.array(z.string()).optional()       // Hash ของไบนารีต้องห้ามที่พบบ่อย
     })
   })
   ```
2. **Hybrid Event-Driven + Jittered Polling Scheduler (`src/main/guard/scheduler.ts`):**
   - **ชั้นที่ 1 (Event-Driven Real-time):** ดักจับทันทีที่เกิดเหตุการณ์จาก OS (เช่น หน้าต่างเสียโฟกัส, มีการสร้างโปรเซสใหม่, มีการกดคีย์ลัด, คลิปบอร์ดเปลี่ยน)
   - **ชั้นที่ 2 (Cryptographically Jittered Polling):** สำหรับการกวาดตรวจทั้งระบบ ให้สุ่มหน่วงเวลารอบถัดไปด้วย `crypto.randomInt(minIntervalMs, maxIntervalMs)` เช่น สุ่มระหว่าง `1,800 ms` ถึง `4,700 ms` ทุกครั้ง
   - **ชั้นที่ 3 (Cross-Detector Watchdog):** มีตัวเช็กว่าทุก Detector ย่อยยังคงอัปเดต `lastTickTimestamp` ของตัวเองอยู่เสมอ หาก Detector ตัวใดค้างหรือถูกระงับ Thread เกิน `10 วินาที` ให้ยิง `GUARD_THREAD_STALLED` (`CRITICAL`) ไปที่เครื่องแม่ทันที

---

### 3a.2 Deep Process, Renamed Binary & Ephemeral Execution Inspector (`src/main/guard/process-inspector.ts`)

#### ก. การตรวจจับไฟล์ `.exe` ที่ถูกเปลี่ยนชื่อหนีการตรวจ (Renamed Binary Detection)
หากผู้สอบเปลี่ยนชื่อ `cheatengine-x86_64.exe` เป็น `svchost_audio.exe` หรือเปลี่ยน `ollama.exe` เป็น `wordpad.exe`:
- **บน Windows:**
  - ดึง `executablePath` ของทุกโปรเซสที่รันภายใต้ User ปัจจุบัน (ที่ไม่ใช่ System32 ที่เซ็นโดย Microsoft)
  - อ่านข้อมูล **PE Version Information Resource** (`OriginalFilename`, `InternalName`, `ProductName`, `FileDescription`, `CompanyName`) และคำนวณ `SHA-256` ของไฟล์ executable (แคชค่าตาม `filePath + mtimeMs + fileSize` เพื่อไม่ให้อ่านดิสก์ซ้ำซ้อน)
  - หาก `OriginalFilename` คือ `Cheat Engine.exe` แต่ชื่อไฟล์ปัจจุบันคือ `wordpad.exe`:
    - ส่ง Event พิเศษ **`DISGUISED_PROCESS_DETECTED` (`severity: 'critical'`, คะแนนความน่าสงสัยคูณสอง!)** เพราะแสดงถึงเจตนาจงใจดัดแปลงเพื่อหลบเลี่ยงการตรวจจับ
- **บน macOS:**
  - อ่านไฟล์ `Contents/Info.plist` ของแอปพลิเคชันที่กำลังรัน เพื่อตรวจ `CFBundleIdentifier`, `CFBundleName`, และ `CFBundleExecutable`
- **บน Linux:**
  - อ่าน symlink `/proc/[pid]/exe`, ไฟล์ `/proc/[pid]/comm`, `/proc/[pid]/cmdline`, และ `/proc/[pid]/environ`

#### ข. การดักจับโปรเซสที่เปิดแล้วปิดอย่างรวดเร็ว (Sub-Second / Ephemeral Process Catcher)
กรณีผู้สอบรันคำสั่ง CLI สั้นๆ เช่น `curl https://api.openai.com/...` หรือรันสคริปต์ Python ที่ทำงานเสร็จภายใน `300 ms` ซึ่งอาจรอดพ้นการ Poll ทุก 3 วินาที:
- **บน Windows:**
  - เปิด Background Worker ที่ subscribe เหตุการณ์การสร้างโปรเซสของ Windows แบบ Real-time (ผ่าน WMI `Win32_ProcessStartTrace` / `__InstanceCreationEvent` หรือ ETW Process Provider)
  - ทุกครั้งที่มีโปรเซสใหม่เกิดบนเครื่อง OS จะส่ง `ProcessName`, `ProcessID`, `ParentProcessID`, และ `CommandLine` เข้ามาในคิวทันทีแม้โปรเซสนั้นจะปิดตัวลงในอีก 50 มิลลิวินาทีต่อมา!
- **บน Linux & macOS:**
  - ติดตามค่า `lastKnownMaxPid` และตรวจ `/proc` ด้วยความถี่สูงสำหรับโปรเซสลูกของ Shell (`bash`, `zsh`, `sh`, `python`, `node`) หากพบการกระโดดของเลข PID ผิดปกติในช่วงสั้นๆ (`PID_BURST_ANOMALY`) ให้ส่งแจ้งเตือนพร้อมรายการโปรเซสที่เกิดใหม่

#### ค. การตรวจจับ Local AI / LLM Runtimes เชิงลึก
แม้ในห้องคอมส่วนใหญ่จะรันโมเดลใหญ่ไม่ได้ แต่บางเครื่องอาจพยายามรันโมเดลขนาดเล็ก (เช่น Qwen 1.5B/3B, Llama 3.2 1B, DeepSeek-R1-Distill 1.5B ผ่าน Ollama หรือ llama.cpp):
1. **ตรวจจาก Process & Command Line:** ตรวจหา `ollama`, `llama-server`, `llama-cli`, `LM Studio`, `jan`, `koboldcpp`, `gpt4all`, `vllm`, `litellm`
2. **ตรวจจาก Local Inference Ports:** สแกนตารางพอร์ต `LISTEN` บน `127.0.0.1` และ `0.0.0.0` เทียบกับพอร์ตมาตรฐานของ Local AI (`11434`, `1234`, `4891`, `5000`, `5001`, `8000`, `8080`, `1337`) และหากพบพอร์ตที่ไม่รู้จักเปิด `LISTEN` ขึ้นมาใหม่ระหว่างสอบ ให้บันทึกชื่อโปรเซสที่เป็นเจ้าของพอร์ตนั้นทันที
3. **ตรวจจาก Resource Spike ผิดปกติ:** หากอยู่ใน Mode 1 (Closed Exam) แล้วพบโปรเซสของผู้ใช้ (ที่ไม่ใช่ตัวแอปสอบ) ใช้ RAM เกิน `1.5 GB` ควบคู่กับโหลด CPU/GPU สูงต่อเนื่องเกิน 10 วินาที ให้ส่งสัญญาณ `SUSPICIOUS_COMPUTE_SPIKE` พร้อมชื่อโปรเซสและพาธไฟล์ไปให้ครูเห็น

---

### 3a.3 Stealth Overlay, Transparent Window & Display Affinity Detector (`src/main/guard/overlay-inspector.ts`)
ปัจจุบันมีเครื่องมือโกงสอบสมัยใหม่ (เช่น Cluely, Interview Coder หรือโปรแกรมสร้าง Overlay) ที่ใช้วิธี:
1. สร้างหน้าต่างลอยอยู่เหนือทุกโปรแกรม (`WS_EX_TOPMOST`)
2. ตั้งค่าให้เมาส์คลิกทะลุได้ (`WS_EX_TRANSPARENT | WS_EX_LAYERED`) เพื่อไม่ให้หน้าต่างข้อสอบเสียโฟกัส (`blur` event ไม่ทำงาน!)
3. เรียกใช้ Windows API `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` เพื่อซ่อนหน้าต่างตัวเองไม่ให้ติดไปกับภาพ Screenshot หรือสตรีมหน้าจอที่ส่งไปหาครู!

**วิธีตรวจจับแบบเจาะจง (ทำงานใน Native Addon / OS Window Inspector):**
1. **บน Windows (`EnumWindows` Inspection):**
   - วนลูปตรวจสอบทุก Top-level `HWND` ที่ `IsWindowVisible(hwnd) == TRUE` และไม่ได้เป็นหน้าต่างของตัวแอป `ZT-Exam` เอง:
   - **ตรวจที่ 1 (Capture Evasion Check):** เรียก `GetWindowDisplayAffinity(hwnd, &dwAffinity)`:
     - หากพบหน้าต่างใดของโปรเซสอื่นตั้งค่า `dwAffinity == WDA_MONITOR (0x01)` หรือ `WDA_EXCLUDEFROMCAPTURE (0x11)`:
     - ดึง `PID` (`GetWindowThreadProcessId`), `ExecutablePath`, และ `WindowTitle` แล้วส่ง Event **`CAPTURE_EVADING_WINDOW_DETECTED` (`CRITICAL` สูงสุด!)** ไปที่เครื่องแม่ทันที! (เพราะโปรแกรมปกติทั่วไปจะไม่ซ่อนตัวเองจากการจับภาพหน้าจอในห้องสอบ)
   - **ตรวจที่ 2 (Topmost / Click-Through Overlay Check):** อ่าน `exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE)`:
     - หากพบหน้าต่างที่มี `WS_EX_TOPMOST` และมีพื้นที่หน้าต่างซ้อนทับกับหน้าจอข้อสอบ (โดยเฉพาะถ้ามี `WS_EX_LAYERED` หรือ `WS_EX_TRANSPARENT` ร่วมด้วย และไม่ได้อยู่ในรายการ Whitelist ของ OS เช่น Taskbar):
     - ส่ง Event **`TOPMOST_OVERLAY_WINDOW_DETECTED` (`CRITICAL`)** พร้อมขนาดพิกัดหน้าต่างและชื่อไฟล์ `.exe` ต้นทาง
2. **บน macOS (`CGWindowListCopyWindowInfo`):**
   - ดึงรายการหน้าต่างทั้งหมดที่อยู่บนหน้าจอด้วย `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID)`
   - ตรวจสอบหน้าต่างที่มี `kCGWindowLayer > 0` (อยู่เหนือระดับหน้าต่างปกติ) หรือมี `kCGWindowSharingState == kCGWindowSharingNone` (ตั้งค่าซ่อนจากการอัดหน้าจอบน macOS)
   - หากเป็นของโปรเซสอื่นที่ไม่ใช่ระบบ macOS หรือ ZT-Exam ให้ส่ง **`CAPTURE_EVADING_WINDOW_DETECTED` (`CRITICAL`)** ทันที

---

### 3a.4 Network Socket, Tunneling & OS DNS Cache Inspector (`src/main/guard/network-inspector.ts`)

1. **OS DNS Resolver Cache Diffing (จับโดเมนที่แอบเข้าแม้ปิดการเชื่อมต่อในเสี้ยววินาที):**
   - ปัญหาของการดูแค่ Active TCP Sockets คือ ถ้าผู้สอบรันสคริปต์ยิง HTTPS request สั้นๆ ที่ใช้เวลาแค่ 200ms แล้วปิด socket ทันที อาจไม่ติดในตาราง Active Connections
   - **วิธีแก้:** ระบบปฏิบัติการจะเก็บ **DNS Cache** ของโดเมนที่เพิ่งถูกค้นหาไว้เสมอ:
     - ตอนเริ่มสอบ ให้บันทึก Snapshot ของ DNS Cache เดิมไว้เป็น Baseline
     - ระหว่างสอบ อ่านรายการ DNS Cache ที่เพิ่งเกิดใหม่ (บน Windows อ่านผ่าน Win32 `DnsGetCacheDataTable` ใน Native Addon หรือ `Get-DnsClientCache`)
     - นำรายชื่อโดเมนใหม่ใน DNS Cache มาตรวจกับรายการ AI / เว็บต้องห้าม และตรวจกับ Whitelist!
     - หากพบโดเมนอย่าง `api.openai.com`, `chatgpt.com`, `claude.ai`, `api.anthropic.com`, `api.deepseek.com`, `generativelanguage.googleapis.com` โผล่ขึ้นมาใน DNS Cache ของเครื่องระหว่างเวลาสอบ -> ส่ง Event **`FORBIDDEN_DNS_QUERY_DETECTED` (`CRITICAL`)** พร้อมชื่อโดเมนทันที!
2. **Per-Process Active Socket & Proxy Bypass Verification:**
   - ดึงตาราง TCP/UDP connections พร้อมเลข `PID` ของโปรเซสเจ้าของ socket
   - **ใน Mode 1 (Closed):** ห้ามมีโปรเซสของผู้ใช้ต่อออกไปยัง IP นอกวง LAN (ยกเว้น IP เครื่องแม่)
   - **ใน Mode 3 (External Tools):** ทราฟฟิกเว็บต้องวิ่งเข้าพอร์ต `127.0.0.1:<localProxyPort>` ของเราเท่านั้น หากพบโปรเซส (เช่น `code.exe`, `node.exe`, `python.exe`, `curl.exe`) เปิด TCP connection ออกไปยังพอร์ต `80`, `443`, `8080`, `8443` ข้างนอกโดยตรง -> ส่ง Event **`DIRECT_SOCKET_PROXY_BYPASS` (`CRITICAL`)** พร้อมระบุชื่อโปรเซสและ IP ปลายทาง
3. **VPN, Proxy & Network Tunnel Interface Detector:**
   - ตรวจสอบ `os.networkInterfaces()` เทียบกับตอนเริ่มสอบ
   - หากพบ Network Interface เสมือน (Virtual NIC / TUN / TAP) เช่น `wintun`, `WireGuard`, `TAP-Windows`, `Tailscale`, `ZeroTier`, `CloudflareWARP`, `utun` (ที่เกิดใหม่) หรือพบการเปลี่ยน Default Gateway / System Proxy ชี้ไปที่อื่นที่ไม่ใช่ Proxy ของเรา -> ส่ง Event **`NETWORK_TUNNEL_OR_PROXY_TAMPER` (`CRITICAL`)**

---

### 3a.5 Synthetic Input, Auto-Typer & Cross-Device Clipboard Guard (`src/main/guard/input-clipboard-guard.ts`)

1. **การตรวจจับคีย์บอร์ด/เมาส์จำลอง (Synthetic / Injected Input Detection):**
   - โปรแกรมประเภท Auto-typer (ที่รับคำตอบจาก AI แล้วค่อยๆ พิมพ์ลงช่องคำตอบให้อัตโนมัติเพื่อตบตาว่าเป็นคนพิมพ์) หรือโปรแกรมควบคุมระยะไกล จะส่ง Input ผ่าน API อย่าง `SendInput` หรือ `keybd_event`
   - ใน Windows Low-Level Hook (`WH_KEYBOARD_LL` และ `WH_MOUSE_LL` ใน Native Addon):
     - โครงสร้าง `KBDLLHOOKSTRUCT` มีฟิลด์ `flags` ซึ่ง Windows Kernel จะเซ็ตบิต `LLKHF_INJECTED (0x10)` หรือ `LLKHF_LOWER_IL_INJECTED (0x02)` เสมอหากการกดปุ่มนั้นไม่ได้มาจากไดรเวอร์ฮาร์ดแวร์คีย์บอร์ดจริง!
     - เมื่อตรวจพบ `flags & LLKHF_INJECTED`: บล็อกอินพุตนั้นทันที และส่ง Event **`SYNTHETIC_INPUT_INJECTED` (`CRITICAL`)** ไปยังเครื่องแม่!
2. **Keystroke Dynamics & Superhuman Typing Detector (ทำงานได้ทุก OS):**
   - ในช่องพิมพ์คำตอบของ Renderer เก็บสถิติความเร็วในการพิมพ์และค่าส่วนเบี่ยงเบนมาตรฐานของเวลาระหว่างการกดปุ่ม (`Inter-Keystroke Interval - IKI`):
   - หากมีการป้อนตัวอักษรยาวเกิน 40 ตัวอักษรด้วยความเร็วเกิน `20 ตัวอักษร/วินาที` หรือมีค่าความแปรปรวนของจังหวะเคาะปุ่มต่ำผิดธรรมชาติ (`stdDev < 2 ms` ซึ่งมนุษย์ทำไม่ได้) -> ส่ง Event **`ABNORMAL_TYPING_PATTERN` (`WARNING` / `CRITICAL`)**
3. **Clipboard Guard & Cross-Device Clipboard Detection:**
   - ใน Mode 1 และ Mode 2: ล้าง Clipboard ตอนเริ่มสอบ และคำนวณ Hash ของข้อความใน Clipboard ทุกครั้งที่ผู้สอบคัดลอกข้อความภายในช่องคำตอบของตัวเอง (`lastInternalClipboardHash`)
   - มีตัวตรวจ Clipboard ทุกๆ 1.5 วินาที: หากพบว่าใน Clipboard มีข้อความหรือรูปภาพโผล่ขึ้นมาโดยที่ `sha256(clipboardContent) !== lastInternalClipboardHash` (เช่น ถูกส่งข้ามมาจากมือถือผ่าน Windows Phone Link, KDE Connect, Apple Universal Clipboard หรือ Shared Clipboard ของ VM):
     - ส่ง Event **`EXTERNAL_CLIPBOARD_INJECTION` (`CRITICAL`)** พร้อมขนาดข้อมูล (และตัวอย่างข้อความ 100 ตัวอักษรแรกสำหรับเป็นหลักฐานให้ครูดู) แล้วสั่ง `clipboard.clear()` ทันที!

---

### 3a.6 Self-Integrity, Loaded Module (DLL/SO) & Debugger Detector (`src/main/guard/self-integrity-guard.ts`)

1. **Debugger Attachment Detection:**
   - **Windows:** เรียก `IsDebuggerPresent()` และ `CheckRemoteDebuggerPresent(GetCurrentProcess(), &isDebuggerPresent)`
   - **Linux:** อ่านไฟล์ `/proc/self/status` ตรวจสอบบรรทัด `TracerPid:` หากค่าไม่เท่ากับ `0` แปลว่าถูก `ptrace` / `gdb` / `strace` เกาะอยู่
   - **macOS:** เรียก `sysctl` ด้วย `[CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]` แล้วตรวจ flag `P_TRACED` ใน `kp_proc.p_flag`
   - หากตรวจพบ Debugger เกาะโปรเซส -> ส่ง Event **`DEBUGGER_ATTACHED` (`CRITICAL`)** และ Freeze หน้าจอข้อสอบทันที
2. **Injected DLL / Shared Library Scanner (ตรวจจับ Frida / Cheat Engine Hook):**
   - สแกนรายการโมดูลที่ถูกโหลดเข้ามาในหน่วยความจำของโปรเซส `ZT-Exam` (`EnumProcessModules` บน Windows, `/proc/self/maps` บน Linux, `_dyld_get_image_name` บน macOS)
   - यदिพบโมดูลแปลกปลอม เช่น `frida-agent`, `vehdebug-x86_64.dll` (ของ Cheat Engine), `speedhack`, `minhook`, `detours` หรือไฟล์ `.dll`/`.so`/`.dylib` ที่ถูกโหลดมาจากโฟลเดอร์ `Temp` / `Downloads` ของผู้ใช้ -> ส่ง Event **`FOREIGN_MODULE_INJECTED` (`CRITICAL`)** พร้อมพาธของไฟล์ที่ฉีดเข้ามาทันที

---

### 3a.7 Hardware Hotplug, Multi-Monitor & Virtualization Guard (`src/main/guard/hardware-vm-guard.ts`)

1. **Virtual Machine & Hypervisor Fingerprinting:**
   - ตรวจทั้งจาก BIOS/SMBIOS (`VMware`, `VirtualBox`, `QEMU`, `KVM`, `Bochs`, `Parallels`, `Xen`), ชื่อการ์ดจอ (`VMware SVGA`, `VirtualBox Graphics`, `Microsoft Basic Render Driver`, `Red Hat QXL`), และเลข MAC Address Prefix (`00:05:69`, `00:0C:29`, `00:50:56`, `08:00:27`, `52:54:00`)
   - รายงานเป็นข้อมูลสถานะเครื่องตั้งแต่อยู่ในห้อง Lobby เพื่อให้ผู้คุมสอบทราบตั้งแต่ก่อนกดเริ่มสอบว่าเครื่องใดรันอยู่ใน VM
2. **Display & Capture Hardware Hotplug:**
   - ดักจับการเสียบ/ถอดสายจอ (`display-added`, `display-removed`, `display-metrics-changed`) และอ่านชื่อรุ่นของจอภาพ (EDID) เพื่อตรวจจับอุปกรณ์จำพวก HDMI Dummy Plug หรือ External Capture Card ที่ถูกเสียบเพิ่มระหว่างสอบ

---

## 3. สรุปรายการรหัสเหตุการณ์ (Detection Event Catalog)

| รหัสเหตุการณ์ (Event Code) | หมวดหมู่ | ความรุนแรงเริ่มต้น | คะแนนความน่าสงสัย |
|---|---|---|---|
| `CAPTURE_EVADING_WINDOW_DETECTED` | Stealth Overlay | 🔴 `CRITICAL` | `+80` |
| `FOREIGN_MODULE_INJECTED` | Memory / Hook | 🔴 `CRITICAL` | `+80` |
| `DEBUGGER_ATTACHED` | Memory / Hook | 🔴 `CRITICAL` | `+80` |
| `DISGUISED_PROCESS_DETECTED` | Process (เปลี่ยนชื่อไฟล์หนี) | 🔴 `CRITICAL` | `+70` |
| `SYNTHETIC_INPUT_INJECTED` | Input / Auto-Typer | 🔴 `CRITICAL` | `+60` |
| `BLACKLISTED_PROCESS_DETECTED` | Process (AI / Remote / Cheat) | 🔴 `CRITICAL` | `+45` |
| `FORBIDDEN_DNS_QUERY_DETECTED` | Network / DNS Cache | 🔴 `CRITICAL` | `+45` |
| `DIRECT_SOCKET_PROXY_BYPASS` | Network | 🔴 `CRITICAL` | `+40` |
| `EXTERNAL_CLIPBOARD_INJECTION` | Clipboard | 🔴 `CRITICAL` | `+40` |
| `TOPMOST_OVERLAY_WINDOW_DETECTED` | Overlay Window | 🔴 `CRITICAL` | `+40` |
| `KIOSK_ESCAPE_ATTEMPT` | Window / Kiosk | 🔴 `CRITICAL` | `+25` |
| `WINDOW_BLUR_PROLONGED` (> 3s) | Window / Focus | 🟡 `WARNING` -> 🔴 | `+20` |
| `ABNORMAL_TYPING_PATTERN` | Behavioral | 🟡 `WARNING` | `+15` |
| `DISPLAY_CONFIG_CHANGED` | Hardware | 🟡 `WARNING` | `+15` |
| `WINDOW_BLUR_BRIEF` (< 3s) | Window / Focus | 🟡 `WARNING` | `+5` |

---

## 4. Checklist งานย่อย (Implementation Checklist)

- [ ] **3a.1.1** สร้าง Schema สำหรับ `SignedDetectionPolicy` และ `ProcessSignatureRule` ใน `src/shared/policy-schema.ts`
- [ ] **3a.1.2** สร้าง `JitteredScheduler` และ `CrossDetectorWatchdog` ใน `src/main/guard/scheduler.ts`
- [ ] **3a.2.1** สร้าง `ProcessInspector` ที่ตรวจทั้งชื่อโปรเซส, Command line, พอร์ต Local AI, และอ่าน PE VersionInfo / Bundle ID เพื่อจับไฟล์ที่ถูกเปลี่ยนชื่อ (`DISGUISED_PROCESS_DETECTED`)
- [ ] **3a.2.2** สร้างตัวดักจับโปรเซสเกิดใหม่แบบ Real-time (WMI Process Trace บน Windows / PID burst check บน Linux & macOS) เพื่อจับโปรเซสที่เปิดแล้วปิดภายในเสี้ยววินาที
- [ ] **3a.3.1** สร้าง `OverlayInspector` ตรวจจับหน้าต่างที่ตั้งค่า `WDA_EXCLUDEFROMCAPTURE` หรือ `WS_EX_TOPMOST | WS_EX_TRANSPARENT`
- [ ] **3a.4.1** สร้าง `NetworkInspector` ตรวจจับ Active Sockets รายโปรเซส, การเปิด Virtual NIC/VPN, และการทำ Diff บน OS DNS Resolver Cache
- [ ] **3a.5.1** สร้าง `InputClipboardGuard` ตรวจจับ `LLKHF_INJECTED`, ความเร็วการพิมพ์ผิดธรรมชาติ, และการเปลี่ยนแปลงของ Clipboard จากภายนอก
- [ ] **3a.6.1** สร้าง `SelfIntegrityGuard` ตรวจจับ Debugger และสแกนหา Injected DLLs / Frida ในโปรเซสตัวเอง
- [ ] **3a.7.1** สร้าง `HardwareVmGuard` ตรวจจับ VM, Remote Desktop session, และการเปลี่ยนการตั้งค่าหน้าจอ

---

## 5. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **Disguised Binary Detection Test:** จำลองไฟล์ที่มี Metadata `OriginalFilename: "ollama.exe"` แต่ถูกเปลี่ยนชื่อไฟล์เป็น `calc_helper.exe` -> `ProcessInspector` ต้องระบุได้ว่าเป็น `DISGUISED_PROCESS_DETECTED`
   - **DNS Cache Diff Test:** จำลอง Snapshot ของ DNS Cache ก่อนและหลังที่มีโดเมน `api.openai.com` เพิ่มเข้ามา -> ต้องสร้าง Event `FORBIDDEN_DNS_QUERY_DETECTED` ทันที
   - **Clipboard Injection Test:** จำลองการเปลี่ยนค่าใน Clipboard โดยไม่ได้เกิดจากการคัดลอกภายในแอป -> ต้องสร้าง Event `EXTERNAL_CLIPBOARD_INJECTION` และล้าง Clipboard ทันที
   - **Typing Pattern Test:** จำลองการป้อนข้อความ 100 ตัวอักษรด้วยระยะห่าง `1 ms` คงที่ทุกตัวอักษร -> ต้องตรวจพบ `ABNORMAL_TYPING_PATTERN`
2. **Manual Verification:**
   - ทดสอบรันสคริปต์จำลองหน้าต่างลอยทับ (`AlwaysOnTop` + ซ่อนจากการจับภาพหน้าจอ) -> เครื่องนักเรียนต้องตรวจพบและส่ง `CAPTURE_EVADING_WINDOW_DETECTED` ไปยังเครื่องแม่ภายในรอบการตรวจถัดไปทันที
   - ทดสอบรันคำสั่ง CLI สั้นๆ ที่เปิดและปิดภายใน 200ms -> ตัวดักโปรเซสต้องจับ Command line ของคำสั่งนั้นและส่งรายงานไปที่เครื่องแม่ได้สำเร็จ


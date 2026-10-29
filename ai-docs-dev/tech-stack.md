# Tech Stack (v2)

เทคโนโลยีสำหรับ ZT-Exam ตาม arc ใน [project-arc.md](./project-arc.md)
แอปเดียวมี 2 บทบาท (Host ครู / Client นักเรียน) เลือกตอนเปิดโปรแกรม

---

## 1. สรุป (พร้อมเวอร์ชันล่าสุดที่ตรวจสอบจาก NPM Registry)

| ชั้น | เทคโนโลยี | เวอร์ชันล่าสุด (Verified) | หมายเหตุ |
|---|---|:---:|---|
| Desktop runtime | **Electron** | `^45.0.0` (LTS: `^44.9.3`) | Chromium ตัวเดียวกันทุก OS (Windows / macOS / Linux) |
| ภาษา | **TypeScript** | `^7.0.2` | Type-safe ทั้ง main, preload, renderer |
| UI Framework | **React** | `^19.3.1` | คอนโทรลและหน้าจอทุกส่วนของแอป |
| Dev tooling & Bundler | **electron-vite** + **Vite** | `^6.0.0` / `^8.3.5` | รวม Vite สำหรับ main/preload/renderer |
| Styling | **Tailwind CSS** | `^4.3.3` | Utility-first CSS ทันสมัยและเบา |
| State Management | **Zustand** | `^5.0.16` | จัดการ state ฝั่ง renderer |
| Icons | **lucide-react** | `^1.62.0` | ไอคอนสถานะ (Shield, Lock, Wifi, Users ฯลฯ) |
| Schema / Validation | **Zod** | `^4.6.7` | ตรวจสอบ message ทุกตัวที่รับจากเครือข่ายและ IPC |
| ฐานข้อมูลผลสอบ (Host) | **better-sqlite3** | `^13.0.3` | SQLite ประสิทธิภาพสูง + field-level AES-256-GCM |
| ตรวจจับ Hardware/OS | **systeminformation** | `^5.33.16` | รายชื่อโปรเซส, Sockets, และ Network Interfaces ข้าม OS |
| Temporary TLS Cert | **selfsigned** | `^5.5.0` | สร้าง Ephemeral Self-Signed Cert ใหม่ต่อห้อง |
| Native Addon Hook | **node-addon-api** | `^8.9.2` | N-API C++ สำหรับ Low-level Keyboard Hook (Win32) |
| Packaging & Installer | **electron-builder** | `^26.18.0` | `.exe` / `.dmg` / `.deb` / `.AppImage` |
| Electron Hardening | **@electron/fuses** | `^2.1.3` | ตั้งค่า Fuse ทำลายประตูหลัง CLI/Env ในขั้นตอนแพ็กเกจ |
| Unit & Integration Test | **Vitest** | `^5.0.5` | ทดสอบความถูกต้องของโปรโตคอล, Crypto, และ Sandbox |
| Code Editor (code-ide) | **monaco-editor** | `^0.57.0` | Editor ออฟไลน์สำหรับโมดูลเขียนโค้ด (Phase 8) |
| Offline Fast Bundler | **esbuild** | `^0.28.2` | แปลง TS/React JSX/TSX ออฟไลน์ความเร็วสูง (Phase 9) |
| Headless DOM Runner | **jsdom** | `^29.1.1` | รัน bundle + assertionScript ตรวจ DOM อัตโนมัติใน Main (Phase 10 ค้าง — ไม่ต้องใช้ BrowserWindow) |
| Math Rendering | **katex** | `^0.19.1` | เรนเดอร์สมการคณิตศาสตร์ LaTeX ออฟไลน์ (Phase 12) |
| System Built-ins | **Node.js `dgram`, `tls`, `net`, `crypto`** | Built-in | UDP discovery, TLS 1.3 socket, Ed25519, AES-256-GCM |

---

## 2. Process & Modular Feature Architecture

ระบบแยกเป็น **Core Platform** (Network, Security, Detection, Triage, Screen Monitoring, Kiosk Shell) และ **Pluggable Exam Modules** (`src/modules/<moduleId>/`) เพื่อให้สามารถเพิ่มรูปแบบการสอบใหม่ในอนาคต (เช่น `dynamic-form`, `code-ide`, `external-url`) ได้โดยไม่ต้องแก้โค้ดแกนหลัก:

```text
Main process (Node + TS)
 ├─ core/
 │   ├─ network/      dgram discovery, tls server/client, protocol (Zod)
 │   ├─ host/         session manager, timer, audit log (hash chain), triage engine
 │   ├─ guard/        deep cheat detection suite (process, overlay, dns, input, vm)
 │   ├─ screen/       1fps thumbnail & 5-min encrypted ring buffer
 │   ├─ proxy/        local CONNECT proxy & controlled VS Code (Mode 3)
 │   ├─ attestation/  manifest verify/sign check, nonce + TLS-bound HMAC
 │   └─ native/       N-API addon
 └─ modules/          Backend ของแต่ละ Exam Module (ผ่าน HostExamModuleInterface)
     ├─ dynamic-form/ dispatcher ทีละข้อ, shuffler, validator, auto-grader, .ztform & CSV exporter
     └─ code-ide/     (อนาคต) workspace manager, test-case runner, code grader

Preload (contextIsolation: true) -> contextBridge expose typed Core API + Module Bus API

Renderer (React + Vite + Tailwind)
 ├─ core-host/        Room creator, Student triage dashboard, Screen inspector, Audit feed
 ├─ core-student/     Room join (PIN), Kiosk HUD (เวลา/สถานะ), Watermark, Freeze/Warning modal
 └─ modules/          UI ของแต่ละ Exam Module (ผ่าน RendererExamModuleInterface)
     ├─ dynamic-form/ FormBuilder (ครู), Grading/Responses (ครู), DynamicFormRunner (นักเรียน)
     └─ code-ide/     (อนาคต) ProblemBuilder (ครู), InAppCodeIdeWorkspace (นักเรียน)

WebContentsView (Mode 2 เท่านั้น) -> WebView เอกสารที่ whitelist
```

---

## 3. รายละเอียดสำคัญ

### 3.1 UI (React + Vite + Tailwind)
- **Host:** สร้างห้อง (เลือกโหมด, whitelist, blacklist, เวลา), กริดสถานะนักเรียน, live audit feed, ปุ่ม Start / Freeze / End, ตัวสร้างข้อสอบ
- **Client:** หน้าเลือกห้อง + กรอก PIN, หน้าทำข้อสอบ (ทีละข้อ), แถบ HUD (นับถอยหลัง, สถานะการเชื่อมต่อ), modal แจ้งเตือน
- Renderer ใช้ `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` และเข้าถึง main ผ่าน preload API ที่จำกัดเท่านั้น

### 3.2 Network และ Protocol
- **Discovery:** UDP broadcast บน port ที่กำหนด payload = ชื่อห้อง, port, cert fingerprint
- **ช่องทางหลัก:** TLS 1.3 บน TCP, cert ชั่วคราวต่อห้อง
- **การยืนยันเครื่องแม่:** ใช้ **Room PIN** ที่ครูแสดงบนจอ ยืนยัน fingerprint ก่อนเชื่อใจ (ไม่เชื่อ beacon อย่างเดียว เพราะปลอมได้)
- Message ทุกตัวมี schema (Zod), มีหมายเลขลำดับและ HMAC สำหรับคำตอบ เพื่อกัน replay/แก้ไข

### 3.3 Detection
- **Kiosk:** `kiosk`, `fullscreen`, `alwaysOnTop`, ปิด DevTools, ปิด context menu, บล็อก shortcut ของเบราว์เซอร์ที่ทำได้ใน Electron
- **Keyboard hook:** `globalShortcut` ของ Electron ไม่พอสำหรับ Alt+Tab / Win key ต้องใช้ **native addon** (Windows: low-level keyboard hook) macOS/Linux ทำได้จำกัดกว่า (macOS ใช้ presentation options, Linux ขึ้นกับ X11/Wayland) และยอมรับว่าใช้เป็น "ตรวจจับ" มากกว่า "บล็อก" ในบางระบบ
- **Screenshot/recording:** `setContentProtection(true)` ใช้ได้บน Windows/macOS, Linux ไม่รองรับ **ข้อควรระวัง:** อาจทำให้หน้าต่างข้อสอบเป็นสีดำในสตรีมหน้าจอของเราเอง (ดู 3.7) ต้องทดสอบและเลือกว่าจะเปิดหรือไม่
- **Process monitor:** poll ตามช่วงเวลา เทียบ blacklist/whitelist ส่ง event ให้ครู (มีช่องโหว่เปิดแล้วปิดเร็ว/เปลี่ยนชื่อ จึงใช้ร่วมกับตัวตรวจอื่น)
- **Connection monitor:** รายการ connection รายโปรเซส เทียบกับปลายทางที่อนุญาต จับ app ที่ไม่ผ่าน proxy
- **Integrity watchdog:** hash ไฟล์แอป, VS Code profile, โฟลเดอร์ extensions ตอนเริ่มและระหว่างสอบ
- **Audit log:** append-only ที่เครื่องแม่ แต่ละรายการผูก hash กับรายการก่อนหน้า (hash chain)

### 3.3.1 Screen Monitoring
- จับทุกจอด้วย `desktopCapturer` (แยกต่อ display)
- **Ring buffer 5 นาที** ที่เครื่องนักเรียน: `MediaRecorder` ไม่ได้ให้ chunk ที่เล่นได้เองทุกชิ้น จึงควร **หมุน recorder ทุก ~10 วินาที** ให้ได้ไฟล์เซกเมนต์ที่สมบูรณ์ในตัว แล้วเก็บเฉพาะเซกเมนต์ 5 นาทีล่าสุด เข้ารหัสด้วย AES-256-GCM ด้วยคีย์ต่อ session จากเครื่องแม่ และลบเมื่อจบสอบ
- **Thumbnail ~1 fps** ส่งไปเครื่องแม่ผ่าน TLS ที่มีอยู่
- **Pull on demand:** เครื่องแม่สั่งดู → client ส่งเซกเมนต์ที่เก็บไว้ตามด้วยภาพสด — ปัจจุบัน Live (720p/30fps) + การดึงเซกเมนต์วิ่งผ่าน **Raw UDP (dgram) + AES-256-GCM** (`udp-screen-protocol.ts` + `udp-crypto.ts`, handshake ผ่านท่อ TLS เดิม) มี fallback TCP/JPEG อัตโนมัติเมื่อ UDP ไม่พร้อม; Thumbnail ยังใช้ TLS
- **Pin on critical:** ล็อกเซกเมนต์รอบ event วิกฤตไม่ให้ถูกทับ
- ข้อจำกัดตามแพลตฟอร์ม: macOS ต้องมีสิทธิ์ Screen Recording, Linux Wayland ต้องใช้ X11 (รายละเอียดใน [project-arc.md](./project-arc.md) หัวข้อ 3.7)

### 3.4 Electron Hardening (ตั้งตอน package และตอนรัน)
- **Fuses (ตรวจสอบความรองรับตามเวอร์ชัน/OS):** ปิด `runAsNode`, ปิด `enableNodeOptionsEnvironmentVariable`, ปิด `enableNodeCliInspectArguments`, เปิด `onlyLoadAppFromAsar`, เปิด `enableEmbeddedAsarIntegrityValidation` (รองรับ Windows/macOS ไม่รองรับ Linux)
- **Launch guard:** ตรวจ `process.argv` และ environment ตอนเริ่ม ถ้าเจอ flag เช่น `--remote-debugging-port`, `--load-extension`, `--disable-web-security` ให้ปิดตัวเองและแจ้งครู (fuse `enableNodeCliInspectArguments` ไม่ครอบคลุม switch ของ Chromium จึงต้องกันเอง และต้องทดสอบจริง)
- **Code signing:** เซ็น installer/binary ตามแพลตฟอร์ม (Windows Authenticode, macOS signing + notarization)
- **Source protection:** การคอมไพล์เป็น V8 bytecode (Bytenode) ไม่ใช่เกราะป้องกันจริง (decompile ได้ด้วยเครื่องมือเฉพาะ) ถือเป็นทางเลือกเสริมเล็กน้อย **ไม่จำเป็นต้องใช้**

### 3.5 Attestation / Signing
- **Build time:** สร้าง manifest (SHA-256 ของทุกไฟล์) เซ็นด้วย **Ed25519 private key** ที่เก็บนอก repo (ควรอยู่ในฮาร์ดแวร์คีย์หรือเครื่อง offline)
- **Runtime:** เครื่องแม่ถือ public key ส่ง nonce, client ตอบ HMAC ที่ผูกกับ TLS exporter พร้อม manifest + signature ตรวจซ้ำแบบสุ่มเวลาตลอดการสอบ
- เป็นการยกระดับความยาก ไม่ใช่การรับประกัน (ไม่มี TPM-based attestation)

### 3.6 Mode 3: VS Code ที่ควบคุมได้
- เปิดด้วย `--user-data-dir` และ `--extensions-dir` ที่แอปเตรียมไว้ extension ติดตั้งล่วงหน้าและตรวจ hash
- ปิดฟีเจอร์ AI ผ่าน settings (ชื่อ setting ต้องตรวจสอบกับเวอร์ชัน VS Code ที่ใช้) และไม่เปิดให้ใช้ Marketplace
- Proxy: HTTP CONNECT whitelist แบบ default-deny, resolve DNS เอง, บันทึกโดเมนที่ขอทุกครั้ง โหมดตั้งต้น `report-only`
- Connection monitor ฟ้องการต่อเน็ตของโปรเซสที่ไม่ผ่าน proxy
- **ข้อจำกัด:** เป็นการตรวจจับ ไม่ใช่การบังคับ โปรแกรมที่ไม่ใช้ proxy ออกเน็ตตรง ๆ ได้ ถ้าต้องการบังคับจริงต้องใช้ firewall ของห้องแล็บหรือ OS (ตัวเลือกเสริม ไม่บังคับ)

---

## 4. โครงสร้างโปรเจกต์ที่แนะนำ (Modular Layout)

```text
lan-exam-system/
├── ai-docs-dev/
│   ├── project-arc.md
│   ├── tech-stack.md
│   └── plan/                  # แผนงานราย Phase (Phase 0 ถึง Phase 8)
├── native/                    # N-API addon (binding.gyp / C++)
├── scripts/                   # build, fuses, sign manifest (private key อยู่นอก repo)
├── src/
│   ├── shared/                # Shared schemas, IPC types & ExamModule contracts
│   │   ├── ipc-channels.ts
│   │   ├── protocol-schema.ts
│   │   └── module-contract.ts # Interface กลางของทุก Exam Module
│   ├── main/                  # Core Platform Main Process
│   │   ├── index.ts
│   │   ├── network/           # discovery.ts, tls-server.ts, tls-client.ts, framing.ts
│   │   ├── core-host/         # session-manager.ts, audit-log.ts, triage-engine.ts
│   │   ├── guard/             # process-inspector.ts, overlay-inspector.ts, network-inspector.ts
│   │   ├── screen/            # capture-manager.ts, ring-buffer.ts, stream-controller.ts
│   │   ├── proxy/             # connect-proxy.ts, vscode-controller.ts
│   │   └── attestation/       # manifest.ts, challenge.ts
│   ├── preload/               # index.ts, types.d.ts
│   ├── renderer/              # Core Platform Renderer Shell
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx, App.tsx
│   │       ├── core-host/     # RoomCreator, TriageDashboard, EvidenceDrawer, ScreenModal
│   │       ├── core-student/  # JoinRoom, KioskShell, HudBar, WatermarkOverlay
│   │       ├── components/    # UI พื้นฐานที่ใช้ร่วมกัน
│   │       └── store/         # Zustand core stores
│   └── modules/               # Pluggable Exam Feature Modules
│       ├── registry.ts        # ลงทะเบียนและค้นหา Exam Module ตาม moduleId
│       ├── dynamic-form/      # โมดูลข้อสอบ Dynamic Form (Phase 6 & 7)
│       │   ├── shared/        # form-schema.ts (12 input types, answer keys)
│       │   ├── main/          # backend.ts, dispatcher.ts, grader.ts, file-io.ts, csv-export.ts
│       │   └── renderer/      # FormBuilder/, ResponsesView/, StudentFormView/
│       └── code-ide/          # (อนาคต - Phase 8) โมดูลสอบเขียนโปรแกรมด้วย IDE ในแอป
│           ├── shared/
│           ├── main/
│           └── renderer/
├── electron-builder.yml
├── electron.vite.config.ts
├── tailwind.config.js
└── package.json
```

---

## 5. ตารางแพ็กเกจและเวอร์ชันล่าสุดสำหรับ `package.json` (Verified Catalog)

ตารางเวอร์ชันล่าสุดที่ดึงตรงจาก NPM Registry เพื่อใช้เป็นพิมพ์เขียวสำหรับ `package.json`:

```json
{
  "name": "zt-exam",
  "version": "1.0.0",
  "description": "Zero-Trust LAN Exam System (Host & Student Kiosk)",
  "main": "./out/main/index.js",
  "scripts": {
    "dev:host": "electron-vite dev --profile=host --role=host",
    "dev:student": "electron-vite dev --profile=student-1 --role=student --windowed-kiosk",
    "dev:pair": "concurrently -k -n host,student -c blue,green \"npm run dev:host\" \"npm run dev:student\"",
    "build": "electron-vite build",
    "postinstall": "electron-builder install-app-deps",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run",
    "package:win": "electron-builder --win",
    "package:mac": "electron-builder --mac",
    "package:linux": "electron-builder --linux"
  },
  "dependencies": {
    "better-sqlite3": "^13.0.3",
    "esbuild": "^0.28.2",
    "katex": "^0.19.1",
    "lucide-react": "^1.62.0",
    "monaco-editor": "^0.57.0",
    "node-addon-api": "^8.9.2",
    "react": "^19.3.1",
    "react-dom": "^19.3.1",
    "selfsigned": "^5.5.0",
    "systeminformation": "^5.33.16",
    "zod": "^4.6.7",
    "zustand": "^5.0.16"
  },
  "devDependencies": {
    "@electron/fuses": "^2.1.3",
    "@tailwindcss/vite": "^4.3.3",
    "@types/better-sqlite3": "^9.6.0",
    "@types/katex": "^0.16.7",
    "@types/node": "^26.6.5",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.2",
    "concurrently": "^9.1.2",
    "electron": "^45.0.0",
    "electron-builder": "^26.18.0",
    "electron-vite": "^6.0.0",
    "tailwindcss": "^4.3.3",
    "typescript": "^7.0.2",
    "vite": "^8.3.5",
    "vitest": "^5.0.5"
  }
}
```

---

## 6. สิ่งที่ตัดออกจาก v1 และเหตุผล

| รายการ | เหตุผล |
|---|---|
| Tauri/Rust เป็นแกนหลัก | เลือก Electron + TypeScript เพราะถนัดและ Chromium เหมือนกันทุก OS |
| AES-in-RAM แบบ nested | ข้อปัจจุบันต้องเป็น plaintext ใน renderer อยู่แล้ว ประโยชน์น้อย เหลือ TLS + at-rest encryption |
| ครอบ Google/MS Forms | ทำระบบข้อสอบเอง (เก็บเป็น External URL Mode ภายหลัง) |
| Bytenode เป็นเกราะหลัก | ไม่ใช่การป้องกันจริง |
| บล็อกเครือข่ายด้วย firewall เป็นแกน | เปลี่ยนเป็นตรวจจับและฟ้อง (firewall ห้องแล็บเป็นตัวเลือกเสริม) |

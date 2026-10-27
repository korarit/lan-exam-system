# Phase 5: Exam Modes 2 & 3 (In-App Docs & Controlled External Tools)

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
ขยายความสามารถของระบบให้รองรับการสอบแบบเปิดเอกสารและใช้เครื่องมือภายนอกได้ตามที่ครูตั้งค่าตอนเปิดห้อง:
- **Mode 2 (In-App Docs):** หน้าจอ Kiosk แบ่งครึ่ง ซ้ายเป็นข้อสอบ ขวาเป็น `WebContentsView` สำหรับเปิดเว็บเอกสารที่อยู่ใน Whitelist พร้อมดักจับและรายงานทุก URL ที่คลิก
- **Mode 3 (External Tools / Controlled VS Code):** อนุญาตให้เปิดโปรแกรมภายนอก เช่น **VS Code** โดยแอปจัดการเปิดด้วยโปรไฟล์ที่ควบคุมเอง (`--user-data-dir`, `--extensions-dir`) ปิดฟีเจอร์ AI ตรวจ Hash ของ Extensions ตลอดเวลา และรัน **Local HTTP CONNECT Proxy** ควบคู่กับ **Connection Monitor** เพื่อตรวจจับและฟ้องทุกความพยายามเข้าถึงโดเมนหรือบริการ AI ที่ไม่อยู่ใน Whitelist

### สิ่งที่ต้องได้เมื่อจบ Phase 5
- Mode 2 แสดงหน้าจอ Split-screen พร้อม `WebContentsView` ที่แยก Session/Sandbox ออกจากตัวแอปหลัก และกรอง URL ตาม Whitelist ได้ทั้งระดับ Domain และ Path prefix
- Mode 3 เปิด VS Code ด้วยโปรไฟล์ควบคุมได้ ตรวจ Hash ของ `settings.json` และโฟลเดอร์ `extensions` ก่อนและระหว่างสอบ
- Local HTTP CONNECT Proxy ทำงานบน `127.0.0.1:<randomPort>` บันทึกทุกโดเมนที่ถูกร้องขอ กรองด้วย Whitelist แบบ Default-deny (เลือกโหมด `report-only` หรือ `block-and-report` ได้) และ resolve DNS ด้วยตนเอง

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 5.1 Mode 2: Sandboxed In-App Docs Viewer (`src/main/browser/docs-view.ts`)
1. **การสร้างและจัดวาง `WebContentsView` แยกต่างหาก:**
   - ใช้ `new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'nopersist:exam-docs', devTools: false } })`
   - แนบเข้ากับหน้าต่างหลัก (`mainWindow.contentView.addChildView(docsView)`) และคำนวณขนาด `setBounds({ x, y, width, height })` ให้วางอยู่ครึ่งขวาของหน้าจอ (ใต้แถบ HUD) เมื่อนักเรียนเปิดแผงเอกสาร
2. **การดักจับและตรวจสอบ URL Whitelist (`src/main/browser/url-filter.ts`):**
   - รูปแบบกฎ Whitelist ที่ครูกำหนดได้:
     - ระดับโดเมนและซับโดเมน: เช่น `docs.python.org`, `*.cppreference.com`
     - ระดับ Path prefix: เช่น `developer.mozilla.org/en-US/docs/Web/JavaScript/*`
   - ดักจับที่ 3 ชั้นใน `docsSession` (`session.fromPartition('nopersist:exam-docs')`):
     1. `docsView.webContents.setWindowOpenHandler(({ url }) => ...)`: บล็อกการเด้งหน้าต่างใหม่ แต่ถ้า URL อยู่ใน Whitelist ให้โหลดในหน้าเดิมแทน (`docsView.webContents.loadURL(url)`)
     2. `docsView.webContents.on('will-navigate')` และ `'will-redirect'`: ตรวจสอบ URL ปลายทางก่อนเปลี่ยนหน้า
     3. `docsSession.webRequest.onBeforeRequest`: ตรวจสอบทุก mainFrame, subFrame, และ XHR/fetch request
3. **การรายงานผลตามโหมดบังคับใช้ (`enforcement: 'report-only' | 'block-and-report'`):**
   - **ถ้า URL อยู่ใน Whitelist:** อนุญาตให้โหลด และส่ง Event `DOCS_URL_VISITED` (`severity: 'normal'`) ไปบันทึกในประวัติการใช้งานของนักเรียน
   - **ถ้า URL ไม่อยู่ใน Whitelist (เช่น พยายามกดลิงก์ออกไปหน้า Google Search หรือเว็บ AI):**
     - ส่ง Event `UNAUTHORIZED_DOCS_URL_ATTEMPT` (`severity: 'critical'`) พร้อม URL เต็มไปฟ้องเครื่องแม่ทันที (การ์ดนักเรียนขึ้นสีแดงบน Dashboard ครู)
     - หากตั้งค่าเป็น `'block-and-report'` ให้สั่ง `event.preventDefault()` / `callback({ cancel: true })` และแสดงหน้าแจ้งเตือนภายในกรอบเอกสารว่า *"ไม่อนุญาตให้เข้าถึงเว็บไซต์นี้ในการสอบ"*

---

### 5.2 Mode 3: Local HTTP CONNECT & Forward Proxy (`src/main/proxy/connect-proxy.ts`)
เพื่อให้ตรวจจับได้ว่าโปรแกรมภายนอก (เช่น เบราว์เซอร์, VS Code, หรือเครื่องมือที่เคารพ Proxy) พยายามเชื่อมต่อไปยังโดเมนใด (เช่น `api.openai.com`, `claude.ai`, `api.deepseek.com` หรือเว็บที่ตั้งเป็น Gateway เอง):

1. **การรัน Local Proxy Server:**
   - เปิด Node.js `http.createServer()` บน `127.0.0.1:0` (ให้ OS สุ่มพอร์ตว่าง เช่น `127.0.0.1:54123`)
   - รองรับทั้ง:
     - **HTTPS Tunneling (`server.on('connect', (req, clientSocket, head) => ...)`):** อ่าน `hostname` และ `port` จาก `req.url` (เช่น `CONNECT api.openai.com:443`)
     - **Plain HTTP Requests (`server.on('request', (req, res) => ...)`):** อ่าน `hostname` และ `pathname` จาก `req.url` / `req.headers.host`
2. **การตรวจสอบ Whitelist และการ Resolve DNS เอง:**
   - **ห้ามอนุญาตการเชื่อมต่อด้วย IP Address ตรงๆ** (เช่น `CONNECT 104.18.32.7:443`) เพื่อป้องกันการหลบการตรวจชื่อโดเมน ถ้าเจอการต่อด้วย IP ตรงๆ ให้ถือว่าผิดกติกา (`DIRECT_IP_PROXY_ATTEMPT`, `severity: 'critical'`)
   - เทียบ `hostname` กับ `policy.allowedDomains` (Default-deny: อะไรที่ไม่อยู่ในรายการที่ครูอนุญาต ถือว่าเป็น `UNWHITELISTED_DOMAIN` ทั้งหมด ดังนั้นต่อให้เด็กตั้งโดเมน Gateway ของตัวเองขึ้นมาก็จะไม่อยู่ใน Whitelist และถูกจับได้ทันที)
   - **กรณีอยู่ใน Whitelist:**
     - บันทึก Event `PROXY_DOMAIN_ALLOWED` (`severity: 'normal'`)
     - ตัว Proxy ทำการ Resolve DNS ของ `hostname` เองแล้วเปิด `net.connect(port, resolvedIp)` เชื่อมท่อ `clientSocket.pipe(remoteSocket)`
   - **กรณีไม่อยู่ใน Whitelist:**
     - ส่ง Event `PROXY_DOMAIN_VIOLATION` (`severity: 'critical'`, ระบุ `hostname`, `port`, `timestamp`) ไปฟ้องเครื่องแม่ทันที!
     - ถ้าโหมดของห้องคือ `'block-and-report'`: ตอบกลับ `HTTP/1.1 403 Forbidden\r\n\r\n` และปิด `clientSocket` ทันที
     - ถ้าโหมดของห้องคือ `'report-only'`: บันทึกและฟ้องเครื่องแม่ให้ขึ้นสีแดงบน Dashboard พร้อมเชื่อมท่อให้ตามนโยบายเน้นตรวจจับและฟ้อง
3. **การทำงานร่วมกับ Connection Monitor (จาก Phase 3):**
   - หากมีโปรแกรมหรือสคริปต์ของนักเรียนที่ไม่ยอมวิ่งผ่าน `127.0.0.1:<proxyPort>` แต่พยายามต่อตรงออกสู่ IP ภายนอก ตัว `ConnectionGuard` (Phase 3) จะตรวจพบว่ามีโปรเซสอื่นนอกจากโปรเซสของ ZT-Exam เปิด Socket ออกนอกวง LAN และส่ง Event `PROXY_BYPASS_CONNECTION` (`severity: 'critical'`) ไปฟ้องเครื่องแม่ทันที

---

### 5.3 Mode 3: Controlled VS Code Launcher & Profile Integrity Watchdog (`src/main/guard/vscode-controller.ts`)
สำหรับการสอบเขียนโปรแกรมที่อนุญาตให้ใช้ VS Code แต่ไม่ต้องการให้ใช้ AI Extensions (เช่น GitHub Copilot, Continue, Cody, Cursor, Codeium):

1. **การเตรียม Controlled Profile ก่อนเปิด VS Code:**
   - แอปสร้างโฟลเดอร์โปรไฟล์เฉพาะสำหรับการสอบที่ `os.tmpdir()/ztexam-vscode-<sessionId>/`:
     - `user-data/User/settings.json`: เขียนไฟล์ตั้งค่าที่บังคับ:
       ```json
       {
         "http.proxy": "http://127.0.0.1:<proxyPort>",
         "http.proxyStrictSSL": true,
         "extensions.autoUpdate": false,
         "extensions.autoCheckUpdates": false,
         "chat.commandCenter.enabled": false,
         "inlineChat.enabled": false,
         "github.copilot.enable": { "*": false },
         "telemetry.telemetryLevel": "off"
       }
       ```
     - `extensions/`: คัดลอกเฉพาะโฟลเดอร์ Extension ที่ครูอนุญาตไว้ล่วงหน้า (เช่น Python language support, C/C++ IntelliSense ที่ตรวจ Hash แล้ว) หรือเริ่มด้วยโฟลเดอร์ว่าง (Clean extensions)
2. **การสั่งเปิด VS Code จากภายในแอปสอบ:**
   - นักเรียนกดปุ่ม **"เปิด VS Code สำหรับทำข้อสอบ"** บนแถบ HUD ของแอป
   - แอปสั่งรันโปรเซส `code` ด้วยพารามิเตอร์:
     ```text
     code --new-window <examWorkspaceDir> --user-data-dir <controlledUserDataDir> --extensions-dir <controlledExtensionsDir> --disable-workspace-trust
     ```
   - พร้อมส่งตัวแปรสภาพแวดล้อม `HTTP_PROXY=http://127.0.0.1:<proxyPort>` และ `HTTPS_PROXY=http://127.0.0.1:<proxyPort>` ให้โปรเซสลูกของ VS Code
3. **VS Code Integrity Watchdog (ตรวจจับการแอบลง Extension หรือแก้ Settings ระหว่างสอบ):**
   - คำนวณ Snapshot Hash ของไฟล์ `settings.json` และรายชื่อไฟล์ทั้งหมดใน `<controlledExtensionsDir>` ตอนเริ่มเปิด
   - ทุกๆ รอบการ Poll (สุ่ม 3–6 วินาที):
     1. ตรวจว่ามีไฟล์หรือโฟลเดอร์ใหม่ถูกเพิ่มเข้ามาใน `<controlledExtensionsDir>` หรือไม่ (กรณีเด็กพยายามกด Install from VSIX หรือก๊อปปี้โฟลเดอร์ extension AI เข้ามาใส่)
     2. ตรวจว่าค่าใน `settings.json` (เช่น `http.proxy`) ถูกแก้ไขหรือไม่
     3. ตรวจจาก `ProcessGuard` ว่ามีการเปิด VS Code หน้าต่างอื่นที่ไม่ได้ใช้ `--extensions-dir` ของเราหรือไม่ หรือมีการเปิดโปรแกรมตระกูล AI Editor เช่น `Cursor.exe`, `Windsurf.exe` หรือไม่
   - หากตรวจพบข้อใดข้อหนึ่ง -> ส่ง Event `VSCODE_PROFILE_TAMPERED` หรือ `UNAUTHORIZED_IDE_DETECTED` (`severity: 'critical'`) ไปฟ้องเครื่องแม่ทันที!

---

### 5.4 Floating / Docked HUD สำหรับ Mode 3 (`src/renderer/src/student/FloatingHud.tsx`)
เนื่องจากใน Mode 3 นักเรียนต้องสลับหน้าต่างไปพิมพ์โค้ดใน VS Code จึงไม่ล็อก Fullscreen ทับทั้งจอตลอดเวลา แต่ใช้ **Docked Top Bar / Always-on-Top Mini Bar**:
- แถบสถานะขนาดกะทัดรัดที่ปักหมุดอยู่ด้านบนสุดของหน้าจอ (`alwaysOnTop: true`) แสดง:
  - เวลาสอบที่เหลือ
  - ปุ่มสลับกลับมาเปิดดูโจทย์ข้อปัจจุบันเต็มจอ (`ดูโจทย์ / ส่งคำตอบ`)
  - ปุ่มเปิด VS Code (เฉพาะในโปรไฟล์ที่ควบคุม)
  - สถานะการเชื่อมต่อเครื่องแม่และสถานะ Proxy

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **5.1.1** สร้าง `DocsViewController` จัดการ `WebContentsView` แบ่งครึ่งจอด้านขวาใน Mode 2
- [ ] **5.1.2** สร้าง `UrlWhitelistFilter` ดักจับ `will-navigate`, `setWindowOpenHandler`, และ `onBeforeRequest` พร้อมส่ง Event รายงานเครื่องแม่
- [ ] **5.2.1** สร้าง `LocalConnectProxy` รองรับ HTTP/HTTPS `CONNECT`, บล็อกการต่อด้วย IP ตรงๆ, และตรวจสอบกับ `allowedDomains`
- [ ] **5.2.2** เชื่อมต่อ `LocalConnectProxy` เข้ากับระบบรายงาน Event (`PROXY_DOMAIN_ALLOWED` / `PROXY_DOMAIN_VIOLATION`) และโหมด `report-only` / `block-and-report`
- [ ] **5.3.1** สร้าง `VsCodeController` สำหรับเตรียม `--user-data-dir` และ `--extensions-dir` ที่ล็อกค่า Proxy และปิดฟีเจอร์ AI
- [ ] **5.3.2** สร้าง `VsCodeIntegrityWatchdog` ตรวจจับการแก้ไข `settings.json`, การแอบลง Extension เพิ่ม, หรือการรัน VS Code นอกโปรไฟล์ควบคุม
- [ ] **5.4.1** สร้าง UI สำหรับ Mode 2 (แถบ URL + ปุ่ม Back/Forward/Home ของเอกสารที่อนุญาต) และ Floating HUD สำหรับ Mode 3

---

## 4. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **URL & Domain Whitelist Matcher Test:** ทดสอบกฎเช่น `*.python.org` และ `developer.mozilla.org/en-US/docs/*`:
     - `https://docs.python.org/3/library/os.html` -> `ALLOWED`
     - `https://evil-python.org` -> `DENIED`
     - `https://api.openai.com/v1/chat/completions` -> `DENIED`
     - `https://104.18.32.7:443` (Direct IP) -> `DENIED (DIRECT_IP_ATTEMPT)`
   - **Local Proxy Integration Test:** รัน `LocalConnectProxy` แล้วจำลองการยิง `CONNECT` ไปยังโดเมนใน Whitelist และนอก Whitelist -> ตรวจสอบว่า Event `PROXY_DOMAIN_VIOLATION` ถูกสร้างขึ้นครบถ้วนและบล็อก/ปล่อยผ่านตรงตามโหมด `enforcement`
   - **VS Code Watchdog Test:** จำลองการสร้างโฟลเดอร์ใหม่ใน `extensions/` หรือแก้ไฟล์ `settings.json` ระหว่างสอบ -> Watchdog ต้องตรวจพบภายในรอบการ Poll ถัดไปทันที
2. **Manual Verification:**
   - ทดสอบเปิดห้องสอบ **Mode 2** (อนุญาตเฉพาะ `docs.python.org`) -> เปิดอ่านเอกสาร Python ได้ปกติ -> ลองคลิกลิงก์ที่ออกนอกโดเมน -> หน้าจอครูขึ้นแจ้งเตือนสีแดงพร้อมระบุ URL ที่พยายามเข้าทันที
   - ทดสอบเปิดห้องสอบ **Mode 3** -> กดเปิด VS Code จากในแอป -> ลองวางโฟลเดอร์ปลอมลงในโฟลเดอร์ `extensions` หรือลองเข้าเว็บนอก Whitelist ผ่าน Proxy -> หน้าจอครูขึ้นแจ้งเตือนสีแดงทันที


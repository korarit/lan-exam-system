# Phase 4: Binary Attestation, Native OS Guard & Electron Hardening

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
ยกระดับความยากในการดัดแปลงโปรแกรม (Anti-Tamper & Anti-Relay) โดยสร้างระบบเซ็นไฟล์แอปด้วยกุญแจลับของผู้พัฒนา (**Ed25519 Signed Manifest** แบบ Arma 3) ผูกการตรวจ **Challenge-Response เข้ากับ TLS Exporter** และส่งตรวจซ้ำแบบสุ่มเวลาตลอดการสอบ พร้อมสร้าง **Native OS Addon (N-API)** สำหรับดักปุ่มลัดระดับระบบปฏิบัติการ และปิดช่องโหว่ของ Electron ด้วย **Launch Guard** และ **Electron Fuses**

### สิ่งที่ต้องได้เมื่อจบ Phase 4
- สคริปต์สร้างกุญแจ Ed25519 (เก็บ Private Key นอก Repo) และสคริปต์เซ็น `app-manifest.json` ตอน Build
- ระบบ Remote Attestation ที่ผูกกับ TLS Session (`tlsSocket.exportKeyingMaterial`) และสุ่มส่ง Challenge ใหม่ตลอดการสอบเพื่อกัน Relay Attack
- Native Addon (N-API) ดักจับ/บล็อกปุ่มสลับหน้าจอ (`Alt+Tab`, `Win Key`, `Ctrl+Esc`) บน Windows และจัดการ Presentation Options บน macOS/Linux
- Launch Guard ป้องกันการเปิดแอปด้วย CLI flags หรือ Environment variables อันตราย (`--remote-debugging-port`, `ELECTRON_RUN_AS_NODE`) และตั้งค่า `@electron/fuses` ในขั้นตอน Package

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 4.1 Ed25519 Manifest Signing Pipeline (`scripts/sign-manifest.ts` & `src/main/attestation/manifest.ts`)
1. **การจัดการกุญแจ (Key Management):**
   - สคริปต์ `scripts/keygen.ts` สร้างคู่กุญแจ Ed25519:
     - **Private Key:** เก็บไว้ภายนอก Repository เท่านั้น (เช่น ผ่านตัวแปรสภาพแวดล้อมในเครื่อง Build Offline หรือ Hardware Token ห้าม commit ลง Git เด็ดขาด)
     - **Public Key:** ฝังไว้ในโค้ดฝั่งเครื่องแม่ (`src/main/attestation/trusted-keys.ts`) รองรับรายการ Public Keys หลายตัวเผื่อกรณีหมุนเปลี่ยนคีย์ (Key Rotation) และมีรายการ `revokedManifestIds`
2. **การสร้างและเซ็น Manifest ตอน Build (`scripts/sign-manifest.ts`):**
   - สแกนไฟล์สำคัญใน Build output (`app.asar` หรือไฟล์ใน bundle, ไฟล์ `.node` ของ native addon, และไฟล์ binary หลัก)
   - แบ่งไฟล์ `app.asar` ออกเป็นบล็อกย่อยขนาดบล็อกละ `64 KB` แล้วคำนวณ Merkle/Block Hashes พร้อมทั้ง Hash รวมทั้งไฟล์:
     ```ts
     interface SignedAppManifest {
       manifestId: string
       appVersion: string
       platform: 'win32' | 'darwin' | 'linux'
       arch: 'x64' | 'arm64'
       builtAt: number
       files: Record<string, {
         size: number
         sha256: string
         blockHashes64k?: string[] // ใช้สำหรับสุ่มตรวจเฉพาะช่วงไบต์ตอนรันจริง
       }>
       keyId: string
       signatureBase64: string // Ed25519 signature เหนือข้อมูลทั้งหมดข้างต้น
     }
     ```
   - บันทึกเป็นไฟล์ `resources/app-manifest.sig.json`

---

### 4.2 TLS-Bound Periodic Challenge-Response (`src/main/attestation/challenge.ts`)
เพื่อป้องกันไม่ให้นักเรียนใช้โปรแกรมที่ถูกแก้ไขเชื่อมต่อเข้าห้องสอบ แล้วแอบส่งต่อคำท้า (Nonce) ไปให้โปรแกรมแท้อีกตัวช่วยคำนวณคำตอบส่งกลับมา (Relay Attack):

1. **การผูก Challenge เข้ากับ TLS Session (TLS Channel Binding):**
   - ทั้งเครื่องแม่และเครื่องนักเรียนดึงค่า `tlsExporter = tlsSocket.exportKeyingMaterial(32, 'EXPORTER-ZT-EXAM-V1')` จากการเชื่อมต่อ TLS ปัจจุบัน (แต่ละการเชื่อมต่อ TLS จะได้ค่า `tlsExporter` ไม่ซ้ำกันเลย แม้จะต่อมาจากเครื่องเดียวกัน)
2. **โครงสร้างคำท้าจากเครื่องแม่ (`ATTESTATION_CHALLENGE`):**
   ```ts
   interface AttestationChallenge {
     challengeId: string
     serverNonce: string // random 32 bytes (hex)
     sampleRanges: Array<{
       relativePath: string // เช่น 'app.asar' หรือ 'native/os_guard.node'
       offset: number       // ตำแหน่งไบต์ที่สุ่มถาม
       length: number       // ความยาวไบต์ที่สุ่มถาม (เช่น 65536 bytes)
     }>
     deadlineMs: number     // ต้องตอบกลับภายในเวลาที่กำหนด (เช่น 2500 ms)
   }
   ```
3. **การคำนวณคำตอบที่เครื่องนักเรียน (`ATTESTATION_RESPONSE`):**
   - เครื่องนักเรียนอ่านไบต์จริงจากไฟล์ตาม `sampleRanges` ที่เครื่องแม่สุ่มถาม
   - คำนวณ:
     ```text
     responseHmac = HMAC_SHA256(
       key = tlsExporter,
       data = challengeId + "|" + serverNonce + "|" + sha256(manifestJson) + "|" + sampledBytesBuffer
     )
     ```
   - ส่ง `responseHmac` พร้อม `SignedAppManifest` (ในครั้งแรกที่เข้าห้อง) กลับไปให้เครื่องแม่
4. **การตรวจสอบที่เครื่องแม่และการสุ่มตรวจซ้ำตลอดการสอบ:**
   - **ตอนเข้าห้องสอบ (Join Attestation):**
     1. ตรวจลายเซ็น `signatureBase64` ใน `SignedAppManifest` ด้วย `Public Key` ของผู้พัฒนา
     2. ตรวจว่าค่า `responseHmac` ตรงกับค่าที่คำนวณจาก `blockHashes64k` ใน Manifest ที่เซ็นไว้และ `tlsExporter` ของท่อนั้น
   - **ระหว่างการสอบ (Periodic Re-Attestation):**
     - ทุกๆ ช่วงเวลาสุ่ม `45 - 120 วินาที` เครื่องแม่จะยิง `ATTESTATION_CHALLENGE` ใหม่โดยสุ่ม `offset` บล็อกใหม่ไปถามเครื่องนักเรียน
     - หากตอบช้าเกิน `deadlineMs` หรือค่า HMAC ไม่ตรง -> บันทึก Event `ATTESTATION_VERIFICATION_FAILED` (`CRITICAL`), เปลี่ยนการ์ดเป็นสีแดง และสั่ง Freeze หน้าจอข้อสอบทันที
   - **โหมด Development (`isDev`):**
     - ในระหว่างพัฒนาที่ยังไม่ได้รันสคริปต์เซ็น Release ให้แสดงป้ายเตือนชัดเจนบนหน้าจอครูว่า `"⚠️ DEV MODE: อนุญาต Client ที่ไม่ได้เซ็นลายเซ็น"` และสามารถเปิดสวิตช์บังคับตรวจลายเซ็นจริงได้จากหน้าตั้งค่าห้องสอบ

---

### 4.3 Launch Guard & Environment Sanitizer (`src/main/guard/launch-guard.ts`)
ทำงานเป็นบรรทัดแรกสุดใน `src/main/index.ts` ก่อนที่ `app.whenReady()` จะเริ่มทำงาน:

1. **การตรวจสอบ Command-Line Switches อันตราย:**
   - ตรวจสอบทั้ง `process.argv` และ `process.execArgv` รวมถึงเรียก `app.commandLine.hasSwitch(...)` สำหรับรายการต้องห้าม:
     - `--remote-debugging-port`
     - `--remote-debugging-pipe`
     - `--remote-allow-origins`
     - `--inspect`, `--inspect-brk`, `--inspect-port`
     - `--load-extension`, `--disable-extensions-except`
     - `--disable-web-security`, `--allow-running-insecure-content`
     - `--host-resolver-rules`, `--proxy-server` (ยกเว้นเมื่อตั้งโดยโค้ดภายในของเราเอง)
2. **การตรวจสอบ Environment Variables อันตราย:**
   - ตรวจ `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `ELECTRON_ENABLE_LOGGING`, `LD_PRELOAD` (Linux), `DYLD_INSERT_LIBRARIES` (macOS)
3. **การตอบสนองเมื่อตรวจพบ:**
   - หากอยู่ในโหมด Production และพบ flag หรือ env ข้างต้น:
     - บันทึกหลักฐานไว้เพื่อส่งแจ้งเครื่องแม่เมื่อเชื่อมต่อ (หรือปฏิเสธการรันเข้าโหมดนักเรียนทันทีพร้อมแสดงข้อความแจ้งข้อผิดพลาด)

---

### 4.4 Native OS Addon สำหรับ Keyboard & Window Guard (`native/`)
เนื่องจาก `globalShortcut` ของ Electron ไม่สามารถบล็อกปุ่มระดับระบบอย่าง `Alt+Tab` หรือ `Windows Key` ได้:

1. **สถาปัตยกรรมโมดูล `src/main/guard/native-bridge.ts`:**
   - ออกแบบ Interface กลางที่มี Fallback อย่างปลอดภัย (ถ้าระบบปฏิบัติการใดไม่รองรับการบล็อกปุ่มในระดับ OS ระบบจะไม่แครช แต่จะทำงานในโหมด **ตรวจจับผ่าน `FocusGuard` แล้วฟ้องเครื่องแม่ทันที** ตามหลัก Detect & Report)
2. **Windows Implementation (`native/win32_hook.cc` ผ่าน `node-addon-api`):**
   - ใช้ `SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc, NULL, 0)` บน Thread เฉพาะเมื่อเข้าสู่โหมดกำลังทำข้อสอบ (Mode 1 และ Mode 2)
   - ดักจับและส่งสัญญาณแจ้งเตือนเมื่อมีการกด:
     - `VK_LWIN`, `VK_RWIN` (ปุ่ม Windows)
     - `VK_TAB` เมื่อกดคู่กับ `LLKHF_ALTDOWN` (`Alt+Tab`)
     - `VK_ESCAPE` เมื่อกดคู่กับ `Alt` หรือ `Ctrl` (`Alt+Esc`, `Ctrl+Esc`)
     - `VK_F4` เมื่อกดคู่กับ `Alt` (`Alt+F4`)
     - `VK_SNAPSHOT` (`PrintScreen`)
   - เมื่อตรวจพบ: บล็อกปุ่มไม่ให้ส่งต่อไปยัง OS (`return 1`) **และ** ส่ง callback แจ้ง Main process ให้ยิง Event `BLOCKED_SYSTEM_SHORTCUT` ไปฟ้องเครื่องแม่ทันที
   - เมื่อจบการสอบหรือออกจากโหมด Kiosk ต้องเรียก `UnhookWindowsHookEx` คืนสถานะปกติให้เครื่องทันทีเสมอ (รวมถึงผูกกับ `app.on('will-quit')` และ `process.on('uncaughtException')`)
3. **macOS & Linux Handling:**
   - **macOS:** ตั้งค่า Kiosk Presentation Options ของ Electron (`setKiosk(true)` ซึ่งเปิดใช้งาน `NSApplicationPresentationDisableProcessSwitching` และ `DisableForceQuit` ของ macOS โดยอัตโนมัติ)
   - **Linux:** ใช้ Fullscreen Kiosk grab ร่วมกับ `FocusGuard` คอยตรวจจับการสลับ Workspace หรือการเสียโฟกัสแล้วฟ้องเครื่องแม่ทันที

---

### 4.5 Packaging & Electron Fuses Configuration (`scripts/apply-fuses.ts` & `electron-builder.yml`)
1. **การตั้งค่า `@electron/fuses` ในขั้นตอน `afterPack` ของ `electron-builder`:**
   ```ts
   await flipFuses(electronBinaryPath, {
     version: FuseVersion.V1,
     [FuseV1Options.RunAsNode]: false,
     [FuseV1Options.EnableCookieEncryption]: true,
     [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
     [FuseV1Options.EnableNodeCliInspectArguments]: false,
     [FuseV1Options.OnlyLoadAppFromAsar]: true,
     // เปิดเฉพาะบน Windows และ macOS (Linux ยังไม่รองรับใน Electron ปัจจุบัน)
     [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: platform === 'win32' || platform === 'darwin'
   })
   ```
2. **การตั้งค่า `electron-builder.yml`:**
   - เปิด `asar: true`
   - แยกไฟล์ที่ต้องรันเป็นไบนารี (`native/*.node`, `better-sqlite3`) ไว้ใน `asarUnpack` แต่ทุกไฟล์ใน `asarUnpack` จะถูกรวมอยู่ใน `app-manifest.sig.json` ที่ตรวจ Hash ด้วย Ed25519 เสมอ

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **4.1.1** สร้างสคริปต์ `scripts/keygen.ts` และ `scripts/sign-manifest.ts` สำหรับสร้างและเซ็น `app-manifest.sig.json` ด้วย Ed25519
- [ ] **4.2.1** สร้าง `AttestationResponder` (Client) และ `AttestationVerifier` (Host) ที่ผูก HMAC เข้ากับ `tlsExporter`
- [ ] **4.2.2** สร้างระบบสุ่มส่ง `ATTESTATION_CHALLENGE` ซ้ำทุก 45–120 วินาทีตลอดการสอบ
- [ ] **4.3.1** สร้าง `LaunchGuard` ตรวจจับ CLI flags และ Environment variables อันตรายตั้งแต่เริ่มโปรเซส
- [ ] **4.4.1** สร้าง `native-bridge.ts` พร้อม Native Keyboard Hook สำหรับ Windows (`WH_KEYBOARD_LL`) และ Fallback สำหรับ macOS/Linux
- [ ] **4.5.1** สร้างสคริปต์ `scripts/apply-fuses.ts` และผูกเข้ากับ `afterPack` hook ใน `electron-builder.yml`

---

## 4. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **Manifest Tamper Test:** เซ็น Manifest ด้วย Private Key -> ลองแก้ไขเนื้อหาไฟล์จำลองไป 1 ไบต์ -> `AttestationVerifier` ต้องตรวจพบว่า HMAC ของบล็อกที่สุ่มตรวจไม่ตรงและปฏิเสธทันที
   - **Relay Attack Prevention Test:** จำลอง Client A ส่ง Challenge ของตัวเองไปให้ Client B (ที่มีไฟล์แท้แต่เชื่อมต่ออยู่คนละ TLS session จึงมีค่า `tlsExporter` ต่างกัน) คำนวณ HMAC ส่งกลับมา -> เครื่องแม่ต้องปฏิเสธทันทีเพราะ `tlsExporter` ไม่ตรงกัน
   - **Launch Guard Test:** ทดสอบส่งอาร์กิวเมนต์ `['--remote-debugging-port=9222']` เข้าฟังก์ชันตรวจ -> ต้องคืนค่าสถานะถูกบล็อกพร้อมระบุชื่อ flag ที่ตรวจพบ
2. **Manual Verification:**
   - ทดสอบ Build แพ็กเกจจริง (`npm run build:unpack`) แล้วลองรันด้วย `ELECTRON_RUN_AS_NODE=1` หรือ `--inspect` -> โปรแกรมต้องไม่ยอมทำงานในโหมด Node/Debug
   - ทดสอบกด `Alt+Tab` หรือปุ่ม `Windows` ระหว่างอยู่ในหน้าทำข้อสอบ -> ต้องมี Event แจ้งเตือนขึ้นบน Dashboard ของครูทันที


# Phase 2: Core Exam Lifecycle, Kiosk Shell & Module Dispatcher (MVP)

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
สร้างแกนกลางของการควบคุมการสอบแบบ **Host-Authoritative** (`CoreSessionManager` และ `ModuleHostDispatcher`) ที่ทำหน้าที่เชื่อมต่อระหว่าง **Core Platform** กับ **Pluggable Exam Modules (`src/modules/*`)** พร้อมสร้างโมดูลข้อสอบพื้นฐานชุดแรก (Core Stepping Runner สำหรับส่งข้อสอบทีละข้อ สลับลำดับข้อ/ตัวเลือกต่อคน และสุ่มตัวแปร ซึ่งจะถูกขยายเป็น `dynamic-form` เต็มรูปแบบใน Phase 6–7) รวมถึงระบบ Kiosk Shell, Watermark, Autosave, และ Crash Recovery

### สิ่งที่ต้องได้เมื่อจบ Phase 2
- **`ExamModuleRegistry` และ `ModuleHostDispatcher`:** ท่อกลางที่รับส่งข้อมูลของโมดูลการสอบ (`MODULE_STATE_PUSH`, `MODULE_ACTION_SUBMIT`, `MODULE_AUTOSAVE_DRAFT`) โดยที่ Core Platform เป็นผู้ตรวจ HMAC, ลำดับ Sequence, และเวลาสอบจากเครื่องแม่ให้ทุกโมดูลโดยอัตโนมัติ
- ระบบส่งโจทย์ทีละข้อ (1-by-1 Delivery) สลับลำดับข้อและตัวเลือกเฉพาะคนด้วย Seeded PRNG
- เครื่องนักเรียนแสดงผลในโหมด **Core Kiosk Shell** (เต็มจอ, Watermark ชื่อ/รหัสนักเรียน, แถบ HUD นับเวลาถอยหลัง, บล็อก Copy/คลิกขวา/คีย์ลัด) โดยพื้นที่ตรงกลางหน้าจอจะโหลด `StudentExamWorkspace` ตาม `moduleId` ที่ห้องสอบนั้นเลือกใช้
- กรณีเครื่องนักเรียนค้างหรือรีสตาร์ท เมื่อกลับเข้ามาใหม่ Core Platform จะสั่งให้โมดูลกู้คืนสถานะและคำตอบ `draft` ล่าสุดจากเครื่องแม่ได้ทันที

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 2.1 โครงสร้างข้อสอบและการสุ่มประจำตัวนักเรียน (`src/shared/exam-schema.ts` & `src/main/host/shuffler.ts`)
1. **Exam Package Schema (`ExamDefinition`):**
   ```ts
   const QuestionChoiceSchema = z.object({
     choiceId: z.string(),
     text: z.string()
   })

   const BaseQuestionSchema = z.object({
     questionId: z.string(),
     type: z.enum(['mcq', 'short-answer', 'essay']),
     promptTemplate: z.string(), // รองรับตัวแปร เช่น "จงหาค่าของ {{a}} + {{b}}"
     points: z.number().positive(),
     allowBackNavigation: z.boolean().default(false), // ค่าตั้งต้น: ส่งแล้วไปข้อถัดไป ไม่ย้อนกลับ
     parameters: z.record(z.object({
       min: z.number().int(),
       max: z.number().int(),
       step: z.number().int().default(1)
     })).optional()
   })

   const McqQuestionSchema = BaseQuestionSchema.extend({
     type: z.literal('mcq'),
     choices: z.array(QuestionChoiceSchema).min(2),
     correctChoiceId: z.string() // เก็บไว้ที่เครื่องแม่เท่านั้น ห้ามส่งไป Client เด็ดขาด!
   })
   ```
2. **Deterministic Seeded PRNG (`src/main/host/shuffler.ts`):**
   - เมื่อนักเรียนเข้าห้องสอบ เครื่องแม่สร้าง `studentSeed = HMAC_SHA256(roomSecretSeed, studentId)`
   - ใช้ PRNG ที่กำหนดค่าได้จาก `studentSeed` (เช่น `mulberry32` หรือ `xoshiro128**` จาก seed 128-bit):
     1. **สลับลำดับข้อสอบ (`questionOrder`):** ใช้ Fisher-Yates shuffle บนรายการ `questionId[]` เก็บลงตาราง `students`
     2. **สลับลำดับตัวเลือก (`choiceOrder`):** สำหรับข้อปรนัย สลับลำดับ `choiceId[]` เฉพาะของนักเรียนคนนั้น
     3. **สุ่มค่าพารามิเตอร์ (`resolvedParams`):** หากโจทย์มี `{{a}}`, `{{b}}` ให้สุ่มค่าจาก `studentSeed + questionId` แล้วแทนค่าลงในโจทย์ก่อนส่งให้นักเรียน พร้อมบันทึกค่าพารามิเตอร์ที่สุ่มได้ไว้ตรวจคำตอบที่เครื่องแม่
   - **ข้อดี:** เพื่อนที่นั่งข้างกันจะเห็นข้อ 1 เป็นคนละโจทย์กัน และถึงโจทย์เดียวกันลำดับตัวเลือก A, B, C, D หรือตัวเลขในโจทย์ก็จะไม่ตรงกัน และหากนักเรียนหลุดแล้วต่อใหม่ เครื่องแม่ก็คำนวณลำดับเดิมกลับมาได้เป๊ะ 100%

---

### 2.2 Host-Authoritative Question Dispatcher (`src/main/host/dispatcher.ts`)
1. **กฎการส่งข้อสอบทีละข้อ (1-by-1 Strict Stepping):**
   - เครื่องแม่เก็บ `currentQuestionCursor` (0 ถึง `N-1`) ของนักเรียนแต่ละคน
   - เครื่องแม่จะส่งเฉพาะข้อมูลของข้อที่ `cursor` ปัจจุบันไปให้ Client เท่านั้น (`ClientQuestionPayload` จะไม่มี `correctChoiceId` และไม่มีข้ออื่นๆ ในชุดข้อสอบ)
2. **ขั้นตอนการส่งคำตอบและขอข้อถัดไป (`SUBMIT_ANSWER_AND_ADVANCE`):**
   - นักเรียนกดยืนยันคำตอบข้อปัจจุบัน -> Client ส่ง:
     ```ts
     {
       questionId: string,
       cursorIndex: number,
       answer: { type: 'mcq', choiceId: string } | { type: 'text', content: string },
       timeSpentMs: number,
       seq: number,
       hmac: string // HMAC_SHA256(dynamicSessionKey, payload)
     }
     ```
   - เครื่องแม่ตรวจสอบ:
     1. เวลาสอบของห้องยังไม่หมด (`now <= examEndTime + gracePeriodMs`)
     2. `hmac` ถูกต้อง และ `cursorIndex === student.currentQuestionCursor`
     3. บันทึกคำตอบลง SQLite แบบเข้ารหัส (AES-256-GCM) พร้อมเวลาที่เครื่องแม่ได้รับ (`serverReceivedAt`)
     4. เลื่อน `student.currentQuestionCursor += 1`
     5. ส่ง `QUESTION_PAYLOAD` ของข้อถัดไปกลับไปให้เครื่องนักเรียน (หรือส่ง `EXAM_COMPLETED` หากทำครบทุกข้อแล้ว)
3. **โหมดอนุญาตให้ย้อนกลับแก้ไข (Optional Policy: `allowBackNavigation: true`):**
   - หากครูตั้งค่าห้องให้ย้อนกลับไปแก้ข้อที่เคยเปิดดูแล้วได้ เครื่องแม่ยังส่งให้ทีละข้อตามที่นักเรียนกดเลือก แต่จะยอมให้เปิดเฉพาะข้อที่ `index <= maxReachedCursor` เท่านั้น (ห้ามกดข้ามไปดูข้อล่วงหน้าที่ยังทำไปไม่ถึง)

---

### 2.3 Autosave, Crash Recovery & Time Synchronization (`src/main/host/recovery.ts`)
1. **Draft Autosave (กันไฟดับ/เครื่องค้างระหว่างพิมพ์ข้ออัตนัย):**
   - ขณะที่นักเรียนกำลังพิมพ์คำตอบหรือเลือกตัวเลือกอยู่ (ยังไม่กดส่งข้อ) ทุกๆ `5000 ms` (เมื่อข้อมูลมีการเปลี่ยนแปลง) Client จะส่ง `AUTOSAVE_DRAFT` ไปยังเครื่องแม่
   - เครื่องแม่เก็บลงตาราง `draft_submissions` (ทับค่า draft ล่าสุดของข้อนั้น)
2. **Reconnection State Recovery:**
   - ถ้านักเรียนเครื่องดับหรือหลุดแล้วเชื่อมต่อกลับเข้ามาใหม่:
     - เครื่องแม่ตรวจสอบ `studentId` และสถานะห้องสอบ
     - ส่ง `STATE_RECOVERY_PAYLOAD` ที่บรรจุ:
       - ข้อปัจจุบันที่ทำค้างอยู่ (`currentQuestionCursor` และ `ClientQuestionPayload`)
       - คำตอบ `draft` ล่าสุดที่เครื่องแม่บันทึกไว้
       - เวลาที่เหลือจริงจากนาฬิกาเครื่องแม่ (`remainingSeconds`)
3. **Centralized Exam Timer & Auto-Collect ตอนหมดเวลา:**
   - เครื่องแม่เป็นคนนับถอยหลังเวลาสอบ
   - เมื่อเวลาเหลือ `0` วินาที:
     - เครื่องแม่ส่ง `EXAM_TIME_UP` ไปยังทุกเครื่องทันที
     - เครื่องนักเรียนส่ง `FINAL_DRAFT_FLUSH` (คำตอบที่กำลังพิมพ์ค้างอยู่ในข้อปัจจุบัน) ภายใน Grace Period `3000 ms`
     - เครื่องแม่นำ `draft` ล่าสุดของข้อที่ทำค้างอยู่มาบันทึกเป็นคำตอบที่ส่งแล้วโดยอัตโนมัติ แล้วเปลี่ยนสถานะเป็น `FINISHED`

---

### 2.4 Encrypted Result Store & Auto-Grading (`src/main/host/result-store.ts`)
1. **การเข้ารหัสข้อมูลคำตอบใน SQLite:**
   - คำตอบของนักเรียนในตาราง `submissions` จะถูกเข้ารหัสด้วย `AES-256-GCM` โดยใช้ `roomStorageKey`
   - มีการคำนวณ `rowHmac = HMAC_SHA256(roomStorageKey, studentId + questionId + encryptedAnswer + serverReceivedAt)` ป้องกันการเปิดไฟล์ SQLite มาแก้คำตอบทีหลังโดยไม่มีคีย์
2. **การตรวจให้คะแนนอัตโนมัติ (Auto-Grading):**
   - สำหรับข้อ `mcq`: เทียบ `submittedChoiceId === question.correctChoiceId`
   - สำหรับข้อ `short-answer`: รองรับการตรวจแบบ Exact match (trim ช่องว่าง, ตั้งค่า case-sensitive ได้) หรือตรวจกับนิพจน์คำตอบของพารามิเตอร์ที่สุ่ม (เช่น `a + b`)
   - สำหรับข้อ `essay`: ทำเครื่องหมายเป็น `PENDING_MANUAL_GRADE` เพื่อให้ครูตรวจให้คะแนนบนหน้าจอหลังสอบ

---

### 2.5 Student Kiosk UI, Anti-Copy & Dynamic Watermark (`src/renderer/src/student/`)
1. **การล็อกหน้าต่างพื้นฐาน (Kiosk Window):**
   - เมื่อเข้าห้องสอบสำเร็จและเริ่มสอบ Main process สั่ง:
     - `win.setKiosk(true)`, `win.setFullScreen(true)`, `win.setAlwaysOnTop(true, 'screen-saver')`
     - บล็อกเมนูคลิกขวา (`context-menu` -> `e.preventDefault()`)
     - บล็อกการเปิดหน้าต่างใหม่ (`setWindowOpenHandler(() => ({ action: 'deny' }))`)
     - บล็อกคีย์ลัดของ Chromium ใน `before-input-event` (`F12`, `Ctrl+Shift+I`, `Ctrl+R`, `F5`, `Ctrl+P`, `Ctrl+S`, `Ctrl+F`, `Alt+Left/Right`)
2. **Anti-Copy / Clipboard Guard:**
   - ในหน้า Exam UI ตั้งค่า CSS `user-select: none` สำหรับส่วนโจทย์และตัวเลือกทั้งหมด (ยกเว้นช่อง `<textarea>` / `<input>` ที่นักเรียนต้องพิมพ์คำตอบของตัวเอง)
   - ดักจับ event `onCopy`, `onCut`, `onPaste`, `onDragStart` บนโจทย์ไม่ให้ทำงาน และล้าง Clipboard ตอนเริ่มสอบ
3. **Dynamic Canvas/SVG Watermark (`WatermarkOverlay.tsx`):**
   - แสดงลายน้ำแบบโปร่งแสง (`opacity: 0.08 - 0.12`, `pointer-events: none`, `z-index: 9999`) ทับทั่วหน้าจอข้อสอบในแนวทแยง
   - เนื้อหาในลายน้ำ: `รหัสนักเรียน • ชื่อ-นามสกุล • ชื่อเครื่อง • เวลาปัจจุบัน`
   - ขยับตำแหน่งเล็กน้อยทุก 30 วินาทีและวาดผ่าน `<canvas>` เพื่อกันการลบและช่วยให้ระบุตัวคนถ่ายรูปหน้าจอได้ทันทีแม้ถ่ายติดเพียงบางส่วนของจอ
4. **Student HUD & Exam View:**
   - **Top HUD Bar:** แสดงชื่อวิชา, ข้อที่กำลังทำ (`ข้อที่ 5 / 30`), สถานะการบันทึก (`บันทึกอัตโนมัติเมื่อ 2 วินาทีที่แล้ว`), สัญญาณเชื่อมต่อเครื่องแม่, และเวลานับถอยหลัง (เปลี่ยนเป็นสีส้มเมื่อเหลือ < 5 นาที และสีแดงเมื่อ < 1 นาที)
   - **Question Card:** แสดงโจทย์และช่องตอบขนาดชัดเจน ปรับขนาดตัวอักษรได้ (`A-` / `A+`) และมีปุ่ม **"ยืนยันคำตอบและไปข้อถัดไป"** พร้อม Modal ยืนยันกรณีไม่ให้ย้อนกลับ

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **2.1.1** สร้าง Zod schema สำหรับ `ExamDefinition`, `Question`, และ `ClientQuestionPayload` (แยกฟิลด์เฉลยออกอย่างเด็ดขาด)
- [ ] **2.1.2** สร้าง `shuffler.ts` พร้อม Seeded PRNG สำหรับสลับลำดับข้อ, สลับตัวเลือก, และแทนค่าตัวแปรพารามิเตอร์
- [ ] **2.2.1** สร้าง `QuestionDispatcher` ที่ฝั่งเครื่องแม่ จัดการ cursor รายคนและส่งข้อสอบทีละข้อ
- [ ] **2.2.2** สร้างระบบตรวจสอบ HMAC ของคำตอบและตรวจเวลาสอบที่ฝั่งเครื่องแม่
- [ ] **2.3.1** สร้างระบบ Autosave ทุก 5 วินาที และการกู้คืนสถานะ (`STATE_RECOVERY_PAYLOAD`) เมื่อเชื่อมต่อใหม่
- [ ] **2.3.2** สร้างระบบนับเวลาถอยหลังที่เครื่องแม่ และสั่งเก็บข้อสอบอัตโนมัติเมื่อหมดเวลา (`EXAM_TIME_UP`)
- [ ] **2.4.1** สร้าง `ResultStore` บันทึกคำตอบแบบเข้ารหัส AES-256-GCM ลง SQLite พร้อมระบบตรวจข้อปรนัยและเติมคำสั้นอัตโนมัติ
- [ ] **2.5.1** ตั้งค่า Kiosk Window และ `before-input-event` บล็อกคีย์ลัดและเมนูคลิกขวา
- [ ] **2.5.2** สร้าง `WatermarkOverlay.tsx` วาดลายน้ำรหัสนักเรียนและเวลาทับหน้าจอ
- [ ] **2.5.3** สร้างหน้าจอทำข้อสอบของนักเรียน (`ExamView.tsx`, `HudBar.tsx`, `QuestionRenderer.tsx`) และหน้าจอสรุปผลเบื้องต้นที่ฝั่งครู

---

## 4. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **Zero-Leakage Test:** ตรวจสอบว่า `ClientQuestionPayload` ที่สร้างจาก `QuestionDispatcher` ไม่มีฟิลด์ `correctChoiceId` หรือข้อมูลของข้อสอบข้อถัดไปปะปนอยู่ใน JSON เลย
   - **Deterministic Shuffle Test:** นักเรียน 2 คนที่มี `studentId` ต่างกัน ต้องได้ลำดับข้อและตัวเลือกต่างกัน แต่ถ้ารันด้วย `studentId` เดิมและ `roomSecretSeed` เดิม ต้องได้ลำดับเดิมทุกครั้ง 100%
   - **Stepping Enforcement Test:** ทดสอบส่งคำตอบของข้อที่ 5 ทั้งที่นักเรียนอยู่ข้อที่ 2 -> เครื่องแม่ต้องปฏิเสธและบันทึก anomaly event
2. **Manual Verification:**
   - ทดสอบเริ่มสอบจากเครื่องแม่ -> เครื่องนักเรียนเข้าโหมดเต็มจอ เห็นโจทย์ข้อที่ 1 พร้อมลายน้ำชื่อตัวเอง
   - ลองพิมพ์คำตอบข้ออัตนัยค้างไว้ รอ 5 วินาที แล้วจำลองการปิดโปรเซสเครื่องนักเรียน -> เปิดเข้ามา Join ห้องเดิมใหม่ -> ต้องกลับมาที่ข้อเดิมพร้อมข้อความที่พิมพ์ค้างไว้ครบถ้วน
   - เมื่อเวลาสอบหมด หน้าจอนักเรียนต้องล็อกทันทีและคำตอบที่ทำค้างอยู่ต้องถูกบันทึกที่เครื่องแม่ครบ


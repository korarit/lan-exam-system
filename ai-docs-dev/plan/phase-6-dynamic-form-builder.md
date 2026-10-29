# Phase 6: `dynamic-form` Module — Form Builder, 12 Input Types & `.ztform` File

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
พัฒนาโมดูลการสอบ **`dynamic-form` (`src/modules/dynamic-form/`)** ตามสถาปัตยกรรม **Pluggable Exam Module (`ExamModuleContract`)** ให้เป็นระบบฟอร์มข้อสอบแบบ Dynamic สไตล์ **Google Forms / Microsoft Forms** ที่ฝังอยู่ในตัวแอป รองรับชนิดของ Input ครบ 12 ประเภท ตั้งค่าเฉลยและเกณฑ์คะแนนรายข้อได้ทันที และสามารถ **บันทึกฟอร์มเป็นไฟล์ (`.ztform`)** เพื่อนำไปเปิดใช้งาน (Load) บนเครื่องแม่ในห้องสอบได้แบบออฟไลน์ 100%

### โครงสร้างโฟลเดอร์ของโมดูล `src/modules/dynamic-form/`
```text
src/modules/dynamic-form/
├── index.ts                     # ลงทะเบียนโมดูล 'dynamic-form' เข้าสู่ ExamModuleRegistry
├── shared/
│   ├── form-schema.ts           # Zod schemas ของ 12 Input types, Validation rules & Answer keys
│   └── form-actions.ts          # โครงสร้าง Action ที่ส่งผ่าน Module Dispatcher
├── main/
│   ├── form-module-backend.ts   # Implement HostExamModuleBackend<'dynamic-form'>
│   ├── form-file-io.ts          # Save / Load / Encrypt ไฟล์ .ztform
│   ├── validator.ts             # Server-side input validation (Phase 7)
│   ├── grader.ts                # Instant Auto-Grading & Re-grade All (Phase 7)
│   └── exporter.ts              # CSV (UTF-8 BOM) & .ztresults Exporter (Phase 7)
└── renderer/
    ├── builder/                 # HostBuilderView: หน้าสร้างและแก้ไขฟอร์มสไตล์ Google Forms
    ├── responses/               # HostResponsesView: หน้าตรวจคำตอบ สถิติ และปุ่ม Export (Phase 7)
    └── student/                 # StudentExamWorkspace: หน้าแสดงโจทย์ทั้ง 12 ชนิดของนักเรียน
```

### สิ่งที่ต้องได้เมื่อจบ Phase 6
- โครงสร้างข้อมูล `DynamicFormSchema` ที่รองรับโจทย์และ Input ครบ 12 ประเภท พร้อมการตั้งค่า Validation และ Answer Key ในตัว
- หน้าจอ **Visual Form Builder** (สไตล์ Google Forms) บนฝั่งครู: เพิ่ม/ลบ/ลากจัดลำดับข้อ, แบ่ง Section, แนบรูปภาพแบบฝังในตัวไฟล์ (Offline Base64/Asset), ตั้งค่าคะแนนและเฉลยรายข้อ, และโหมดจำลองทำข้อสอบ (Live Preview)
- ระบบ **Save & Load Portable Form File (`.ztform`)**: บันทึกชุดฟอร์มพร้อมรูปภาพและเฉลยลงเป็นไฟล์เดียว (เลือกเข้ารหัสด้วยรหัสผ่านครูได้) เพื่อพกใส่ Flash Drive หรือส่งต่อให้เครื่องแม่ในห้องแล็บเปิดใช้งานได้ทันที

---

## 2. ประเภทของ Input ที่รองรับทั้งหมด (Supported Dynamic Input Types)

ระบบออกแบบให้ทุกข้อสอบเป็น Dynamic Block ที่ครูเลือกเปลี่ยนชนิด Input ได้เหมือน Google Forms ดังนี้:

| ลำดับ | รหัสชนิด (`inputType`) | ชื่อชนิด Input | รายละเอียดการทำงานและการตั้งค่า | การตรวจเฉลยอัตโนมัติ (Auto-Grading) |
|---|---|---|---|---|
| **1** | `mcq_single` | **Multiple Choice (ตัวเลือกเดียว)** | ปุ่มตัวเลือก (Radio) แนบรูปภาพประกอบตัวเลือกได้ ตั้งค่าให้สลับลำดับตัวเลือกรายคนได้ | เทียบ `choiceId` กับเฉลย (หรือให้คะแนนตามน้ำหนักของแต่ละตัวเลือก) |
| **2** | `checkbox_multi` | **Checkboxes (หลายตัวเลือก)** | เลือกได้มากกว่า 1 ข้อ กำหนดจำนวนเลือกขั้นต่ำ/สูงสุด (`minSelect`, `maxSelect`) ได้ | รองรับ 3 โหมด: **1) ถูกทุกข้อจึงได้คะแนน (All-or-Nothing)**, **2) ได้คะแนนตามสัดส่วนหักข้อผิด (Partial with Penalty)**, **3) คะแนนแยกตามตัวเลือก** |
| **3** | `dropdown` | **Dropdown (รายการดรอปดาวน์)** | รายการตัวเลือกแบบประหยัดพื้นที่หน้าจอ สลับลำดับตัวเลือกรายคนได้ | เทียบ `choiceId` กับเฉลยที่ตั้งไว้ |
| **4** | `short_text` | **Short Answer (คำตอบสั้น 1 บรรทัด)** | ช่องพิมพ์ข้อความสั้น ตั้ง Validation ได้ (ความยาวตัวอักษร, ตัวเลขเท่านั้น, หรือ Regex) | เทียบกับรายการคำตอบที่ยอมรับได้หลายคำตอบ (`acceptedAnswers[]`) เลือกเปิด/ปิด Case-sensitive, Trim ช่องว่าง, หรือตรวจด้วย Regex ได้ |
| **5** | `long_text` | **Paragraph / Essay (คำตอบยาวหลายบรรทัด)** | ช่องพิมพ์เรียงความ/อธิบายวิธีทำ กำหนดจำนวนคำหรือตัวอักษรขั้นต่ำ/สูงสุดได้ | ตั้งเป็น **รอครูตรวจ (`Manual Review`)** พร้อมเกณฑ์ Rubric หรือตั้งค่าให้ช่วยไฮไลต์ Keyword สำคัญในคำตอบให้อัตโนมัติ |
| **6** | `numeric_param` | **Numeric / Parameterized (ตัวเลขและตัวแปรสุ่ม)** | ช่องรับค่าตัวเลข (จำนวนเต็มหรือทศนิยม) มีป้ายหน่วยกำกับ (เช่น `m/s`, `บาท`) และรองรับตัวแปรสุ่มในโจทย์ เช่น `{{a}}`, `{{b}}` | คำนวณคำตอบที่ถูกต้องจากสูตรของครู (เช่น `a * b + 10`) เทียบกับคำตอบนักเรียนภายในค่าคลาดเคลื่อนที่ยอมรับได้ (`±tolerance` เช่น `±0.01`) |
| **7** | `mcq_grid` | **Multiple Choice Grid (ตารางตัวเลือกเดียวต่อแถว)** | ตาราง `Rows × Columns` ที่แต่ละแถวต้องเลือก 1 คอลัมน์ (เหมาะกับโจทย์จับคู่ หรือถามถูก/ผิดหลายข้อย่อยในข้อเดียว) | ตรวจเฉลยแยกทีละแถว (`rowId -> correctColumnId`) คิดคะแนนรายแถวรวมกัน |
| **8** | `checkbox_grid` | **Checkbox Grid (ตารางหลายตัวเลือกต่อแถว)** | ตาราง `Rows × Columns` ที่แต่ละแถวเลือกได้หลายคอลัมน์ | ตรวจเฉลยรายแถว/รายช่อง พร้อมคำนวณคะแนนแบบเต็มแถวหรือตามสัดส่วน |
| **9** | `linear_scale` | **Linear Scale (สเกลระดับคะแนน)** | แถบเลือกตัวเลขเรียงลำดับ (เช่น `1 ถึง 5` หรือ `0 ถึง 10`) พร้อมป้ายกำกับฝั่งซ้ายสุดและขวาสุด | เทียบค่าตัวเลขที่เลือกกับเฉลย (หรือใช้เป็นข้อไม่คิดคะแนน/แบบสอบถามท้ายข้อสอบ) |
| **10** | `date_time` | **Date / Time Picker (วันที่และเวลา)** | ช่องระบุวันที่ (`YYYY-MM-DD`) หรือเวลา (`HH:mm`) | เทียบค่าวันที่/เวลาตรงกับเฉลยที่กำหนด |
| **11** | `code_snippet` | **Code Answer Box (กล่องพิมพ์โค้ด)** | กล่องพิมพ์โค้ดฟอนต์ Monospace พร้อมเลขบรรทัด, จัดย่อหน้า (Tab), เลือกภาษา (`python`, `c`, `cpp`, `java`, `sql`, `js`) และใส่ Starter Code ตั้งต้นได้ | ตรวจเบื้องต้นด้วย Regex/Pattern หรือส่งเข้าคิวตรวจให้คะแนนโดยครูพร้อม Syntax Highlighting |
| **12** | `file_upload` | **Local File Upload (แนบไฟล์ส่งเข้าเครื่องแม่)** | ช่องอัปโหลดไฟล์งานของนักเรียน (เช่น `.py`, `.cpp`, `.pdf`, `.png`, `.zip`) จำกัดนามสกุลไฟล์และขนาดสูงสุด (เช่น ไม่เกิน 10 MB) | ส่งไฟล์ผ่านท่อ TLS เข้าเก็บในเครื่องแม่โดยตรง (ไม่ต้องใช้อินเทอร์เน็ต) รอครูเปิดดูและให้คะแนน |

> นอกจากนี้ยังมีบล็อกประเภท **`section_header` (แบ่งตอน/คำชี้แจง)** และ **`media_stimulus` (รูปภาพ/ตารางข้อมูลประกอบโจทย์)** ที่แทรกคั่นหรือผูกติดกับข้อสอบได้

---

## 3. การแบ่งงานย่อย (Detailed Sub-phases)

### 6.1 Dynamic Form Schema & Validation Rules (`src/shared/form-schema.ts`)
1. **การออกแบบ Schema ที่แยกส่วน "ข้อมูลแสดงผลฝั่งนักเรียน" กับ "ข้อมูลเฉลยฝั่งเครื่องแม่":**
   ```ts
   const FormValidationRuleSchema = z.object({
     required: z.boolean().default(true),
     minLength: z.number().int().optional(),
     maxLength: z.number().int().optional(),
     minSelect: z.number().int().optional(),
     maxSelect: z.number().int().optional(),
     numericMin: z.number().optional(),
     numericMax: z.number().optional(),
     regexPattern: z.string().optional(),
     customErrorMessage: z.string().optional(),
     allowedExtensions: z.array(z.string()).optional(), // เช่น ['.py', '.pdf']
     maxFileSizeBytes: z.number().int().optional()
   })

   const AnswerKeySchema = z.discriminatedUnion('gradingType', [
     z.object({
       gradingType: z.literal('exact_choice'),
       correctChoiceId: z.string(),
       choiceWeights: z.record(z.number()).optional()
     }),
     z.object({
       gradingType: z.literal('multi_choice'),
       correctChoiceIds: z.array(z.string()),
       scoringMode: z.enum(['all-or-nothing', 'partial-with-penalty']),
       penaltyPerWrongRatio: z.number().min(0).max(1).default(0.5)
     }),
     z.object({
       gradingType: z.literal('short_text_match'),
       acceptedAnswers: z.array(z.string()).min(1),
       caseSensitive: z.boolean().default(false),
       trimWhitespace: z.boolean().default(true),
       useRegex: z.boolean().default(false)
     }),
     z.object({
       gradingType: z.literal('numeric_formula'),
       formulaOrValue: z.string(), // เช่น "25.5" หรือ "(a * b) / 2"
       tolerance: z.number().nonnegative().default(0.01)
     }),
     z.object({
       gradingType: z.literal('grid_match'),
       rowAnswerMap: z.record(z.union([z.string(), z.array(z.string())])),
       pointsPerRow: z.number().positive()
     }),
     z.object({
       gradingType: z.literal('manual_rubric'),
       rubricCriteria: z.array(z.object({
         criterionId: z.string(),
         title: z.string(),
         maxPoints: z.number().positive()
       })).optional(),
       expectedKeywords: z.array(z.string()).optional(),
       teacherReferenceNote: z.string().optional()
     }),
     z.object({
       gradingType: z.literal('ungraded')
     })
   ])
   ```
2. **ฟังก์ชัน `stripAnswerKeyForStudent(formItem, studentSeed)`:**
   - รับประกันในระดับ Type และ Runtime ว่าก่อนส่งโจทย์ข้อใดไปที่เครื่องนักเรียน ฟิลด์ `answerKey` จะถูกตัดทิ้ง 100% เสมอ และทำการสลับลำดับ `choices` หรือ `rows` รวมถึงแทนค่าพารามิเตอร์ `{{a}}` ให้เสร็จที่ฝั่งเครื่องแม่

---

### 6.2 Google-Forms-Style Visual Form Builder UI (`src/renderer/src/host/form-builder/`)
1. **โครงสร้างหน้าจอสร้างฟอร์ม (`FormBuilderWorkspace.tsx`):**
   - **ส่วนหัวฟอร์ม (Form Settings Header):**
     - ตั้งชื่อชุดข้อสอบ, คำชี้แจงก่อนเริ่มสอบ, เวลาสอบเริ่มต้น (นาที)
     - ตั้งค่าพฤติกรรมของฟอร์ม:
       - `shuffleQuestionsPerStudent`: สลับลำดับข้อรายคนหรือไม่
       - `navigationPolicy`: `'strict-one-way'` (ส่งข้อแล้วห้ามย้อนกลับ) หรือ `'allow-visited-review'` (ย้อนกลับไปแก้ข้อที่เคยเปิดแล้วได้ แต่ห้ามกดดูข้อล่วงหน้า)
       - `showScoreImmediatelyAfterSubmit`: อนุญาตให้นักเรียนเห็นคะแนนข้อปรนัยของตัวเองหลังกดส่งข้อสอบทั้งหมดหรือไม่ (ค่าเริ่มต้น: ปิดไว้จนกว่าครูจะกดปล่อยคะแนน)
   - **รายการการ์ดคำถามแบบลากวางได้ (`QuestionCardList.tsx`):**
     - คลิกที่การ์ดข้อใด การ์ดนั้นจะขยายโหมดแก้ไข (เหมือน Google Forms):
       - พิมพ์โจทย์, แนบรูปภาพประกอบโจทย์ (ลากไฟล์รูปมาวาง ระบบจะย่อขนาดที่เหมาะสมและแปลงเก็บเข้าคลัง Asset ของฟอร์มทันที)
       - ดรอปดาวน์เลือกชนิด Input ทั้ง 12 ชนิด (เปลี่ยนชนิดได้โดยข้อความโจทย์ไม่หาย)
       - ปุ่ม **"🔑 เฉลยคำตอบและคะแนน (Answer Key)"** มุมล่างซ้ายของการ์ด: คลิกแล้วสลับเข้าโหมดติ๊กเลือกข้อที่ถูก กำหนดคะแนนของข้อนั้น และเพิ่มคำอธิบายเฉลย
       - ปุ่มทำซ้ำข้อ (`Duplicate Question`), ลบข้อ, และสวิตช์ `จำเป็นต้องตอบ (Required)`
   - **แถบเครื่องมือลอยด้านข้าง (`FloatingBuilderToolbar.tsx`):**
     - `+ เพิ่มคำถามใหม่`
     - `📥 นำเข้าคำถามจาก CSV / JSON`
     - `📑 เพิ่มส่วนแบ่งตอน (Add Section)`
     - `👁️ ทดลองทำในมุมมองนักเรียน (Preview as Student)`

---

### 6.3 Portable Form File Format (`.ztform`) — Save, Load & Encryption (`src/main/host/form-file-io.ts`)
เพื่อให้ครูสามารถสร้างข้อสอบจากที่บ้านหรือคอมพิวเตอร์ส่วนตัว แล้วบันทึกเป็นไฟล์นำมาเปิด (`Load`) บนเครื่องแม่ในห้องสอบได้ทันทีโดยไม่ต้องต่ออินเทอร์เน็ต:

1. **โครงสร้างไฟล์ `.ztform`:**
   - เป็นไฟล์ Container เดียวที่บรรจุ:
     1. `manifest`: เวอร์ชันของฟอร์ม (`formatVersion: 1`), `formId`, `title`, `createdAt`, `updatedAt`, `totalQuestions`, `totalPoints`
     2. `formDefinition`: โครงสร้างข้อสอบทั้งหมด, การตั้งค่า, และ `answerKey`
     3. `assets`: รูปภาพประกอบโจทย์และตัวเลือกทั้งหมด (เก็บเป็น Content-Addressed Map `sha256 -> { mimeType, dataBase64 }` เพื่อว่าถ้ารูปเดียวกันใช้ในหลายข้อ จะเก็บเพียงครั้งเดียว ไม่ทำให้ไฟล์ใหญ่เกินจำเป็น)
     4. `integrityHmac`: ค่า SHA-256 / HMAC ตรวจสอบว่าไฟล์ไม่เสียหาย
2. **รองรับ 2 โหมดการบันทึกไฟล์ (`Save Form File`):**
   - **โหมดที่ 1: เข้ารหัสด้วยรหัสผ่านครู (`.ztform` Encrypted - ค่าเริ่มต้นที่แนะนำ):**
     - ใช้ `PBKDF2-HMAC-SHA256` (`100,000 iterations`, random 16-byte salt) แปลงรหัสผ่านของครูเป็นคีย์ 256-bit แล้วเข้ารหัสเนื้อหาฟอร์มทั้งหมดด้วย `AES-256-GCM`
     - ต่อให้ไฟล์ `.ztform` บน Flash Drive ของครูหลุดไปอยู่ในมือนักเรียนก่อนสอบ นักเรียนก็ไม่สามารถเปิดดูโจทย์หรือเฉลยได้หากไม่มีรหัสผ่าน!
   - **โหมดที่ 2: ไฟล์มาตรฐานสำหรับแลกเปลี่ยน/สำรอง (`.ztform` Standard Signed JSON):**
     - สำหรับเก็บในคลังข้อของครูหรือนำเข้าสู่ระบบอื่น
3. **การโหลดฟอร์มเข้าเครื่องแม่ (`Load Form into Host`):**
   - บนหน้าแรกของฝั่งครู มีปุ่ม **"📂 เปิดไฟล์ชุดข้อสอบ (`.ztform`)"** และรายการฟอร์มที่เคยเปิดล่าสุดในเครื่องแม่ (เก็บไว้ใน SQLite ตาราง `saved_forms`)
   - เมื่อเลือกไฟล์ `.ztform` (และกรอกรหัสผ่านหากไฟล์ถูกเข้ารหัสไว้):
     - ระบบตรวจสอบ Schema ด้วย Zod และตรวจสอบ `integrityHmac`
     - แสดงสรุปชุดข้อสอบ (`จำนวน 30 ข้อ • คะแนนเต็ม 50 คะแนน • มีรูปภาพประกอบ 8 รูป`)
     - ครูสามารถกด **"แก้ไขฟอร์ม"** หรือกด **"🚀 เปิดห้องสอบด้วยฟอร์มนี้ทันที"** ได้เลย

---

## 4. Checklist งานย่อย (Implementation Checklist)

- [x] **6.1.1** สร้าง Zod Schema สำหรับ Input ทั้ง 12 ชนิด, `FormValidationRuleSchema`, และ `AnswerKeySchema` ใน `src/modules/dynamic-form/shared/form-schema.ts`
- [x] **6.1.2** สร้างฟังก์ชัน `stripAnswerKeyForStudent` ที่ตัดเฉลยและเตรียมตัวเลือก/พารามิเตอร์ตาม Seed ของนักเรียนแต่ละคน (`src/modules/dynamic-form/shared/student-view.ts`)
- [x] **6.2.1** สร้าง UI `FormBuilderWorkspace.tsx` และการ์ดแก้ไขคำถามสไตล์ Google Forms รองรับการเปลี่ยนชนิด Input ทั้ง 12 แบบ (`src/modules/dynamic-form/renderer/builder/` เข้าถึงผ่านแท็บ Dynamic Form Builder ฝั่งครู)
- [x] **6.2.2** สร้างโหมด `AnswerKeyEditor.tsx` ในการ์ดคำถามแต่ละชนิดสำหรับตั้งเฉลย เกณฑ์คะแนน และโหมดการหักคะแนน
- [x] **6.2.3** สร้างระบบแนบรูปภาพแบบ Offline Content-Addressed Asset (ย่อขนาดอัตโนมัติด้วย canvas และฝังในชุดฟอร์มด้วย sha256 → `builder-assets.ts`)
- [x] **6.2.4** สร้างโหมด `StudentFormPreviewModal.tsx` ให้ครูทดลองทำข้อสอบและทดสอบการตรวจเฉลยได้ทันทีขณะสร้างฟอร์ม (ใช้ `form-grading.ts` คิดคะแนนอัตโนมัติในพรีวิว)
- [x] **6.3.1** สร้างโมดูล `main/form-file-io.ts` สำหรับ Save และ Load ไฟล์ `.ztform` (PBKDF2-HMAC-SHA256 100,000 รอบ + AES-256-GCM + HMAC ตรวจ integrity เชื่อมผ่าน IPC `form:save-ztform` / `form:load-ztform` / `host:list-saved-forms` และตาราง SQLite `saved_forms`)
- [x] **6.3.2** สร้างตัวนำเข้าคำถามจากไฟล์ CSV / JSON Template (`shared/csv-import.ts` — ครูเลือกไฟล์ผ่านหน้า Builder)

---

## 5. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **12 Input Types Schema Test:** ทดสอบ validate โครงสร้างข้อมูลของคำถามทั้ง 12 ชนิดและทดสอบว่า `stripAnswerKeyForStudent` ลบฟิลด์ `answerKey` ออกเกลี้ยงในทุกชนิด Input 100%
   - **`.ztform` Round-Trip & Encryption Test:** สร้างฟอร์มที่มีคำถามครบทุกชนิดพร้อมรูปภาพจำลอง -> บันทึกเป็นไฟล์ `.ztform` แบบใส่รหัสผ่าน -> ลองโหลดด้วยรหัสผ่านผิดต้องถูกปฏิเสธ -> โหลดด้วยรหัสผ่านถูกต้องได้ข้อมูลคำถาม เฉลย และรูปภาพกลับมาตรงกับต้นฉบับทุกไบต์
2. **Manual Verification:**
   - ทดสอบสร้างฟอร์มใหม่ในหน้า Form Builder เพิ่มคำถามครบทุกชนิด ตั้งเฉลย แล้วกด Save ออกมาเป็นไฟล์ `midterm-exam.ztform`
   - ลองปิดแอป เปิดใหม่ แล้วกด Load ไฟล์ `midterm-exam.ztform` เข้าสู่เครื่องแม่เพื่อเปิดห้องสอบ -> เครื่องนักเรียนที่เชื่อมต่อเข้ามาต้องแสดงผล Input แต่ละชนิดได้อย่างถูกต้องและสวยงาม


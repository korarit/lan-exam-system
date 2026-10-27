# Phase 12: Post-MVP Extensions (Cloud Sync, Offline KaTeX Math & External URL Mode)

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
ต่อยอดระบบหลังจากแกนหลักของแพลตฟอร์ม, ระบบตรวจจับการโกง (Phase 3a–3c), โมดูล `dynamic-form` (Phase 6–7), และโมดูล `code-ide` (Phase 8–11) ทำงานได้ครบสมบูรณ์แล้ว เพื่อเพิ่มความสามารถในการซิงก์ข้อมูลผลสอบขึ้น Cloud ของสถาบันหลังจบการสอบ การแสดงผลสมการคณิตศาสตร์ขั้นสูง (KaTeX) และการรองรับโหมดเปิดลิงก์เว็บสอบภายนอก (`external-url` Module)

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 12.1 Post-Exam Encrypted Cloud Sync (`src/main/core-host/cloud-sync.ts`)
ตามสถาปัตยกรรมที่กำหนดไว้: **เครื่องนักเรียนไม่ต่อ Cloud ตรงๆ เด็ดขาด** แต่เครื่องแม่สามารถอัปโหลดชุดผลสอบ (`.ztresults` / ซอร์สโค้ดที่ส่งใน `code-ide`) และ Audit Log ขึ้น Cloud ของสถาบันได้ **หลังจากจบการสอบแล้ว**:

1. **โครงสร้างข้อมูลที่จะ Sync (`ExamArchiveBundle`):**
   - ข้อมูลห้องสอบ, ชุดข้อสอบ (`.ztform` หรือ `.ztcode`), และรายชื่อผู้เข้าสอบ
   - คำตอบ, ซอร์สโค้ด, ไฟล์แนบ, และคะแนนของนักเรียนทุกคน (จาก Phase 7 และ Phase 10)
   - ตาราง `audit_logs` ทั้งหมดพร้อมค่า Hash Chain และลายเซ็นรับรองจากเครื่องแม่ (จาก Phase 3b)
   - เซกเมนต์วิดีโอที่ถูก Pin ไว้จากเหตุการณ์วิกฤต (จาก Phase 3c ถ้าครูเลือกให้อัปโหลดแนบไปด้วย)
2. **การส่งขึ้น HTTPS API ของเราเอง:**
   - รองรับการตั้งค่า `Cloud Endpoint URL` และ `API Token / Institution Key`
   - มีคิวอัปโหลดแบบ Retry อัตโนมัติหากอินเทอร์เน็ตของห้องสอบเพิ่งเชื่อมต่อได้หลังสอบเสร็จ

---

### 12.2 Offline LaTeX / Math Equation Rendering (`src/renderer/src/components/rich-text/`)
- รองรับการแทรกสมการคณิตศาสตร์ เคมี และฟิสิกส์ด้วยไวยากรณ์ LaTeX (`$...$` และ `$$...$$`) ทั้งในโจทย์ของโมดูล `dynamic-form` และในคำอธิบายโจทย์ของโมดูล `code-ide`
- เรนเดอร์ด้วย **KaTeX** แบบออฟไลน์ 100% จากฟอนต์ที่ฝังอยู่ในแอป ไม่ต้องโหลด CDN จากอินเทอร์เน็ต

---

### 12.3 Pluggable Module #3: `external-url` Wrapper Mode (`src/modules/external-url/`)
สำหรับกรณีที่ผู้จัดสอบบางวิชาต้องการนำลิงก์ระบบสอบเว็บภายนอกที่มีอยู่แล้ว (เช่น ระบบ LMS ภายในของมหาวิทยาลัย) มาเปิดภายใต้ระบบ Kiosk + Deep Cheat Detection (Phase 3a) + Screen Monitoring (Phase 3c) ของเรา:
- ลงทะเบียนเป็นโมดูล `external-url` ใน `ExamModuleRegistry`
- ใช้ `WebContentsView` เต็มพื้นที่ข้อสอบควบคู่กับ `UrlWhitelistFilter` (จาก Phase 5)
- เครื่องแม่ส่งลิงก์ฟอร์มให้เฉพาะเครื่องที่ผ่าน Attestation และกดเริ่มสอบแล้วเท่านั้น
- ระบบตรวจจับโปรเซส, ตรวจจับ Stealth Overlay, ตรวจ DNS Cache, การส่ง Thumbnail ~1 fps, และ Ring Buffer 5 นาที ยังทำงานเต็มรูปแบบเหมือนทุกโมดูล

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **12.1.1** สร้างโมดูล `CloudSyncService` ที่ฝั่งเครื่องแม่สำหรับอัปโหลดชุดผลสอบและ Audit Chain ขึ้น HTTPS API หลังจบการสอบ
- [ ] **12.2.1** ผสาน KaTeX สำหรับเรนเดอร์สมการคณิตศาสตร์แบบออฟไลน์ในโจทย์ของทุกโมดูล
- [ ] **12.3.1** สร้างโมดูล `src/modules/external-url/` โดยใช้เอนจิน `WebContentsView` + Whitelist จาก Phase 5


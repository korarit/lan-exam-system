# Phase 3b: Cryptographic Audit Log & Teacher Dashboard Triage

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
รับข้อมูลเหตุการณ์ทั้งหมดจากเอนจินตรวจจับใน **Phase 3a** มาประมวลผลที่ฝั่งเครื่องแม่ บันทึกลงใน **Audit Log แบบ Cryptographic Hash Chain** ที่แก้ไขหรือลบย้อนหลังไม่ได้ คำนวณคะแนนความน่าสงสัยรายบุคคล และแสดงผลบนหน้าจอ **Teacher Dashboard Triage** เพื่อให้ผู้คุมสอบในห้องเห็นทันทีว่าเครื่องไหนขึ้น **สีแดง (วิกฤต)** พร้อมดู Timeline หลักฐานและกดจัดการได้ในคลิกเดียว

### สิ่งที่ต้องได้เมื่อจบ Phase 3b
- ระบบ `AuditLogger` ที่เครื่องแม่บันทึกทุกเหตุการณ์แบบ Append-only Hash Chain ลง SQLite พร้อมตัวตรวจสอบความสมบูรณ์ของสายโซ่ (`verifyAuditChain`)
- ระบบ `TriageEngine` คำนวณคะแนนความน่าสงสัย ถ่วงน้ำหนักตามความรุนแรง จัดกลุ่มความผิดปกติที่ซ้ำกัน และจัดลำดับความสำคัญของนักเรียน (`CRITICAL > WARNING > NORMAL`)
- หน้าจอ **Teacher Dashboard Triage** (ไม่มีผังที่นั่ง) เรียงคนสีแดงไว้บนสุดเสมอ มีตัวกรองด่วน แถบ Timeline หลักฐานรายคน และปุ่มจัดการของผู้คุมสอบ (รับทราบ+บันทึกหมายเหตุ, ส่งข้อความเตือนขึ้นจอ, สั่ง Freeze เครื่อง)
- ระบบส่งออกรายงานสรุปผลและประวัติหลักฐานหลังจบการสอบ

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 3b.1 Append-Only Audit Log with Cryptographic Hash Chain (`src/main/host/audit-log.ts`)
เพื่อให้หลักฐานการตรวจจับทั้งหมดมีความน่าเชื่อถือและตรวจสอบย้อนหลังได้ว่าไม่มีการแก้ไขหรือลบรายการใดออก:

1. **โครงสร้างรายการในตาราง `audit_logs`:**
   ```ts
   interface AuditLogEntry {
     seqNo: number              // ลำดับต่อเนื่องในห้องสอบ (0, 1, 2, ...)
     roomId: string
     studentId: string | 'HOST' // ถ้าระบบหรือผู้คุมกดเองจะบันทึกเป็น 'HOST'
     serverTimestampMs: number  // เวลาจากเครื่องแม่เท่านั้น
     clientTimestampMs?: number
     eventCode: string          // เช่น 'DISGUISED_PROCESS_DETECTED'
     category: string
     severity: 'normal' | 'warning' | 'critical'
     scoreDelta: number         // คะแนนความน่าสงสัยที่เพิ่มขึ้นจากเหตุการณ์นี้
     summaryText: string        // คำอธิบายภาษาคนอ่านเข้าใจง่ายสำหรับแสดงบน Dashboard
     evidenceJson: string       // Canonical JSON ของรายละเอียดหลักฐาน (PID, path, cmdline, domain, ฯลฯ)
     prevHash: string           // SHA-256 hex ของรายการ seqNo - 1
     entryHash: string          // SHA-256 hex ของรายการนี้
     hostHmac: string           // HMAC-SHA256 ด้วย roomAuditSecretKey
   }
   ```
2. **อัลกอริทึมการผูก Hash Chain:**
   - รายการที่ `seqNo = 0` (Genesis Block ตอนเปิดห้องสอบ):
     - `prevHash = "0".repeat(64)`
     - `entryHash = SHA256("ZTEXAM_AUDIT_V1|0|" + roomId + "|" + serverTimestampMs + "|ROOM_CREATED|" + canonicalPolicyJson)`
   - รายการที่ `seqNo = k` (`k >= 1`):
     - ดึง `prevHash = entry[k-1].entryHash`
     - คำนวณ `entryHash = SHA256("ZTEXAM_AUDIT_V1|" + k + "|" + prevHash + "|" + roomId + "|" + studentId + "|" + serverTimestampMs + "|" + eventCode + "|" + severity + "|" + canonicalEvidenceJson)`
     - บันทึกลง SQLite ภายใน Transaction เดียวกันแบบ Synchronous (`better-sqlite3`) เพื่อรับประกันว่าไม่มี Race condition แม้จะมี Event จาก 50 เครื่องวิ่งเข้ามาในมิลลิวินาทีเดียวกัน
3. **การตรวจสอบสายโซ่ (`verifyAuditChain(roomId)`):**
   - อ่านรายการทั้งหมดของ `roomId` เรียงตาม `seqNo ASC`
   - ตรวจว่า `seqNo` เรียงต่อเนื่องกันโดยไม่มีเลขกระโดดหายไป (`0, 1, 2, ..., N`)
   - คำนวณ `entryHash` และ `hostHmac` ซ้ำทุกแถวเทียบกับที่เก็บในฐานข้อมูล
   - คืนค่า `{ valid: boolean, totalEntries: number, firstTamperedSeqNo?: number, reason?: string }`

---

### 3b.2 Triage Scoring, Event Correlation & Anti-Fatigue Engine (`src/main/host/triage-engine.ts`)
หากแจ้งเตือนทุก Event ดิบๆ ผู้คุมสอบจะเกิดอาการล้า (Alert Fatigue) จึงต้องมีระบบคัดกรองและรวมกลุ่มเหตุการณ์:

1. **ระบบรวมกลุ่มเหตุการณ์ซ้ำและจัด Cooldown (`EventCorrelator`):**
   - หากนักเรียนคนเดิมเกิดเหตุการณ์ชนิดเดียวกันและมีคีย์หลักฐานตรงกัน (เช่น `BLACKLISTED_PROCESS_DETECTED` สำหรับ `pid: 8812, exe: "discord.exe"`) ซ้ำภายในช่วงเวลาที่โปรเซสนั้นยังเปิดอยู่:
     - สร้างรายการแจ้งเตือนหลักในครั้งที่ตรวจพบครั้งแรก และอัปเดตตัวนับ `occurrenceCount` กับ `durationSeconds` บนรายการเดิม แทนการบวกคะแนนความน่าสงสัยซ้ำทุก 3 วินาที
   - แต่ถ้าเป็นคนละโปรเซส หรือปิดแล้วเปิดขึ้นมาใหม่ (คนละ `pid`) จะถือเป็นความผิดครั้งใหม่และบวกคะแนนเพิ่มทันที
2. **การคำนวณสถานะ Triage 3 ระดับต่อคน (`StudentTriageState`):**
   - **`unacknowledgedCriticalCount`:** จำนวนเหตุการณ์ระดับ `CRITICAL` ที่ผู้คุมสอบยังไม่ได้กดตรวจสอบ
   - **`activeSuspicionScore`:** คะแนนความน่าสงสัยสะสมปัจจุบัน
   - **กฎการจัดระดับสี:**
     - 🔴 **`CRITICAL` (สีแดง - ต้องตรวจสอบทันที):** เมื่อ `unacknowledgedCriticalCount > 0` หรือ `activeSuspicionScore >= 40`
     - 🟡 **`WARNING` (สีเหลือง - เฝ้าระวัง):** เมื่อ `activeSuspicionScore` อยู่ระหว่าง `15 - 39` หรือมีเหตุการณ์ระดับ `WARNING` ที่ยังไม่ได้กดรับทราบ
     - 🟢 **`NORMAL` (สีเขียว - ปกติ):** เมื่อคะแนน `< 15` และไม่มีเหตุการณ์ค้างตรวจ
3. **การจัดเรียงลำดับบน Dashboard (Priority Queue Sorting):**
   - ลำดับที่ 1: นักเรียนที่มีสถานะ `🔴 CRITICAL` (เรียงตาม `unacknowledgedCriticalCount` มากสุด และ `activeSuspicionScore` สูงสุดขึ้นก่อน)
   - ลำดับที่ 2: นักเรียนที่สถานะ `DISCONNECTED / OFFLINE` ระหว่างกำลังสอบ
   - ลำดับที่ 3: นักเรียนที่มีสถานะ `🟡 WARNING` (เรียงตามคะแนนความน่าสงสัยสูงสุดขึ้นก่อน)
   - ลำดับที่ 4: นักเรียนที่มีสถานะ `🟢 NORMAL` (เรียงตามรหัสนักเรียน)

---

### 3b.3 Teacher Dashboard UI & Proctor Workflow (`src/renderer/src/host/dashboard/`)
ออกแบบตามข้อกำหนด: **ไม่มีผังที่นั่ง** แต่เน้นรายชื่อและการ์ดสถานะที่ชัดเจน ค้นหาและคลิกตรวจสอบได้ทันที:

1. **แถบสรุปสถานะด้านบนสุด (`TriageSummaryHeader.tsx`):**
   - แสดงปุ่มตัวกรองด่วนพร้อมตัวเลขแบบ Real-time:
     - `[ ทั้งหมด (45) ]`
     - `[ 🔴 วิกฤต - ต้องตรวจทันที (2) ]`
     - `[ 🟡 เฝ้าระวัง (5) ]`
     - `[ ⚪ ขาดการติดต่อ (0) ]`
     - `[ 🟢 ปกติ (38) ]`
   - ช่องค้นหาด่วน (พิมพ์รหัสนักเรียนหรือชื่อ) และปุ่มเปิด/ปิดเสียงเตือนสำหรับเหตุการณ์ระดับวิกฤต
2. **การ์ดสถานะนักเรียน (`StudentTriageCard.tsx`):**
   - แสดงรหัสนักเรียน, ชื่อ-นามสกุล, สถานะสี (เขียว/เหลือง/แดง), คะแนนความน่าสงสัย (`Score: 70`), และความคืบหน้าการทำข้อสอบ (`ข้อที่ 12 / 30`)
   - หากมีเหตุการณ์ผิดปกติ จะแสดงป้ายสรุปเหตุการณ์ล่าสุดที่อ่านเข้าใจได้ทันทีบนการ์ด เช่น:
     - `🚨 เปลี่ยนชื่อไฟล์แอบรัน: Cheat Engine.exe (ในชื่อ wordpad.exe) • 8 วินาทีที่แล้ว`
     - `🚨 พยายามค้นหาโดเมน: api.openai.com • 25 วินาทีที่แล้ว`
     - `⚠️ หน้าจอเสียโฟกัส 4.2 วินาที • 1 นาทีที่แล้ว`
   - มีปุ่มลัดบนการ์ด: `[ 👁️ ดูหน้าจอ ]` (เชื่อมกับ Phase 3c), `[ 📋 ดูหลักฐาน ]`, และ `[ ❄️ Freeze ]`
3. **หน้าต่างตรวจสอบหลักฐานและบันทึกการตรวจ (`EvidenceTimelineDrawer.tsx`):**
   - เมื่อคลิกที่นักเรียนคนใด จะเปิดแผงด้านข้างแสดง:
     - **ข้อมูลเครื่อง:** OS, IP Address, สถานะ VM/Remote, สถานะ Attestation, จำนวนหน้าจอที่ต่ออยู่
     - **Timeline เหตุการณ์ทั้งหมดของนักเรียนคนนั้น:** เรียงจากล่าสุดลงไป พร้อมปุ่มขยายดูข้อมูลทางเทคนิค (`PID`, `CommandLine`, `SHA-256`, `Remote IP:Port`)
     - **แผงบันทึกการตรวจสอบของผู้คุมสอบ (Proctor Resolution Panel):**
       - ตัวเลือกผลการตรวจ:
         1. `ตักเตือนแล้ว / เข้าใจผิด (Clear Active Alert & Keep Log)` -> เคลียร์สถานะไฟกระพริบสีแดงของเหตุการณ์ที่ตรวจแล้ว เพื่อให้ผู้คุมโฟกัสกับเหตุการณ์ใหม่ที่จะเกิดขึ้นต่อไปได้
         2. `ยืนยันพบการทุจริต (Mark as Confirmed Violation)` -> ปักหมุดเป็นหลักฐานสำคัญสำหรับรายงานผลหลังสอบ
       - ช่องกรอกหมายเหตุของผู้คุม (เช่น *"เดินไปตรวจที่เครื่อง พบเปิดสคริปต์ Python ต่อ API ข้างนอกจริง ให้หยุดทำข้อสอบแล้ว"*)
       - ทุกการกดของผู้คุมจะถูกบันทึกลงใน `AuditLog` Hash Chain ด้วยรหัส `PROCTOR_ACKNOWLEDGED_ALERT` หรือ `PROCTOR_FROZE_STUDENT`

---

### 3b.4 Post-Exam Integrity & Incident Report Exporter (`src/main/host/report-exporter.ts`)
- สร้างรายงานหลังจบการสอบในรูปแบบ:
  1. **HTML/PDF Incident Report (สำหรับพิมพ์หรือแนบเป็นหลักฐานทางวิชาการ):**
     - แสดงข้อมูลห้องสอบ, ผลการตรวจ `Audit Hash Chain Integrity (Verified ✅)`, สรุปรายชื่อผู้เข้าสอบที่มีเหตุการณ์ผิดปกติ, Timeline หลักฐานรายบุคคล และหมายเหตุที่ผู้คุมสอบบันทึกไว้ในห้องสอบ
  2. **Signed JSON Audit Bundle (`.ztaudit`):**
     - ไฟล์ข้อมูลดิบของ Audit Log ทั้งหมดพร้อม Hash Chain สำหรับใช้อัปโหลดหรือตรวจสอบความถูกต้องในภายหลัง

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [ ] **3b.1.1** สร้าง `AuditLogger` ที่คำนวณ `entryHash` และ `hostHmac` ต่อเนื่องจากรายการก่อนหน้าใน SQLite Transaction
- [ ] **3b.1.2** สร้างฟังก์ชัน `verifyAuditChain(roomId)` ตรวจสอบความสมบูรณ์ของสายโซ่ตั้งแต่ Genesis จนถึงรายการสุดท้าย
- [ ] **3b.2.1** สร้าง `EventCorrelator` และ `TriageEngine` สำหรับรวมเหตุการณ์ซ้ำ คำนวณคะแนนความน่าสงสัย และจัดลำดับนักเรียน
- [ ] **3b.3.1** สร้าง `TriageSummaryHeader.tsx` และ `StudentTriageCard.tsx` ที่ดันการ์ดสีแดงขึ้นบนสุดเสมอโดยไม่มีผังที่นั่ง
- [ ] **3b.3.2** สร้าง `EvidenceTimelineDrawer.tsx` แสดงรายละเอียดหลักฐานทางเทคนิคและฟอร์มบันทึกผลการเดินตรวจของผู้คุมสอบ
- [ ] **3b.3.3** สร้างฟีเจอร์ส่งข้อความเตือนขึ้นจอนักเรียน (`PROCTOR_WARNING_MESSAGE`) และปุ่มสั่ง `Freeze / Unfreeze` รายเครื่อง
- [ ] **3b.4.1** สร้าง `ReportExporter` ส่งออกรายงานสรุปเหตุการณ์และผลการตรวจสอบ Hash Chain หลังจบการสอบ

---

## 4. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **Hash Chain Tamper Detection Test:** สร้างรายการ Audit Log 100 รายการ -> ตรวจสอบว่า `verifyAuditChain` คืนค่า `valid: true` -> ลองแก้ไข `evidenceJson` หรือ `serverTimestampMs` ในฐานข้อมูลแม้แต่ 1 ตัวอักษร -> `verifyAuditChain` ต้องคืนค่า `valid: false` พร้อมระบุเลข `firstTamperedSeqNo` ได้ตรงจุด
   - **Triage Priority Ordering Test:** จำลองนักเรียน 20 คนที่มีคะแนนและสถานะต่างกัน -> ตรวจสอบว่ารายการที่ส่งไปแสดงผลเรียงลำดับ `CRITICAL` ไว้บนสุดเสมอ และเมื่อผู้คุมกด `Acknowledge` แล้ว สถานะจะอัปเดตอย่างถูกต้องโดยที่ประวัติใน Audit Log ยังอยู่ครบ
2. **Manual Verification:**
   - จำลองการส่งเหตุการณ์ `DISGUISED_PROCESS_DETECTED` และ `FORBIDDEN_DNS_QUERY_DETECTED` จากเครื่องนักเรียน -> การ์ดของนักเรียนบนหน้าจอครูต้องเปลี่ยนเป็นสีแดง เด้งขึ้นอันดับ 1 พร้อมแสดงข้อความสรุปเหตุผลชัดเจน
   - ผู้คุมคลิกเปิดดู Timeline -> กดบันทึกหมายเหตุการตรวจและกดสั่ง Freeze เครื่องนักเรียน -> หน้าจอเครื่องนักเรียนถูกแช่แข็งทันที และมีรายการบันทึกของผู้คุมปรากฏใน Timeline


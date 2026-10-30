# รายงานทดสอบ — Host Room Lifecycle (โหมด Closed)

- วันที่ทดสอบ: 20251031
- ผู้ทดสอบ: Tester Agent #1 (บทบาทครู / Host)
- ขอบเขต flow ที่ทดสอบ: เปิดแอป → เลือก role host → กรอกชื่อห้อง/เลือกโหมด Closed/เลือก enforcement → กดเปิดห้อง → ดู Room PIN / Room ID / TLS port / fingerprint + ปุ่ม copy → รอนักเรียน join (รายชื่อ/สถานะออนไลน์) → เลือกไฟล์ข้อสอบ JSON → กดเริ่มสอบ (ปุ่ม disabled เมื่อไม่มีคนออนไลน์) → ดู progress summaries → กดจบการสอบ → ปิดห้อง
- วิธีทดสอบ: อ่านโค้ดอย่างเดียว (static review, ไม่ได้รันแอป) ไฟล์หลัก:
  - `src/renderer/src/components/HostShell.tsx`
  - `src/renderer/src/components/HostPanel.tsx`
  - `src/renderer/src/components/RoleSelector.tsx`
  - `src/renderer/src/store/network-store.ts`, `src/renderer/src/store/app-store.ts`
  - `src/main/ipc/network-handlers.ts`, `src/main/ipc/exam-handlers.ts`
  - `src/main/network/host-room.ts`, `src/main/host/core-session-manager.ts` (start/endExam)

## สรุปผล

- จำนวน TC ทั้งหมด: 16
- PASS: 9
- FAIL (มีบั๊ก/ยืนยันข้อบกพร่องจากโค้ด): 0 (เป็นการอ่านโค้ด ไม่ได้รันจริง — แต่พบข้อสังเกตระดับ Major/Minor 7 ข้อ)
- ข้อสังเกต UX/ความเสี่ยง (Issue): 7 ข้อ — I-01 ถึง I-07 ดูตารางและหัวข้อสรุป

> หมายเหตุ: ไม่มี FAIL แบบฟันธงว่าแอปรันแล้วพัง เพราะไม่ได้รันจริง แต่มีเงื่อนไขที่ควรแก้ก่อนใช้งานจริงหลายจุด (กันเผลอกดจบ/ปิดห้อง, reload แล้ว state หาย, copy PIN ไม่ได้, hint หายบางเคส)

## ตาราง Testcases

| รหัส TC | ขั้นตอน | ข้อมูล | ผลคาดหวัง | ผลที่พบจากการอ่านโค้ด (pass/fail/ข้อสังเกต) | ระดับความรุนแรง |
|---|---|---|---|---|---|
| TC-H01 | เปิดแอป → จอเลือก role → กดการ์ด "เครื่องแม่" | role=host | role เปลี่ยนเป็น host, เห็น HostShell + ข้อความ "กำลังเตรียมฐานข้อมูลของเครื่องแม่…" | PASS — `RoleSelector.tsx:8-19` เรียก `selectRole({role:'host'})` แล้ว `setRole` + notify info ถูกต้อง มีรองรับ `--role=host` flag | — |
| TC-H02 | หน้า "เปิดห้องสอบ": ปล่อยชื่อห้องว่างแล้วดูปุ่ม | roomName="" / ช่องว่าง | ปุ่มเปิดห้องต้องกดไม่ได้ | PASS — `HostPanel.tsx:308` `disabled={creating \|\| roomName.trim().length===0}` กันค่าว่าง/ช่องว่างฝั่ง UI ได้ | — |
| TC-H03 | กรอกชื่อห้อง + เลือกโหมด Closed + enforcement report-only → กด "เปิดห้องสอบ" | roomName="ห้องสอบ 401" (default), mode=closed, enforcement=report-only | เปิดห้องสำเร็จ, แสดง notify "เปิดห้อง … สำเร็จ", เห็น PIN/ID/port/fingerprint | PASS — `HostPanel.tsx:226-242` เรียก `createRoom`, `host-room.ts:92-166` สร้าง cert+PIN+TLS+beacon+broadcast+insert exam_sessions ครบ | — |
| TC-H04 | เปิดห้องซ้ำ / กดปุ่มย้ำตอนกำลังสร้าง | กดปุ่ม 2 ครั้งติด | ต้องไม่เปิดห้องซ้อน, ปุ่มล็อกตอนกำลังสร้าง | PASS (UI) — `creating` state ล็อกปุ่ม + ข้อความ "กำลังสร้างคีย์ + เปิด TLS…" (`HostPanel.tsx:306-313`); main กันซ้ำด้วย `ROOM_ALREADY_OPEN` (`host-room.ts:93-95`) | — |
| TC-H05 | ตรวจการ์ดห้อง: Room PIN ตัวใหญ่ + Room ID + TLS port / fingerprint ย่อ + ปุ่ม copy | ห้องที่เปิดแล้ว | PIN อ่านง่ายบนจอหน้าห้อง, copy ID/fingerprint ได้, มี feedback ✓ | PASS แบบมีข้อสังเกต — PIN `text-6xl tracking-[0.3em]` อ่านง่าย (`HostPanel.tsx:343-345`); copy มี feedback ✓ 1.5s (`HostPanel.tsx:251-255`) แต่ดู I-01/I-02 | Minor (I-01, I-02) |
| TC-H06 | รอนักเรียน join: ดูรายชื่อ + จำนวนออนไลน์ + สถานะ focus | student join 1-2 คน | รายชื่ออัปเดต realtime, ตัวนับ "นักเรียน (N ออนไลน์)" ตรง, ข้อความตอนว่างชัดเจน | PASS — subscribe `host:students-updated` (`HostPanel.tsx:94-96`), แยกสี focused/เสียโฟกัส/ออฟไลน์ (`HostPanel.tsx:637-670`), ข้อความว่าง "ยังไม่มีใครเข้าห้อง — …LAN เดียวกันจะเห็นห้องนี้อัตโนมัติ" | — |
| TC-H07 | ยังไม่มีคนออนไลน์ + ยังไม่โหลดข้อสอบ → ตรวจโซนเริ่มสอบ | students=[] , loadedExam=null | มีคำแนะนำว่าต้องทำอะไรต่อ | PASS แบบมีข้อสังเกต — มี hint "ดูนักเรียนในห้องก่อน แล้วเลือกไฟล์ข้อสอบเพื่อเริ่ม" (`HostPanel.tsx:424-426`) แต่ดู I-03 (hint หายเมื่อมีนักเรียนแต่ยังไม่โหลดข้อสอบ) | Minor (I-03) |
| TC-H08 | กด "เลือกไฟล์ข้อสอบ (JSON)" → เลือกไฟล์ถูก / ไฟล์ผิด / กดยกเลิก | ไฟล์ .json/.ztexam ถูก schema, ไฟล์ผิด, cancel | ไฟล์ถูก: แสดง title+จำนวนข้อ + notify; ไฟล์ผิด: warning พร้อมชื่อไฟล์+เหตุผล; ยกเลิก: ไม่ค้าง loading | PASS — `selectExamFile` try/finally ปลด `picking` (`HostPanel.tsx:142-155`); main ตรวจ schema + ชื่อไฟล์ + ตัด error 120 ตัวอักษร (`exam-handlers.ts:53-82`) แต่ยกเลิกก็ขึ้น warning "ยกเลิกการเลือกไฟล์" ควรเป็น info/เงียบ (I-04) | Trivial (I-04) |
| TC-H09 | โหลดข้อสอบแล้วแต่ไม่มีคนออนไลน์ → ปุ่ม "เริ่มการสอบ" | loadedExam!=null, onlineStudents=0 | ปุ่มต้อง disabled (กันเริ่มห้องเปล่า) | PASS (UI) — `disabled={starting \|\| onlineStudents.length===0}` (`HostPanel.tsx:415`) แต่ main `startExam` ไม่เช็กจำนวนนักเรียน (เช็กแค่ EXAM_NOT_LOADED/ROOM_NOT_OPEN ใน `core-session-manager.ts:151-158`) → เรียก IPC ตรงยังเริ่มห้องเปล่าได้ (I-05) | Major (I-05, defense-in-depth) |
| TC-H10 | มีคนออนไลน์ + โหลดข้อสอบแล้ว → กด "เริ่มการสอบ" | online>=1, exam loaded | เริ่มสอบ, badge "กำลังสอบ", นักเรียนได้ข้อแรก, นาฬิกากลางเดิน | PASS — `startExam` await IPC แล้ว set running + notify (`HostPanel.tsx:157-171`); main ส่ง examStarted+questionPayload ทุกคน + policy + timer 500ms (`core-session-manager.ts:213-241`) | — |
| TC-H11 | ระหว่างสอบ: ดู progress summaries รายคน | นักเรียนส่งคำตอบ 1 ข้อ | เห็น `maxReachedCursor/total · awardedPoints` + progress bar อัปเดต | PASS — `host:exam-summaries` → setSummaries (`HostPanel.tsx:103-105`); main `pushSummaries()` ทุกครั้งหลัง submit (`core-session-manager.ts:602`) และตอนจบ (`:311`) | — (มี I-06 เรื่องข้อความกำกับ) |
| TC-H12 | กด "จบการสอบ (เก็บทั้งห้อง)" ระหว่าง running | examState=running | เปลี่ยนเป็น collecting → finished, notify "หมดเวลา/จบโดยครู", นักเรียนได้ examCompleted | PASS แบบมีข้อสังเกต — `endExam` เรียก IPC + notify (`HostPanel.tsx:173-180`); main collecting → grace 3s → finalize + timeUp/examCompleted ทุกคน (`core-session-manager.ts:263-312`) แต่ไม่มี confirm และกดซ้ำได้ตอน collecting (I-07) | Major (I-07) |
| TC-H13 | หลังจบ: ตรวจ badge + Triage/export | examState=finished | badge "จบแล้ว", Triage `canExport=true` | PASS — badge finished (`HostPanel.tsx:390-394`), `TriageDashboard canExport={examState==='finished'}` (`HostPanel.tsx:588`) | — |
| TC-H14 | กด "ปิดห้อง" (header การ์ดห้อง) | ห้องเปิดอยู่ (idle/running/finished) | ปิด beacon+TLS, ล้าง room+students, notify "ปิดห้องสอบแล้ว", update DB ended | PASS แบบมีข้อสังเกต — `closeRoom` ล้าง store + notify (`HostPanel.tsx:244-249`); main stop broadcaster/TLS + update exam_sessions ended (`host-room.ts:168-181`) แต่ไม่มี confirm และปิดตอนกำลังสอบได้ (I-07) | Major (I-07) |
| TC-H15 | Reload หน้า Host ตอนเปิดห้อง/โหลดข้อสอบแล้ว | reload mid-lifecycle | ควรกลับมาสภาพเดิม (ห้อง+ข้อสอบ+รายชื่อ+examState) | ข้อสังเกต — กู้แค่ `getRoom` (`HostPanel.tsx:93`) ไม่กู้ examState/loadedExam/summaries/students → หลัง reload ห้องยังอยู่แต่ปุ่ม/สถานะรีเซ็ตเป็น idle อาจเผลอเริ่มสอบซ้ำ | Major (state restore) |
| TC-H16 | สังเกต header connectionState + ข้อความกำกับ summaries | ดู HostShell header | สถานะตรงความจริง, ภาษาถูกต้อง | ข้อสังเกต — header แสดง `connectionState` จาก app-store แต่ฝั่ง host ไม่เห็นที่ set เป็น connected (default offline) อาจค้าง "offline" ทั้งที่ห้องเปิดอยู่; ป้าย summaries มีข้อความเพี้ยน "ข้อจัดตั้งให้ข้อมือตรวจหลังสอบ" (`HostPanel.tsx:443`) ควรแก้เป็น "อัตโนมัติเฉพาะปรนัย/เติมคำสั้น — อัตนัยรอครูตรวจ" | Minor |

## สิ่งที่ดี (Strengths)

1. แยก UI ชัด: `HostShell` เป็น tabs (ห้องสอบ/Dynamic Form/Code IDE) ส่วน `HostPanel` ดูแล room lifecycle อย่างเดียว อ่านง่าย
2. กันปุ่มซ้ำดี: `creating/starting/picking` state ล็อกปุ่ม + เปลี่ยน label ("กำลังสร้างคีย์…/กำลังเริ่ม…/กำลังอ่านไฟล์…")
3. ป้องกันชื่อห้องว่างฝั่ง UI ด้วย `trim()` และ `maxLength={80}` เหมาะกับจอโปรเจกเตอร์
4. PIN ตัวใหญ่อ่านง่าย (`text-6xl tracking-[0.3em]`) พร้อมป้าย "ขึ้นบนจอหน้าห้องสอบ"
5. Copy มี feedback ✓ 1.5 วินาที เข้าใจง่าย
6. รายชื่อนักเรียน realtime แยกสี focused/เสียโฟกัส/ออฟไลน์ + ไอคอน Wifi/WifiOff + empty state อธิบาย LAN discovery ชัด
7. Error ไฟล์ข้อสอบบอกชื่อไฟล์ + เหตุผลย่อ + ตัด 120 ตัวอักษร ไม่ล้นจอ
8. Main กันห้องซ้อน (`ROOM_ALREADY_OPEN`) + ตรวจ role (`HOST_ROLE_REQUIRED`) + ตรวจ schema ข้อสอบก่อน load
9. เริ่มสอบส่ง policy/question แรก/timer กลาง + grace period เก็บ draft ครบวงจร

## ปัญหา/ความเสี่ยง UX ที่เจอ (Issues)

- I-01 (Minor): PIN ไม่มีปุ่ม copy — มี copy แค่ Room ID กับ fingerprint ทั้งที่ครูต้องแจก PIN บ่อยสุด ต้องพิมพ์เองเสี่ยงผิด แนะนำเพิ่มปุ่ม copy PIN (หรือ "คัดลอกข้อมูลเข้าห้องทั้งหมด")
- I-02 (Minor): ปุ่ม copy ตรง "TLS port / Cert fingerprint (ย่อ)" คัดลอกแค่ `certFingerprint` เต็ม ไม่รวม port (`HostPanel.tsx:370`) ป้ายกำกวม แนะนำแยกปุ่ม "copy port" / "copy fingerprint เต็ม" หรือเปลี่ยน label ให้ตรง
- I-03 (Minor): hint เริ่มสอบแสดงเฉพาะ `!loadedExam && onlineStudents.length===0` ถ้ามีนักเรียนแล้วแต่ยังไม่โหลดข้อสอบ hint หาย เหลือแค่ปุ่มเลือกไฟล์ ครูใหม่งง แนะนำ hint 2 สถานะ (ขาดนักเรียน/ขาดข้อสอบ)
- I-04 (Trivial): ยกเลิก dialog เลือกไฟล์ขึ้น notify warning "ยกเลิกการเลือกไฟล์" ควรเป็น info หรือเงียบ
- I-05 (Major): ปุ่มเริ่มสอบกันห้องว่างแค่ฝั่ง UI แต่ `core-session-manager.startExam()` ไม่เช็กจำนวนนักเรียนออนไลน์ เริ่มห้องเปล่าได้ถ้าเรียก IPC ตรง แนะนำเช็กฝั่ง main ด้วย (หรือยืนยันเจตนาชัดเจนถ้าอนุญาตห้องเปล่า)
- I-06 (Minor): ป้าย summaries เพี้ยน: "ความคืบหน้ารายคน (สามารถดูระบบให้คะแนนโดยอัตโนมัติ — ข้อจัดตั้งให้ข้อมือตรวจหลังสอบ)" (`HostPanel.tsx:443`) อ่านไม่รู้เรื่อง แนะนำแก้ตาม TC-H16
- I-07 (Major): "จบการสอบ" และ "ปิดห้อง" ไม่มี confirm dialog ใดๆ (`endExam`/`closeRoom` ใน `HostPanel.tsx:173-180,244-249`) ปิดห้องตอนกำลังสอบได้เลย เสี่ยงเผลอคลิกแล้วเก็บทั้งห้อง/ตัดการเชื่อมต่อ แนะนำ modal ยืนยัน + disable ตอน `collecting` + แสดงคำเตือนถ้า examState=running
- เพิ่มเติม (Major): reload แล้วกู้แค่ room ไม่กู้ examState/exam/summaries (TC-H15) เสี่ยงเริ่มสอบซ้ำ; header `connectionState` ฝั่ง host อาจค้าง offline (TC-H16)

## ข้อเสนอแนะ (เรียงตามความสำคัญ)

1. เพิ่ม confirm ก่อน `endExam`/`closeRoom` + บล็อก `closeRoom` ตอน running (หรือเตือนแรงๆ) — กันอุบัติเหตุหน้างานจริง
2. ทำ state restore หลัง reload: `getExamHostState`/examInfo/summaries/students ให้ครบ หรืออย่างน้อยเตือนว่า "ห้องยังเปิดอยู่ กำลังสอบ"
3. เพิ่ม copy PIN + แก้ label copy port/fingerprint ให้ตรงสิ่งที่คัดลอก
4. แก้ hint เริ่มสอบให้ครอบคลุม 2 เคส + แก้ข้อความ summaries ที่เพี้ยน + ลดเสียง cancel dialog
5. เพิ่ม validation จำนวนนักเรียนฝั่ง main (หรือกำหนดนโยบายชัดว่าห้าม/อนุญาตเริ่มห้องเปล่า) + แปล error code (`EXAM_NOT_LOADED` ฯลฯ) เป็นภาษาครู
6. จัดการ `clipboard.writeText` ล้มเหลว (เช่น permission) ด้วย try/catch + notify
7. ตรวจ `connectionState` ฝั่ง host ว่าควรแสดงอะไร (เช่น จำนวน beacon/TLS แทน offline)

---
*ท้ายไฟล์: รายงานนี้สร้างจากการอ่านโค้ดเท่านั้น ยังไม่ได้รันแอปจริง ควรทำ dynamic test ซ้ำ (เปิดห้องจริง + join นักเรียนจริง 2 เครื่อง) ก่อนสรุป severity สุดท้าย*

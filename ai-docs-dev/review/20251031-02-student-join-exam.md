# รายงานทดสอบ — ฝั่งนักเรียน (Student Join → Exam Happy Path)

- วันที่ทดสอบ: 20251031
- ผู้ทดสอบ: Tester Agent #2 (บทบาทนักเรียน)
- โค้ดเบส: `E:\lan-exam-system`
- วิธีทดสอบ: อ่านโค้ดอย่างเดียว (static review, ไม่ได้รันแอปจริง) — สถานะด้านล่างคือ "ผลจากการอ่านโค้ด" ไม่ใช่ผลรันจริง
- ไฟล์ที่ไล่:
  - `src/renderer/src/components/StudentShell.tsx`
  - `src/renderer/src/components/StudentPanel.tsx`
  - `src/renderer/src/core-student/ExamView.tsx`
  - `src/renderer/src/core-student/QuestionRenderer.tsx`
  - `src/renderer/src/core-student/HudBar.tsx`
  - `src/renderer/src/core-student/WatermarkOverlay.tsx`
  - `src/renderer/src/core-student/ProctorOverlay.tsx`
  - `src/renderer/src/core-student/FloatingHud.tsx`
  - `src/renderer/src/store/exam-store.ts`
  - `src/renderer/src/store/network-store.ts`

## 1. UX Flow ฝั่งนักเรียน (Happy Path จากโค้ด)

1. เปิดแอป role student → `StudentShell` แสดง header "นักเรียน — เข้าห้องสอบ / Room Browser + PIN verification" + badge `connectionState` (จาก `app-store`) → `<StudentPanel />` ใน `main`
2. `StudentPanel` mount → `window.ztExam.startDiscovery()` + subscribe `network:rooms-updated` → `network-store.rooms`, `network:connection-state` → `connection`, `screen:session` / `screen:inspect` (สั่ง screen worker) — unmount หยุด worker + `stopDiscovery()`
3. ดูรายการห้อง LAN: การ์ด "ห้องสอบในวง LAN (N)" + ป้าย "UDP discovery ทุก 2 วิ" (ป้ายนิ่งใน UI) — ห้องว่างโชว์ "ยังไม่พบห้องสอบ — ให้ครูเปิดห้องก่อน หรือกรอก IP เองด้านล่าง" — มีห้องโชว์ `roomName`, `timeSince(lastSeenAtMs)`, `sourceIp:tcpPort · hostName · นักเรียน N คน`, `cert …`
4. เลือกห้อง (คลิก → `selected`, เติม `manualRoomId`) หรือ fallback "กรอก IP เครื่องแม่ด้วยตนเอง" (`manualHost` รูปแบบ `IP:Port` + `Room ID`)
5. กรอก รหัสนักเรียน / ชื่อ-นามสกุล / Room PIN 6 หลัก (input กรองเหลือแต่ตัวเลข, `maxLength={6}`, `inputMode numeric`) → กด "เข้าห้องสอบ" → validate ฝั่ง client ก่อนยิง `joinRoom`
6. สำเร็จ (`result.ok`) → `exam-store.identity` + `phase='waiting'` + notify "เข้าห้องสอบสำเร็จ — รอครูเริ่มข้อสอบ" → `StudentExamLayers` แสดง waiting fullscreen (z-30, ไอคอน Lock) + `ExamView` (return null ตอน waiting) + `ProctorOverlay` ทำงานตลอด
7. ครูเริ่มสอบ → event `exam:started` → `onExamStarted` (`phase='active'`, set `examTitle/remainingSeconds/examMode`, เคลียร์ question/draft/counters) → `ExamView` effect `enterKiosk()` → รับ `exam:question` ทีละข้อ → `onQuestion` (`question`, `draft=null`) → `QuestionRenderer`
8. ทำข้อสอบ: การ์ดโจทย์ (`select-none`, block copy/cut/paste/drag), ป้าย "ข้อที่ N · P คะแนน · แก้กลับได้/ส่งแล้วไปข้อถัดไป", ตัวนับ "ตอบแล้ว answered+1 / questionCount", ปุ่ม A−/A+ (`fontScale` 0.8–1.6), MCQ / short-answer / essay → ตอบ → autosave (debounce 5 วิเมื่อมีการเปลี่ยน) → `autosaveDraft` + `onLocalDraftSaved` → HUD โชว์ "บันทึกอัตโนมัติ …" → กด "ยืนยันคำตอบและไปข้อถัดไป" (ถ้า `allowBackNavigation=false` มี modal "ไปข้อนี้แล้วแก้ไม่ได้" ก่อน) / ปุ่ม "ย้อนกลับ" (`navigate(cursorIndex-1)`, disable เมื่อข้อแรกหรือไม่อนุญาตย้อน)
9. ระหว่างสอบ: `HudBar` (ชื่อวิชา, ข้อที่ x/y, ปุ่มเปิด/ปิดเอกสารเฉพาะ `examMode==='in-app-docs'`, สถานะ autosave, badge เชื่อมต่อ, นาฬิกานับถอยหลังเปลี่ยนสี ≤300s ส้ม / ≤60s แดง) + `WatermarkOverlay` (canvas ลายน้ำทแยง `studentId • name • device • เวลา`, opacity 0.10, `pointer-events-none`, z-9999, ขยับทุก 30 วิ) + split view ตาม mode (`code-ide` / `dynamic-form` / `in-app-docs` ครึ่งจอ + `DocsPanel` / ปกติเต็มจอ) + `ModuleAckBanner` (10 วิ)
10. หลุดเชื่อมต่อ → `connection.state` `frozen/reconnecting` → overlay บังทั้งจอ (list หน้า join: z-40 "ขาดการติดต่อ…กำลังเชื่อมต่อใหม่อัตโนมัติ…ห้ามปิดแอป"; หน้า exam: ซ่อนโจทย์ + ข้อความ "กู้คืนข้อเดิมพร้อมคำตอบที่พิมพ์ค้างไว้") + `exam:recovery` กู้ `question/draft/cursorIndex` กลับมา
11. ทำครบ/หมดเวลา/ครูสั่งจบ: `exam:completed` → `phase='completed'` + `finishReason` + reset docs → หน้า completed fullscreen (ไอคอน check, ข้อความแยก time-up/ทำครบ/จบตามคำสั่งครู, "โปรดแจ้งครูก่อนออกจากเครื่อง") / `exam:time-up` → `phase='timeup'` → หน้าจอ "หมดเวลาสอบ — กำลังบันทึกคำตอบล่าสุด" + auto-submit ข้อปัจจุบัน + `flushModuleDrafts()` ยิง draft module ค้างขึ้น host ครั้งสุดท้าย

## 2. Testcases (อ่านโค้ด)

| รหัส | ขั้นตอน | ข้อมูล | ผลคาดหวัง | ผลจากการอ่านโค้ด | สถานะ |
|---|---|---|---|---|---|
| TC-S01 | เปิดแอป role student ดู header | — | เห็นหัว "นักเรียน — เข้าห้องสอบ" + สถานะเชื่อมต่อถูกต้อง | `StudentShell.tsx:9-22` มี header ครบ แต่ไอคอน `WifiOff` (สี amber) แสดงค้างทุก state ไม่สลับเป็น `Wifi` ตอน connected | เสี่ยง |
| TC-S02 | ไม่มีห้องใน LAN | rooms=[] | ข้อความแนะนำให้ครูเปิดห้อง / กรอก IP เอง | `StudentPanel.tsx:171-174` ตรงตามคาด | ผ่าน |
| TC-S03 | มีห้อง + เลือกห้อง | rooms 1 ห้อง | การ์ดแสดงชื่อ, เวลา seen, ip:port, host, จำนวน นร., cert; คลิกแล้ว highlight | `StudentPanel.tsx:176-208` + `timeSince()` ตรง; `certFpShort` ตัด `…` ต่อท้ายแม้เป็น short อยู่แล้ว; เวลาแสดงได้แค่ s/m | ผ่าน |
| TC-S04 | เปิด fallback กรอกเอง | ยังไม่เลือกห้อง → กด "+ กรอก IP…" | เห็นช่อง `IP:Port` + `Room ID` (grid 2 คอลัมน์) | `StudentPanel.tsx:220-245` ตรง; ช่องโผล่เฉพาะ `manualOpen && !selected` (ถ้าเผลอเลือกห้องแล้วจะซ่อนช่อง manual) | ผ่าน |
| TC-S05 | PIN ไม่ครบ 6 หลักแล้วกดเข้า | pin=`123` | บล็อก + แจ้ง "กรอก PIN 6 หลัก" | `join():81-84` ตรวจ `/^\d{6}$/` ก่อนยิง IPC ตรง | ผ่าน |
| TC-S06 | เว้นว่างรหัส/ชื่อ | id หรือ name ว่าง/space ล้วน | บล็อก + แจ้ง "กรอกรหัสและชื่อนักเรียน" | `join():85-88` ใช้ `.trim().length===0` ตรง | ผ่าน |
| TC-S07 | ไม่เลือกห้อง + ไม่เปิด manual แล้วกดเข้า | — | แจ้ง "เลือกห้องก่อน หรือกรอก IP เครื่องแม่" | `StudentPanel.tsx:297-299` ตรง | ผ่าน |
| TC-S08 | manual รูปแบบผิด | host=`192.168.1.10` (ไม่มี port) / roomId ว่าง | แจ้ง "รูปแบบ IP:Port หรือ Room ID ไม่ถูกต้อง" | `StudentPanel.tsx:291-296` regex `/^(.+):(\d+)$/` ตรง; แต่ไม่ `.trim()` host, ไม่รองรับ IPv6, port ไม่เช็ค range | เสี่ยง |
| TC-S09 | join สำเร็จ | ห้องจริง + pin ถูก + id/name ครบ | `phase='waiting'` + notify "เข้าห้องสอบสำเร็จ — รอครูเริ่มข้อสอบ" + ปุ่ม loading "กำลังตรวจ PIN + fingerprint…" | `join():100-108` + `joining` state ตรง | ผ่าน |
| TC-S10 | join ล้มเหลว (PIN ผิด/ห้องเต็ม/ถูก reject) | pin ผิด | `joinError` แสดงแถบแดงใต้ฟอร์ม / banner `rejected` | `join():109-114` set `result.reason ?? 'เข้าห้องไม่สำเร็จ'` ตรง; banner `rejected/closed/connecting/frozen` (`119-135`) ครบ | ผ่าน |
| TC-S11 | หน้า waiting รอครู | join สำเร็จ | fullscreen "เชื่อมต่อเครื่องแม่สำเร็จ / รอครูกดเริ่มการสอบ…" + `ExamView` ยังไม่โชว์โจทย์ | `StudentExamLayers:318-328` ตรง (`waiting` overlay z-30 + `<ExamView/>` return null ตอน waiting ตาม `ExamView:211`) | ผ่าน |
| TC-S12 | ครูกดเริ่มสอบ | `exam:started` | เข้า `phase='active'` + `enterKiosk()` + title/เวลา/mode ตั้งต้น | `exam-store:71-83` + `ExamView:180-184` ตรง; ไม่พบ `exitKiosk` ในไฟล์ที่รีวิว (ค้าง kiosk แม้สอบจบ) | เสี่ยง |
| TC-S13 | รับข้อสอบทีละข้อ | `exam:question` | โจทย์ + choices/ช่องพิมพ์ + "ข้อที่ i+1", points, ป้าย allowBack | `exam-store:84-90` + `QuestionRenderer:141-217` ตรง | ผ่าน |
| TC-S14 | ส่งคำตอบ (allowBack true/false) | MCQ เลือกข้อ B / essay พิมพ์ | allowBack=false → modal "ไปข้อนี้แล้วแก้ไม่ได้" + ยืนยัน/ยกเลิก; allowBack=true → ส่งตรง; ปุ่ม disable จนกว่าจะเลือก/พิมพ์ (MCQ เท่านั้น) | `QuestionRenderer:229-272` + `confirmSubmit:104-114` ตรง; essay/short ไม่ disable ปุ่มแม้ข้อความว่าง (ส่งค่าว่างได้) | เสี่ยง |
| TC-S15 | ขยายตัวอักษร | กด A+/A− รัวๆ | ฟอนต์โจทย์/ตัวเลือกขยาย-ย่อในช่วงที่อ่านได้ | `setFontScale` clamp 0.8–1.6 (`exam-store:127`), prompt=17px×scale, choice=15px×scale ตรง | ผ่าน |
| TC-S16 | autosave ระหว่างพิมพ์ | พิมพ์แล้วรอ 5 วิ | `autosaveDraft` 1 ครั้ง + HUD "บันทึกอัตโนมัติ N วินาทีที่แล้ว" + `lastDraftSavedAtMs` | `scheduleAutosave:85-98` debounce 5 วิ + `HudBar:92-95` ตรง; แต่ถ้าเปลี่ยนข้อก่อนครบ 5 วิ draft นั้นหาย (timer ถูก clear ตอนข้อเปลี่ยนโดยไม่ flush) | เสี่ยง |
| TC-S17 | ย้อนกลับ | ข้อที่ 2 + allowBack=true → กดย้อนกลับ | กลับข้อก่อนหน้า (`navigate(cursorIndex-1)`) | `goBack:116-119` ตรง; ปุ่ม disable เมื่อข้อแรก/allowBack=false ตรง | ผ่าน |
| TC-S18 | HUD ระหว่างสอบ | active, remaining 3599/299/59 | ชื่อวิชา, ข้อ x/y, badge เชื่อมต่อ, นาฬิกา `h:mm:ss`, สี เขียว→ส้ม(≤300)→แดง(≤60) | `HudBar:54-110` ตรง; ข้อความเริ่มต้น "ยังไม่มีตัวบันทึก" สะกดแปลก (น่าจะ "ยังไม่มีการบันทึก"); เคานต์ดาวน์ลดเองทุกวิจากค่า server (`44-52`) อาจคลาดกับ `exam:tick` | เสี่ยง |
| TC-S19 | ลายน้ำระบุตัวตน | active ทุกจอ + completed | ลายน้ำทแยง `รหัส • ชื่อ • เครื่อง • เวลา` จางๆ ไม่บังคลิก | `WatermarkOverlay:15-73` canvas z-9999 `pointer-events-none` opacity 0.10 + redraw ทุก 1 วิ + ขยับทุก 30 วิ ตรง | ผ่าน |
| TC-S20 | สายหลุดกลางข้อสอบ | connection=frozen | ซ่อนโจทย์ + overlay "ขาดการติดต่อ…ห้ามปิดแอป" (หน้า join) / "ซ่อนโจทย์ชั่วคราว…กู้คืนอัตโนมัติ" (หน้า exam) | `StudentPanel:147-153` + `ExamView:247-254` ตรง (fail-closed); `reconnecting` ถูก treat เป็น frozen ฝั่ง exam แต่ฝั่ง join โชว์แค่ banner "กำลังเชื่อมต่อ…" | ผ่าน |
| TC-S21 | ครูเตือน / แช่แข็ง (proctor) | `proctor-warning` / `freeze-state(frozen=true)` | แถบบน "ข้อความจากผู้คุมสอบ" 10 วิ; freeze บังเต็มจอ "เครื่องถูกแช่แข็งชั่วคราว + เหตุผล + รอปลดล็อก" | `ProctorOverlay:18-60` ตรง; warning ถูกซ่อนขณะ frozen และถูกล้างตอน unfreeze | ผ่าน |
| TC-S22 | หมดเวลา | `exam:time-up` | หน้าจอ "หมดเวลาสอบ — กำลังบันทึก…" + auto-submit ข้อค้าง + flush draft modules | `ExamView:195-209,255-260` ตรง; แต่ auto-submit ส่ง `text` ว่างเสมอเมื่อข้อนั้นเป็น MCQ (`203` ส่ง `''` ถ้า draft ไม่ใช่ text → คำตอบ MCQ ค้างหาย) | ไม่ผ่าน |
| TC-S23 | สอบจบครบทุกข้อ/ครูสั่งจบ | `exam:completed(reason)` | หน้า completed แยกข้อความ time-up/ทำครบ/จบตามคำสั่งครู + "แจ้งครูก่อนออกจากเครื่อง" | `ExamView:213-229` ตรง; ไม่มีปุ่มออกจากห้อง/กลับหน้าแรก/ดูคะแนน — นักเรียนติดหน้านี้ | เสี่ยง |
| TC-S24 | กันโกงฝั่ง UI + จับจังหวะพิมพ์ | copy/paste/drag โจทย์, พิมพ์ essay | copy/cut/paste/drag ถูกบล็อก; ส่ง typing intervals ทุก 10 วิเมื่อพิมพ์ ≥10 จังหวะ | `QuestionRenderer:121-126,44-64` ตรง; `trackTypingRhythm` ผูกเฉพาะ short-answer/essay (MCQ ไม่มี) — ตรวจ paste โกงทางคีย์บอร์ดจริงต้องพึ่ง main-process อีกชั้น | ผ่าน |
| TC-S25 | Floating HUD (Mode 3) | หน้าต่าง `#floating-hud` | เวลา + ข้อ + สถานะเชื่อม + ปุ่ม "เปิด VS Code" / "ดูโจทย์" + จอ timeup | `FloatingHud:60-110` ตรง; subscribe แค่ question/tick/recovery/time-up/completed (ไม่มี started/docs-state/module events, ไม่มี cleanup/unsub, ไม่มี `examMode`/watermark ในหน้าต่างนี้) | เสี่ยง |
| TC-S26 | เวลาเหลือ 0 แต่ยังไม่ time-up | remaining=0 + active | แถบ "รอข้อมูลเวลาจากเครื่องแม่…" | `ExamView:289-293` ตรง (โชว์เฉพาะ `remaining<=0 && !frozen && !timeup`) | ผ่าน |
| TC-S27 | submit ถูกปฏิเสธ | `exam:submit-rejected` | นักเรียนรู้ว่าถูกปฏิเสธเพราะอะไร | `exam-store:103` เก็บ `submitRejectedReason` แต่ไม่มี UI ใดในไฟล์ที่รีวิวแสดงค่านี้ (โชว์แค่ `ModuleAckBanner` ของ module-ack) → นักเรียนกดส่งแล้วเงียบ | ไม่ผ่าน |

หมายเหตุ: `lastEventDraftKey` ใน `QuestionRenderer.tsx:21,31` ถูกอ่านแต่ไม่เคยถูก set ค่า (เงื่อนไขรีเซ็ตเป็นจริงเสมอ); การกู้ `draft` ผูกกับ `useEffect [question?.questionId]` (`67-72`) ถ้า `exam:recovery` มาหลัง render อาจไม่เติมค่าทัน — เสี่ยง draft ค้างไม่กู้ในบางจังหวะ

## 3. Review

### 3.1 สิ่งที่ดี
- Happy path ครบเป็นเส้นเดียว: discovery → PIN 6 หลัก + id/name validate → waiting → started/question → answer/autosave → completed/timeup อ่านตามโค้ดได้ไม่หลง
- Validate เร็วฝั่ง client (PIN regex, trim ชื่อ/รหัส, รูปแบบ IP:Port) + ข้อความไทยชัดเจน + สถานะปุ่ม `joining` กันกดซ้ำ
- Fail-closed ตอนสายหลุดทั้งสองชั้น (หน้า join z-40 + หน้า exam ซ่อนโจทย์) + ข้อความ "ห้ามปิดแอป / กู้คืนอัตโนมัติ" ถูกจริตห้องสอบจริง
- กันโกงพื้นฐานครบ: kiosk ตอน active, โจทย์ `select-none` + block clipboard/drag, watermark ตัวตน + timestamp, freeze/warning จากผู้คุม, typing-rhythm metrics
- Autosave + กู้ draft หลัง reconnect + `flushModuleDrafts()` ตอน time-up (รวม code-ide/dynamic-form) + `ModuleAckBanner` ให้ feedback ว่า host รับงานแล้ว
- HUD อ่านง่าย: ชื่อวิชา truncated, ข้อ x/y, สีนาฬิกาตาม urgency, ปุ่มเอกสารเฉพาะ Mode 2, รองรับ A−/A+ และ split-view 3 mode

### 3.2 ปัญหา / ความเสี่ยง UX (เรียงตามความรุนแรง)
1. **[ไม่ผ่าน] หมดเวลาข้อ MCQ คำตอบหาย (TC-S22):** `ExamView.tsx:203` ส่ง `{type:'text', content:''}` เสมอเมื่อ draft ไม่ใช่ text — นักเรียนเลือก MCQ ค้างไว้แล้วหมดเวลาพอดีจะถูกบันทึกเป็นค่าว่าง
2. **[ไม่ผ่าน] submit ถูก reject แล้วจอเงียบ (TC-S27):** `submitRejectedReason` ไม่มี UI แสดง — นักเรียนไม่รู้ว่าต้องกดส่งใหม่
3. **[เสี่ยง] Autosave ตกหล่นตอนเปลี่ยนข้อเร็ว (TC-S16):** timer 5 วิถูก `clearTimeout` ทิ้งตอนข้อเปลี่ยนโดยไม่ flush — พิมพ์แล้วกดส่ง/เปลี่ยนข้อก่อน 5 วิ = draft ระหว่างทางหาย (เหลือแค่คำตอบตอนกดส่ง)
4. **[เสี่ยง] Draft กู้คืนไม่เสถียร (TC-S27 โน้ต):** `lastEventDraftKey` ไม่เคยถูก assign + effect กู้ draft ขึ้นกับ `questionId` อย่างเดียว — recovery ที่มาช้าอาจไม่เติมลงช่อง
5. **[เสี่ยง] ไม่เจอทางออกจาก kiosk/หน้าจบ (TC-S12/TC-S23):** ไม่พบ `exitKiosk` ในไฟล์ที่รีวิว; หน้า completed ไม่มีปุ่มกลับ/ออกจากห้อง — เครื่องค้างต้องพึ่งครู/ปิดแอปเอง
6. **[เสี่ยง] นาฬิกานับถอยหลังอาจคลาด (TC-S18):** `HudBar` ลด `remainingSeconds` เองทุกวิ (`44-52`, effect ใหม่ทุกครั้งที่ remaining เปลี่ยน) ซ้อนกับ `exam:tick` จาก host — เวลาแสดงอาจเดินเร็ว/กระตุก; `FloatingHud` มี logic เดียวกันใน window แยก (store แยกเลยไม่ซ้ำกัน แต่ pattern เดียวกัน)
7. **[เสี่ยง] Header สถานะหลอก (TC-S01):** `StudentShell` ใช้ไอคอน `WifiOff` ทุก state — ต่อติดแล้วยังเห็นไอคอน "ไม่มีเน็ต"
8. **[เสี่ยง] Manual join เปราะ (TC-S08):** ไม่ trim host, ไม่รองรับ IPv6, ไม่เช็ค port range; เลือกห้องแล้วช่อง manual หายไปเลย (สลับวิธีต้อง unselect ก่อน — แต่ไม่มีปุ่มยกเลิกการเลือกห้อง)
9. **เล็ก:** คำผิด "ยังไม่มีตัวบันทึก" (`HudBar:94`); `certFpShort` ต่อ `…` ซ้ำ; `timeSince` มีแค่ s/m; ไอคอน Search ตกแต่งเฉยๆ (ไม่มีช่องค้นหาจริง); modal ยืนยันมีเฉพาะโหมดย้อนกลับไม่ได้; ปุ่มส่ง essay/short ไม่ disable ตอนว่าง (ส่งค่าว่างได้); `FloatingHud` ไม่มี watermark/examMode/docs-state; subscribe ระดับโมดูลไม่มี cleanup (`ExamView:94-96`, `FloatingHud:30-40`)

### 3.3 ข้อเสนอแนะ
- ส่ง `store.draft` ตาม type จริงตอน time-up (MCQ → `{type:'mcq', choiceIndex}`, ไม่มี draft ค่อยส่งว่าง) + เพิ่ม TC โหมด MCQ/time-up
- แสดง `submitRejectedReason` เป็น banner ใต้ปุ่มส่ง + ปุ่ม "ส่งอีกครั้ง"
- ทำ autosave แบบ flush-on-submit/unmount/question-change (ส่ง draft ค้างก่อนเปลี่ยนข้อ) หรือลด debounce + ส่ง `onLocalDraftSaved` ทันทีที่พิมพ์แบบ throttle
- ซ่อมกู้ draft: set `lastEventDraftKey = questionId` หลังรีเซ็ต + เพิ่ม effect ฟัง `store.draft` โดยตรง ไม่ใช่แค่ `questionId`
- เพิ่มปุ่ม "ออกจากห้อง / กลับหน้าแรก" หน้า completed + เรียก `exitKiosk()` ตอน completed/closed/unmount (ยืนยันกับฝั่ง host ก่อน)
- เปลี่ยนนาฬิกาเป็น derived (`deadlineMs - now`) หรือให้ server tick เป็น authoritative อย่างเดียว + แสดง "≈" เมื่อเป็นเวลาประมาณ
- สลับไอคอน `Wifi`/`WifiOff` ตาม `connectionState`; เพิ่มปุ่ม "ยกเลิกที่เลือก" ห้อง + trim/normalize manual host + validate port 1–65535 + รองรับ IPv6 `[::1]:port`
- แก้คำผิด, ตัด `…` เฉพาะเมื่อ fingerprint ยาว, เพิ่มค้นหา/เรียงห้องเมื่อห้องเยอะ, disable ปุ่มส่งเมื่อ essay/short ว่าง (หรือยืนยัน "ส่งกระดาษเปล่า?"), เติม watermark/exam-started/docs-state ให้ FloatingHud + cleanup subscriptions

## 4. สรุป
- ทั้งหมด 27 เคส (อ่านโค้ด): **ผ่าน 17 / เสี่ยง 8 / ไม่ผ่าน 2** (TC-S22 autosubmit MCQ, TC-S27 submit-rejected เงียบ)
- Happy path หลัก (ค้นห้อง → PIN → waiting → รับข้อ → ตอบ → autosave → completed) อ่านแล้วทำงานได้ แต่มี 2 จุดข้อมูลหาย/เงียบที่ควรซ่อมก่อนใช้สอบจริง + งาน UX เล็กๆ (kiosk exit, นาฬิกา, draft recovery, manual join) ควรเก็บในรอบถัดไป

# Fail-Closed & Negative Test — นักเรียน edge-case + ครูเจอปัญหาเครือข่าย/attestation

วันที่ทดสอบ: 20251031
ผู้ทดสอบ: Tester Agent #5 (นักเรียน edge-case)
ขอบเขตโค้ด: `src/renderer/src/components/StudentPanel.tsx` (joinError, manual IP, PIN validation, connection states: ready/connecting/reconnecting/frozen/rejected/closed), `src/renderer/src/core-student/ExamView.tsx` (frozen overlay, timeup flush, completed), `src/renderer/src/store/exam-store.ts`, `network-store.ts`, Grep: `heartbeat`, `FROZEN_DISCONNECTED`, `recovery`, `attestation` (`getAttestationConfig`/`setAttestationEnforce`/`devMode`), `closeRoom`
วิธีทดสอบ: code-review แบบ static (อ่าน flow จริง + test เดิม `tls-handshake.test.ts`, `heartbeat.test.ts`, `core-session-manager.test.ts`, `dispatcher.test.ts`) ไม่รัน E2E จริง

## 1. Flow ที่ไล่ (expected fail-closed)

### A. Join validation (ฝั่ง renderer ก่อนยิง TLS) — `StudentPanel.tsx:80-117`
1. `join()` กันก่อน: `!/^\d{6}$/` → `setJoinError('กรอก PIN 6 หลัก')` + return (ไม่ยิง `joinRoom`)
2. `studentId/studentName.trim().length===0` → `setJoinError('กรอกรหัสและชื่อนักเรียน')`
3. ปุ่มเข้าห้องเมื่อ `!selected && manualOpen`: regex `/^(.+):(\d+)$/` + `manualRoomId.trim()` ไม่ผ่าน → `setJoinError('รูปแบบ IP:Port หรือ Room ID ไม่ถูกต้อง')`
4. `!selected && !manualOpen` → `setJoinError('เลือกห้องก่อน หรือกรอก IP เครื่องแม่')`
5. `joining=true` ระหว่างรอ → ปุ่ม `disabled`, ข้อความ `กำลังตรวจ PIN + fingerprint…`

### B. TLS handshake fail (ฝั่ง main) — `tls-client.ts:179-264`, `tls-server.ts:245-306`
1. `SERVER_PROOF = HMAC(pinKey, fingerprint+clientNonce+serverNonce)` — PIN ผิด / fingerprint ปลอม (MITM) → `proofOk=false` → `destroy()` + `setState('rejected','bad-proof (Room PIN ผิด หรือเครื่องแม่ถูกปลอมแทน)')` + throw `HandshakeProofError`
2. `JOIN_REJECTED` จาก server → `setState('rejected', reason)` + throw `JoinRejectedError(reason)`; reason ที่ server ส่งได้: `bad-auth` (clientAuth HMAC ไม่ตรง), `duplicate-id` (รหัสซ้ำและยัง online), `room-full` (>=60), `unknown-message` (resume token ไม่เจอ)
3. `catch` ใน `StudentPanel.tsx:112-113` → `setJoinError(err.message)` — กรณี `JOIN_REJECTED:bad-auth` จะโชว์ raw string นี้ (ดูข้อติ NC-04)
4. ยังไม่เคย join สำเร็จ (`sessionToken===null`) แล้วสายหลุด → **ไม่เข้า frozen** (`wireEstablishedHandlers:349-353` return เงียบ) — ถูกต้อง (ยังไม่มีอะไรให้ซ่อน)

### C. ห้องปิด / หมดเวลา — `tls-client.ts:339-343`, `main/index.ts:928`, `ExamView.tsx:213-229`
1. `roomClosed` → `abort()` (หยุด heartbeat + reconnect timer + destroy) + `setState('closed','room-closed')` → banner `ห้องปิดแล้ว` (`StudentPanel.tsx:131`) และ `StudentExamLayers` ยังค้าง phase `waiting/active` (ไม่มี auto-reset — ครูต้องแจ้งนักเรียน)
2. `endExam('time-up'|'ended-by-host')` → `timeUp` + `examCompleted` → renderer `onTimeUp()` → phase `timeup` (จอแดง `หมดเวลาสอบ / กำลังบันทึกคำตอบล่าสุด`), `onCompleted()` → phase `completed` (จอเขียว + `finishReason`, `exitKioskMode`)

### D. Attestation (Phase 4) — `attestation/host-verifier.ts:208-299`, `ipc/attestation-handlers.ts`, `HostPanel.tsx:591-623`, `main/index.ts:694-702`
1. Challenge ทุกรอบ 45–120s, deadline 2.5s (test `attestation-host-verifier.test.ts:26`); ไม่มีคำตอบ/ตอบช้า/HMAC ผิด/manifest เปลี่ยน/`manifest-hash-changed`/`sample-count-mismatch` → `reject()` → `applyFailure()` → caller fail-closed: **คนแดงใน triage + hash chain + freeze จอข้อสอบทันที** (`main/index.ts:694`)
2. `isDev() || !strictToggle.enforced` → ยอม `dev-unsigned` (ไม่มีลายเซ็น) — โหมดพัฒนาเท่านั้น; `isDev()==false` หรือ `enforced==true` → ต้อง `verifySignedManifest` ผ่าน Ed25519
3. สวิตช์อยู่เฉพาะ `attestation?.devMode` (production ไม่ render) — ครู production มองไม่เห็นสถานะ attestation (ดูข้อเสนอ)

### E. สายหลุดกลางสอบ (heartbeat → frozen → reconnect → recovery) — `heartbeat.ts:3-6`, `tls-client.ts:363-413`, `core-session-manager.ts:422-466`, `ExamView.tsx:231,246-254`, `QuestionRenderer.tsx:85-98`
1. Ping ทุก 3s, timeout ถ้าไม่มี inbound ใดๆ เกิน 8s → `onTimeout()` → `destroy()` + `enterFailClosed('HEARTBEAT_TIMEOUT')`; `closed` event หลัง join สำเร็จ → `enterFailClosed('CONNECTION_LOST')`
2. `enterFailClosed` → `setState('frozen')` → `scheduleReconnect()` → `setState('reconnecting','attempt=N')` + backoff `1s,2s,4s,5s,5s…` (`nextReconnectDelayMs`) วนไม่จำกัดจนกว่าจะ `abort()` (roomClosed) หรือสำเร็จ
3. Renderer: `connection.state==='frozen'` → overlay เต็มจอ `ขาดการติดต่อกับเครื่องแม่ / กำลังเชื่อมต่อใหม่อัตโนมัติ…ห้ามปิดแอป` (`StudentPanel.tsx:147-153`); `frozen||reconnecting` ใน `ExamView` → **ซ่อนโจทย์ทั้งหมด** + ข้อความ `ระบบซ่อนโจทย์ชั่วคราว…จะกู้คืนข้อเดิมพร้อมคำตอบที่พิมพ์ค้างไว้ให้โดยอัตโนมัติ` — fail-closed ถูกต้อง
4. Reconnect สำเร็จ → server `handleStudentEstablished()` → `RecoveryManager.buildStateRecovery()` → `STATE_RECOVERY` (+ `examMode`, `policyUpdate`, `screenSession`) → renderer `onRecovery()` → phase `active` + คืน `question+draft+remainingSeconds+cursorIndex`; ถ้าไม่มี draft → ส่ง `questionPayload` ข้อ 0
5. Autosave กันข้อมูลหาย: `QuestionRenderer.scheduleAutosave()` debounce 5s → `autosaveDraft()` + `onLocalDraftSaved()`; module (`code-ide`/`dynamic-form`) `onAutosaveDraft` → `stashModuleDraft` + `moduleSend(autosave)` แบบ fire-and-forget (`.catch(()=>undefined)`)

### F. หมดเวลาระหว่างพิมพ์ค้าง (flush draft) — `ExamView.tsx:194-209,22-53`
1. `phase==='timeup'` → `submitAnswer(current draft)` (text ปัจจุบัน, `timeSpentMs:0`) + `flushModuleDrafts()` (ยิง `lastModuleDrafts` ทุก module ครั้งสุดท้าย kind `autosave`/`action`)
2. `flushModuleDrafts` มี `clear()` ก่อนส่ง + `try/catch` ราย job — สายหลุดระหว่าง flush → host `finalizeCollection` เลื่อน draft เดิมใน DB ให้ (comment ในโค้ด); dynamic-form ข้ามถ้า `items` ว่าง (กันส่งขยะ)

### G. submit-rejected — `dispatcher.ts:166-229`, `ipc/exam-handlers.ts:161-162`, `exam-store.ts:103`
1. Server ปฏิเสธเมื่อ: `time-expired` (clock ปิด), `not-started` (ไม่มี state), `cursor-mismatch` (index ไม่ตรง cursor + anomaly `SUBMIT_CURSOR_MISMATCH`), `bad-question` (questionId ไม่ตรง order / choice index เกิน)
2. Forward `submitRejected → exam:submit-rejected → onSubmitRejected({reason})` → เก็บ `submitRejectedReason` อย่างเดียว — **ไม่มี UI แสดง** (`QuestionRenderer` ไม่ render `submitRejectedReason`, `ModuleAckBanner` แสดงแค่ `lastModuleAck` ของ module) — ดู NC-12

## 2. Testcases (negative)

| ID | เคส | ขั้นตอน | ผลที่คาด (fail-closed) | ผลจากโค้ดจริง | ผ่าน? | ข้อสังเกตภาษา/UX |
|----|------|----------|------------------------|----------------|-------|-------------------|
| NC-01 | PIN สั้น/ไม่ใช่ตัวเลข (5 หลัก, `12ab56`, ว่าง) | กรอกรหัส+ชื่อครบ, PIN `12345`, กดเข้าห้อง | บล็อกก่อนยิง TLS, `กรอก PIN 6 หลัก` | `StudentPanel.tsx:81-84` return ก่อน `joinRoom`; input `replace(/\D/g,'')` + `maxLength=6` กันตัวอักษรอยู่แล้ว | ✅ | เข้าใจง่าย; ดีที่ trim ก่อนตรวจชื่อ |
| NC-02 | ไม่กรอกชื่อ/รหัส (ว่าง, space ล้วน) | PIN ครบ 6, ชื่อว่าง, กดเข้าห้อง | บล็อก, `กรอกรหัสและชื่อนักเรียน` | `StudentPanel.tsx:85-88` เช็ค `trim().length===0` | ✅ | ควรแยกข้อความ "รหัสว่าง" vs "ชื่อว่าง" — ครูตามตัวง่ายกว่า |
| NC-03 | ไม่เลือกห้อง + ไม่เปิด manual | เปิดหน้ามา, กดเข้าห้องเลย | `เลือกห้องก่อน หรือกรอก IP เครื่องแม่` | `StudentPanel.tsx:297-299` | ✅ | เข้าใจได้; ถ้า discovery ว่าง >7s ควร hint ว่าให้ครูเปิด beacon (มีอยู่บรรทัด 172-174 ดีแล้ว) |
| NC-04 | PIN ผิด 6 หลัก / โดน MITM | กรอกครบ, PIN ผิด | เข้าห้องไม่ได้, ไม่อยู่ในห้อง, ข้อความเข้าใจได้ | `tls-client.ts:209-213` → `rejected/bad-proof (Room PIN ผิด หรือเครื่องแม่ถูกปลอมแทน)`; แต่ถ้า `bad-auth` จาก server จะโผล่เป็น `JOIN_REJECTED:bad-auth` ดิบผ่าน `catch` | ⚠️ | **ติ:** `JoinRejectedError` ไม่แปลไทย — นักเรียนเห็น `JOIN_REJECTED:bad-auth` จะงง; ควร map `bad-auth→Room PIN ผิด`, `duplicate-id→รหัสนี้เข้าแล้ว`, `room-full→ห้องเต็ม`, `unknown-message→เซสชันหมดอายุ กรุณาเข้าห้องใหม่` |
| NC-05 | manual IP ผิดฟอร์แมต | เปิด manual, กรอก `192.168.1.10` (ไม่มี port) / `abc:xyz` / Room ID ว่าง | `รูปแบบ IP:Port หรือ Room ID ไม่ถูกต้อง` | regex `/^(.+):(\d+)$/` + `trim()` (`StudentPanel.tsx:291-295`) | ✅ | ดี; แต่ `(.+)` รับ `http://…` มาด้วยแล้ว `tls.connect(host='http://…')` จะ fail ด้วย `TLS_HANDSHAKE_TIMEOUT`/socket error ดิบ — ควร strip scheme/space เพิ่ม |
| NC-06 | ห้องปิดขณะรอ (`roomClosed`) | ครูกดปิดห้องตอนนักเรียนอยู่หน้า waiting | banner `ห้องปิดแล้ว`, หยุด reconnect, ไม่ค้าง spinner | `tls-client.ts:339-343` `abort()` + `closed`; banner `StudentPanel.tsx:131` | ✅ | ข้อความสั้นไป — ควรบอก "แจ้งครูเพื่อเปิดห้องใหม่" เพราะ phase ค้าง `waiting` ต้องเลือกห้องใหม่เอง |
| NC-07 | PIN fingerprint ไม่ตรง (beacon ปลอม) | ปลอม beacon แต่ไม่รู้ PIN | `rejected/bad-proof…` ไม่ส่งชื่อ/รหัสออกไป | `verifyHmacTimingSafe` ผูก `peerCertFingerprint` จริงจาก socket (`tls-client.ts:187,200-208`) | ✅ | fail-closed ถูกต้อง (ตรวจก่อนส่ง `JOIN_REQUEST`); ข้อความมีคำว่า MITM ดีสำหรับครูแต่อาจยากสำหรับเด็ก — คงไว้ได้เพราะครูอ่านช่วย |
| NC-08 | attestation ไม่ผ่านกลางสอบ | แก้ไฟล์แอป 1 ไบต์ / ตอบ HMAC ผิด / เกิน deadline 2.5s | คนแดง + freeze จอทันที, มี audit | `host-verifier.ts:208-267` `reject()` ทุกสาขา + `applyFailure` → freeze (`main/index.ts:694-702`) | ✅ | เข้มถูกต้อง; แต่ฝั่งนักเรียนไม่เห็นเหตุผล (เห็นแค่ frozen) — ควรให้ครูเห็น reason ใน triage (มี `failure.reason` แล้ว ดี) |
| NC-09 | attestation devMode ลืมเปิด enforce | รัน dev (`isDev=true`), ไม่กดสวิตช์ | banner `DEV MODE: อนุญาต Client ที่ไม่ได้เซ็นลายเซ็น` + manifest ยอม `dev-unsigned` | `attestation-handlers.ts:54-58` + `host-verifier.ts:290-299` + `HostPanel.tsx:591-623` | ⚠️ | **เตือนครู:** dev build หลุดไปสอบจริง = ช่องโหว่; ควรมี guard ห้ามเริ่มสอบจริงขณะ `devMode && !enforced` หรืออย่างน้อย confirm modal; production ไม่แสดง banner เลย (เช็ค `attestation?.devMode` อย่างเดียว) |
| NC-10 | สาย LAN หลุดกลางสอบ (ถอดสาย 10s) | ทำข้อ 3 อยู่, ถอดสาย | ซ่อนโจทย์ทันที, ห้ามทำต่อ, reconnect backoff 1/2/4/5s, กลับมาข้อเดิม+draft | heartbeat 8s → `frozen` → overlay ซ่อนโจทย์ (`ExamView.tsx:247-254`), `scheduleReconnect` ไม่จำกัดครั้ง, `STATE_RECOVERY` คืน `question+draft+remaining` | ✅ | fail-closed ครบ; ข้อความสองที่ซ้ำซ้อนกัน (`StudentPanel` + `ExamView` แสดงพร้อมกันได้) — ควรเหลือชั้นเดียวตอน phase active |
| NC-11 | หมดเวลาระหว่างพิมพ์ค้าง (essay พิมพ์ค้าง 200 ตัว, autosave ยังไม่ถึงรอบ 5s) | พิมพ์ค้างแล้ว `timeUp` มาถึงก่อน debounce | draft ล่าสุดต้องถึงเครื่องแม่แม้ autosave ยังไม่ยิง | `ExamView.tsx:194-209` ยิง `submitAnswer(current draft)` + `flushModuleDrafts()` จาก `lastModuleDrafts` (stash ทุกครั้งที่ `onAutosaveDraft`) — ไม่พึ่ง timer 5s | ✅ | ดี (F-2); แต่ text-mode ใช้ `store.draft` ซึ่ง `onQuestion` เซ็ต `draft:null` และ `QuestionRenderer` ไม่ sync `textContent` กลับ store ทุก keystroke — ถ้า autosave ยังไม่เคยยิงเลย `store.draft` จะ null แล้ว `timeup` ส่ง `content:''` ว่าง! ต้องอ่าน `textContent` จาก component หรือ stash แบบ module ด้วย |
| NC-12 | submit-rejected (`cursor-mismatch`/`time-expired`/`bad-question`) | ส่งซ้ำ/ส่งข้อเก่า/ส่งหลังหมดเวลา | นักเรียนรู้ว่าถูกปฏิเสธเพราะอะไร + ทำอย่างไรต่อ | `onSubmitRejected` เก็บ `submitRejectedReason` แต่ **ไม่มี UI ใด render**; `ModuleAckBanner` แสดงแค่ module ack 10s | ❌ | **บั๊ก UX:** นักเรียนกดยืนยันแล้วเงียบ (นึกว่าส่งผ่าน); ต้องแสดง banner `ส่งไม่สำเร็จ: <reason แปลไทย> — กดส่งใหม่/รอข้อใหม่` และ log anomaly ฝั่งครูมีแล้ว (`SUBMIT_CURSOR_MISMATCH`) ดี |
| NC-13 | กดย้อนกลับ/ส่งซ้ำหลัง reconnect | reconnect แล้วกดส่งข้อเดิมซ้ำ | ไม่เบิ้ลคะแนนมั่ว, server ยึด cursor/draft | `dispatcher.handleSubmitAnswer` ตรวจ cursor+questionId+choice range; `core-session-manager.applySubmission` ใช้ `seqNo` ต่อ `(studentId:questionId)` | ✅ | recovery ครบ; back-nav อนุญาตเฉพาะ `allowBackNavigation && <=maxReachedCursor` ถูกต้อง |
| NC-14 | attestation response ช้าเกิน deadline (เน็ตกระตุก) | ping ช้า 3s | โดน `response-too-late` แม้ตั้งใจดี | `host-verifier.ts:224-227` เช็ค `elapsed > deadlineMs` หลัง clear timer | ⚠️ | เข้มแต่เสี่ยง false-positive บน WiFi โรงเรียน; ควรแยก `timeout(ไม่ตอบ)` vs `late(ตอบช้า)` — late ครั้งแรกเตือนก่อน freeze (ตอนนี้ freeze ทันทีตาม fail-closed) |
| NC-15 | heartbeat flapping (หลุดๆ ติดๆ) | สายหลวม ping ขาดเป็นช่วง | ไม่ค้าง `reconnecting attempt=N` นาน, remaining ไม่ย้อน | `recordActivity()` ทุก message+binary (`tls-client.ts:327,331`); `remaining` คำนวณจาก `examEndsAtMs-Date.now()` ฝั่ง server ทุก recovery (`core-session-manager.ts:442-445`) | ✅ | ดี; `attempt` reset เป็น 0 เมื่อสำเร็จ (`tls-client.ts:398`) |

## 3. Review สรุป

### fail-closed ถูกต้องไหม — ถูกต้อง 4/5 จุด
- ✅ PIN/fingerprint ตรวจก่อนส่ง identity (`tls-client.ts:196-213` ก่อน `joinRequest`)
- ✅ หลุดสายซ่อนโจทย์ทั้งสองชั้น (`StudentPanel frozenFull` + `ExamView frozen`) + ซ่อน docs (`docs-view.ts:160` `setHidden(true)`) + `abort()` หยุด reconnect เมื่อห้องปิด (ไม่วนยิงมั่ว)
- ✅ attestation ทุกสาขา `reject()` + freeze + audit (`host-verifier.ts`, `main/index.ts:694-702`)
- ⚠️ ช่องเดียว: NC-11 text-mode timeup flush อาจส่งค่าว่างถ้า autosave ยังไม่เคยทำงาน (เพราะ `store.draft` ไม่ใช่ live text) — ต้องแก้ก่อนสอบจริง

### recovery ครบไหม — ครบ (เหลือ NC-12)
- ✅ backoff 1/2/4/5s + `STATE_RECOVERY` (question+draft+remaining+cursor+examMode+policy+screenSession) + `seqNo` กันเบิ้ล + autosave 5s + module stash + flush สุดท้าย
- ❌ submit-rejected ไม่มี UI — นักเรียนไม่รู้ว่าต้องทำอะไรต่อ (store มีข้อมูลแต่ไม่มีคน render)

### error message เข้าใจง่ายไหม — 5/8 ดี, 3 ต้องแปล
- ดี (ไทยชัด): `กรอก PIN 6 หลัก`, `กรอกรหัสและชื่อนักเรียน`, `รูปแบบ IP:Port หรือ Room ID ไม่ถูกต้อง`, `ขาดการติดต่อกับเครื่องแม่…`, `ระบบซ่อนโจทย์ชั่วคราว…`
- ต้องแก้: `JOIN_REJECTED:bad-auth/duplicate-id/room-full/unknown-message` (ดิบอังกฤษ), `room-closed → ห้องปิดแล้ว` (สั้น, ไม่บอก next-step), `submit-rejected reason` (ไม่แสดงเลย)

### ข้อเสนอแก้ด่วน (ไม่แก้ในรอบนี้ — บันทึกไว้)
1. (P0) NC-12: render `submitRejectedReason` ใน `QuestionRenderer`/`ModuleAckBanner` แบบแปลไทย + ปุ่มส่งใหม่
2. (P0) NC-11: `timeup` flush ของ text-mode ต้องอ่าน live draft จาก `QuestionRenderer` (lift state หรือ stash แบบ module) ไม่ใช่ `store.draft` อย่างเดียว
3. (P1) NC-04: map `JoinRejectedError.reason` เป็นไทยใน `StudentPanel catch`
4. (P1) NC-09: กันลืม enforce — ถ้า `devMode && !signatureEnforced` ให้ confirm modal ก่อนเริ่มสอบ / ห้ามใช้ exam จริง
5. (P2) NC-05: sanitize manual host (strip `http(s)://`, trim, ตรวจ port 1–65535) ก่อน `tls.connect`
6. (P2) NC-06/10: รวม frozen overlay ให้เหลือชั้นเดียวตอน `phase==='active'` (ตอนนี้ `StudentPanel` + `ExamView` ซ้อนกันได้)

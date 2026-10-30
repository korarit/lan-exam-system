# ผลทดสอบโมดูล dynamic-form + code-ide (ครูออกข้อสอบ + นักเรียนทำข้อสอบ)

วันที่ทดสอบ: 20251031
ผู้ทดสอบ: Tester Agent #6 (ครูออกข้อสอบ+นักเรียน)
โค้ดเบส: E:\lan-exam-system
ไฟล์อ้างอิง: `src/renderer/src/components/HostShell.tsx`, `src/modules/dynamic-form/renderer/builder/FormBuilderWorkspace.tsx`, `src/modules/dynamic-form/renderer/responses/ResponsesDashboard.tsx`, `src/modules/dynamic-form/renderer/student/DynamicFormStudentWorkspace.tsx`, `src/modules/code-ide/renderer/builder/CodeExamBuilder.tsx`, `src/modules/code-ide/renderer/student/StudentCodeIdeWorkspace.tsx` (+ `MonacoCodeWorkspace.tsx`, `AdaptiveExecutionPanel.tsx`), `src/modules/code-ide/renderer/responses/CodeSubmissionsTable.tsx` (+ `StudentProjectInspectorModal.tsx`), `src/renderer/src/core-student/ExamView.tsx`

วิธีทดสอบ: อ่านโค้ดแบบ static walkthrough สวม 2 บทบาท (ครูฝั่ง HostShell tabs / นักเรียนฝั่ง ExamView slots) ไม่รันแอปจริง ไม่แก้ไฟล์อื่น

---

## 1. Flow ที่ไล่ (Teacher → Student → Teacher)

### A. Dynamic Form — ครูสร้าง (FormBuilderWorkspace)
- ตั้ง title/instructions/duration(1–480)/shuffle/navigation/showScore → เพิ่มข้อครบ 12 input types (`form-schema.ts:11-24`: mcq_single, checkbox_multi, dropdown, short_text, long_text, numeric_param, mcq_grid, checkbox_grid, linear_scale, date_time, code_snippet, file_upload) + 2 block (section_header/media_stimulus) → ตั้งเฉลย/คะแนน/validation ต่อข้อใน QuestionCard → `collectFormIssues` กันบันทึกถ้าฟอร์มว่าง/เฉลยผิด → save `.ztform` (plain หรือ AES-256-GCM+PBKDF2 100k รอบ, PasswordAskModal) / load `.ztform` (needPassword flow) / import CSV+JSON / preview นักเรียน / ดู savedForms ล่าสุด 5 รายการ → เอาไปผูกห้อง (attachRoomForm จาก ResponsesDashboard)

### B. Dynamic Form — นักเรียนทำ (DynamicFormExamSlot + DynamicFormStudentWorkspace)
- `ExamView.tsx:129-156` ส่ง moduleState (stripped view, ไม่มี answerKey) → Workspace แสดง title/instructions/questions → ตอบรายข้อ (`FormAnswerInput`) → `toStoredAnswer` แปลง kind (choice/multi/numeric/rows/scale/text/code/date/files) → ส่งรายข้อ `dynamic-form.submit-item` / ส่งทั้งหมด `dynamic-form.submit-all` ผ่าน `onDispatchAction→moduleSend(action)` → autosave throttle 5 วิ (`queueAutosave`, เฉพาะข้อที่ตอบแล้ว) ผ่าน `onAutosaveDraft→moduleSend(autosave)+stashModuleDraft` → file_upload แสดงป้าย F-1 "ยังไม่ส่งไบนารีผ่านท่อ" (ส่ง descriptor ว่าง) → `ModuleAckBanner` โชว์ ✅/⛔ 10 วินาที → หมดเวลา `flushModuleDrafts` ยิง `dynamic-form.submit-all` ครั้งสุดท้าย (ข้ามถ้า items ว่าง)

### C. Dynamic Form — ครูตรวจ (ResponsesDashboard)
- `getFormResponses` + `getFormState` → 3 tabs: Summary (mean/median/max/min/needsManual + distribution + itemStats + flaggedHard "ตอบผิดเกิน 70%"), By-Question (select ข้อ + Blind Grading ซ่อนชื่อ + Enter ให้คะแนน + keyword hits + artifacts เปิดไฟล์ + ล้างคะแนน), Individual (select นร. + SecurityBadge CRITICAL/WARNING/OK + suspicionScore + totals + เฉลย/time/violations) → ปุ่ม: ผูกฟอร์ม/ Re-grade All (confirm + รายงาน students/changedItems/totalDeltaPoints)/ Export CSV / Save `.ztresults` (+เข้ารหัส) / เปิด `.ztresults` / รีเฟรช + regradeHistory (8 รายการล่าสุด)

### D. Code IDE — ครูสร้าง (CodeExamBuilder)
- title/instructions → TrackAndLanguageSelector (5 category: cli-algorithm/frontend/backend/database/fullstack; 18 ภาษา `code-schema.ts:33-56` ครอบคลุม Java/Python/HTML-CSS-JS/React/JS/TS ตามสั่ง + C/C++/Rust/Go/PHP/SQL/Backend variants) → database SQLite เท่านั้น (sql-mysql legacy อ่านได้อย่างเดียว; sqlMode query/create-table + schema viewer toggle) → upload starter/reference → สิทธิ์ไฟล์ (readOnly/hiddenFromStudent) + entryPoint → OfflineDependencyManager + installPolicy opt-in (เฉพาะ exact name@version ใน bundles, npm/pip) → TestCaseEditor 5 kinds (stdio/unit-harness/dom-assertion/http-api/sql-query, points/timeout) → "ทดสอบรันเฉลย" (ปัจจุบันเช็คโครง reference+tests เท่านั้น, รันจริง Phase 9) → preview ด้วย `StudentCodeIdeWorkspace` ตัวเดียวกับ นร. (viewerRole=teacher) → save `.ztcode` (HMAC-SHA256 + manifest, ขนาดเตือนถ้า >~25MB IPC) → attachCodeRoomPackage เข้าห้อง (fail ถ้า ROOM_NOT_OPEN)

### E. Code IDE — นักเรียนทำ (CodeIdeExamSlot + StudentCodeIdeWorkspace)
- stripped package (ไม่มี hidden/reference/hidden tests/blobs) → layout โจทย์|Explorer|Monaco|ผลลัพธ์ → Explorer (สร้าง/ลบ/rename ไฟล์-โฟลเดอร์, เคารพ readOnly lock) → `MonacoCodeWorkspace` (model ต่อไฟล์, inline workers, textarea fallback ถ้าโหลดไม่ได้, .d.ts IntelliSense ออฟไลน์) → `AdaptiveExecutionPanel` (run/test console: รัน entryPoint + ทดสอบ sample tests, Ctrl+Enter) → autosave throttle 5 วิผ่าน `onAutosave` (teacher preview ข้าม) → Submit ผ่าน `onSubmit` → `ExamView:100-127` ส่ง `moduleSend(action/autosave)` + stash → ack banner + time-up flush (`code-ide→autosave` ครั้งสุดท้าย)

### F. Code IDE — ครูตรวจ (CodeSubmissionsTable + Inspector)
- auto-refresh 8 วิ + `getCodeSubmissions` (packageTitle/category/language/queue active-pending/workspace root/depsUnsupported/ROOM_NOT_OPEN hints) → ตาราง: นร./fileCount/Tests 🟢🟡🔴/auto/manual(validate 0–max)/รวม/สถานะ(graded/grading/queued/blocked/error)/ปุ่มดูโค้ด+เปิดโฟลเดอร์ → Re-grade All / Export CSV / Export Bundle (โฟลเดอร์ทั้งห้อง+grading-report.json) / เลือก workspace root / manual grade (manual ชนะ auto) → `StudentProjectInspectorModal`: tabs code/diff(เทียบเฉลย, LCS)/tests/playback(slider ย้อน stages)/preview/api/sql/comments + Monaco อ่านงาน นร.

---

## 2. Testcases

| ID | บทบาท | ขั้นตอน | คาดหวัง | ผล (code review) | หมายเหตุ |
|----|--------|----------|----------|-------------------|-----------|
| F-BUILD-01 | ครู | สร้างฟอร์มครบ 12 input types + ตั้งเฉลย/คะแนน | บันทึกได้, totalQuestions/Points ตรง | PASS | schema มีครบ 12+2 block |
| F-BUILD-02 | ครู | บันทึกฟอร์มว่าง / เฉลยผิด | ถูกบล็อก + notice ใบแรก | PASS | `collectFormIssues` + guard items==0 |
| F-BUILD-03 | ครู | save/load `.ztform` เข้ารหัส | ต้องใส่รหัสผ่าน, AES-GCM roundtrip | PASS | PasswordAskModal + needPassword |
| F-BUILD-04 | ครู | import CSV/JSON | นำเข้าบางส่วน + แจ้ง error 2 รายการแรก | PASS | alias map + partial import |
| F-STU-01 | นร. | ตอบรายข้อ → ส่งข้อนี้ | `submit-item` + notice รอ host | PASS | guard ตอบก่อนส่ง |
| F-STU-02 | นร. | ส่งงานทั้งหมด | `submit-all` เฉพาะข้อที่ตอบ | PASS | guard 0 ข้อ |
| F-STU-03 | นร. | พิมพ์ค้าง (throttle) | autosave ทุก ≥5 วิ | PASS | `lastAutosaveRef` |
| F-STU-04 | นร. | file_upload | ขึ้นป้าย F-1, ไม่ส่งไบนารี | PASS (by design) | ส่ง `artifactIds:[]` — ครูเก็บช่องทางอื่น |
| F-ACK-01 | นร. | host ตอบ module-ack ok/fail | banner ✅/⛔ หายใน 10 วิ | PASS | `ModuleAckBanner` + exam-store |
| F-TIME-01 | นร. | หมดเวลามี draft ค้าง | flush `submit-all` ครั้งสุดท้าย | PASS | `flushModuleDrafts`, ข้ามถ้าว่าง |
| F-RESP-01 | ครู | เปิด dashboard ยังไม่ผูกฟอร์ม | notice ให้ attach | PASS | getFormState null guard |
| F-RESP-02 | ครู | Summary | สถิติ + flag ข้อผิด>70% | PASS | itemStats/flaggedHard |
| F-RESP-03 | ครู | By-Question + Blind + Enter | ให้คะแนนเร็ว, keyword hits โชว์ | PASS | GradingRow |
| F-RESP-04 | ครู | Re-grade All | confirm + รายงาน delta | PASS | ไม่แตะคำตอบดิบ |
| F-RESP-05 | ครู | Export CSV / `.ztresults` ±เข้ารหัส | ได้ไฟล์ + notice path | PASS | ครบ (ดู §3) |
| C-BUILD-01 | ครู | สร้างโจทย์ Java/Python/HTML/CSS/React/JS/TS | language+category ตรง, starter ตรงภาษา | PASS | 18 ภาษาครอบคลุม |
| C-BUILD-02 | ครู | ตั้ง readOnly/hidden + entryPoint | นร.แก้ไม่ได้/มองไม่เห็นไฟล์ลับ | PASS | strip ฝั่ง นร. + lock check |
| C-BUILD-03 | ครู | แนบ libs + allowStudentInstall | default ปิด; เปิด=เฉพาะ exact allowlist | PASS | fail-closed ออฟไลน์ |
| C-BUILD-04 | ครู | เพิ่ม test 5 kinds + กดทดสอบเฉลย | เช็คโครงพร้อม (ยังไม่รันจริง) | COND-PASS | รันจริงผูก Phase 9 — แจ้งใน report ชัดเจน |
| C-BUILD-05 | ครู | save `.ztcode` / attach ห้อง | HMAC manifest; บล็อกถ้าห้องไม่เปิด/ไฟล์ >25MB | PASS | guard ROOM_NOT_OPEN + size |
| C-STU-01 | นร. | Monaco แก้หลายไฟล์ + Ctrl+Enter | รัน/ทดสอบ sample | PASS | fallback textarea ถ้าโหลด Monaco ไม่ได้ |
| C-STU-02 | นร. | autosave + submit | throttle 5 วิ + notice รอ host | PASS | teacher preview ไม่ส่งจริง |
| C-TIME-01 | นร. | หมดเวลามี draft | flush autosave code-ide ครั้งสุดท้าย | PASS | แยก kind จาก form ถูกต้อง |
| C-RESP-01 | ครู | ตาราง submissions + queue + manual | badge/status/scoreBar/manual ชนะ auto | PASS | validate 0–max |
| C-RESP-02 | ครู | Inspector diff/playback | diff เฉลย + slider ย้อน stages | PASS | LCS diff + playbackStages |
| C-RESP-03 | ครู | Export CSV/Bundle + re-grade | ได้ไฟล์ + grading-report.json | PASS | ครบ (ดู §3) |

---

## 3. Review ประเด็นที่สั่งจับตา

- **autosave / time-up flush: PASS** — ทั้งสอง workspace throttle 5 วิ (`lastAutosaveRef`), stash ทุก draft ใน `lastModuleDrafts`, `ExamView:194-209` ยิง flush ตอน phase==timeup (form→`submit-all` ข้ามถ้าว่าง, code→`autosave`) + ยิงคำตอบ text หลัก; try/catch กันสายหลุดโดย host finalize เลื่อน draft ใน DB ให้
- **ack feedback: PASS** — `exam:module-ack→exam-store.lastModuleAck→ModuleAckBanner` แสดง ✅รับงานแล้ว (progressText/kind) / ⛔ปฏิเสธ (reason) 10 วินาที ครอบคลุมทั้ง 2 modules ผ่าน `moduleSend` เดียวกัน
- **export ครบไหม: ครบ** — form: Export CSV + Save/Load `.ztresults` (±เข้ารหัส, manifest formTitle/studentCount/roomName) + regradeHistory; code: Export CSV + Export Bundle (โฟลเดอร์ นร.ครบ + grading-report.json) + เปิดโฟลเดอร์รายคน + re-grade ทั้งห้อง + queue/workspace status; ขาดแค่ปุ่ม export ของ builder ฝั่ง นร.ซึ่งไม่ควรมี (by design)
- **ข้อควรระวัง (ไม่บล็อก):** (1) form `file_upload` ยังไม่ส่งไฟล์จริงผ่าน LAN (F-1 by design — เสี่ยงครูเข้าใจผิดว่าส่งได้); (2) code "ทดสอบเฉลย" ยังเช็คแค่โครง ไม่รันจริง (Phase 9) — ครูอาจคิดว่าผ่าน=รันผ่าน; (3) ack หายใน 10 วิ + autosave เงียบ — นร.เน็ตหลุดอาจไม่รู้ว่า draft ล่าสุด flush หรือยัง (แต่ local draft ยังอยู่); (4) `.ztcode` >25MB attach ไม่ผ่าน — ครูแนบ libs หนักต้องลดไฟล์

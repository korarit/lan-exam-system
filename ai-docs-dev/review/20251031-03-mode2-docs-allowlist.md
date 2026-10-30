# รายงานทดสอบ — Mode 2 In-App Docs + Domain Allowlist (ครู + นักเรียน)

- วันที่ทดสอบ: 20251031
- ผู้ทดสอบ: Tester Agent #3 (ครู+นักเรียน Mode 2)
- โค้ดเบส: `E:\lan-exam-system`
- วิธีทดสอบ: อ่านโค้ดอย่างเดียว (static review, ไม่ได้รันแอปจริง) — สถานะด้านล่างคือ "ผลจากการอ่านโค้ด" ไม่ใช่ผลรันจริง
- ไฟล์ที่ไล่:
  - `src/renderer/src/components/HostPanel.tsx` (Doc Preview & Domain Allowlist card)
  - `src/renderer/src/core-student/DocsPanel.tsx` (toolbar ครึ่งขวา)
  - `src/renderer/src/core-student/ExamView.tsx` (split view + auto-open)
  - `src/renderer/src/store/docs-store.ts` (`exam:docs-state`)
  - `src/main/host/doc-preview.ts` (DocPreviewController)
  - `src/main/ipc/domain-handlers.ts` (`host:open-doc-preview/list/approve/set-enforcement`)
  - `src/main/browser/docs-view.ts` (DocsViewController, default-deny 3 ชั้น)
  - `src/main/browser/url-filter.ts` (`evaluateUrlAgainstWhitelist`)
  - `src/main/host/domain-allowlist.ts` + `domain-recorder.ts` (อ้างผ่าน grep)
  - `src/preload/index.ts`, `src/shared/api.ts`, `src/shared/ipc-channels.ts`, `src/shared/policy-schema.ts`

## 1. Flow ที่ไล่จากโค้ด (ครู → นักเรียน)

### 1A. ฝั่งครู (HostPanel + main)
1. สร้างห้อง → เลือกโหมด `in-app-docs` (`MODE_LABELS`, `HostPanel:32-36`) + enforcement `report-only | block-and-report` → `createRoom()` → `setDomainEnforcement(enforcement==='block-and-report' ? 'block' : 'warn')` (`HostPanel:231-232`) — ค่าเริ่มของ warn/block สืบจากห้อง ครูเปลี่ยนทีหลังได้
2. การ์ด "เตรียมเอกสาร & โดเมนที่อนุญาต" โผล่เฉพาะ `isDocsMode = room?.mode==='in-app-docs'` (`HostPanel:70,470`) — โหมดอื่นไม่เห็นเลย (ถูก)
3. กรอก URL → กด "เปิดตรวจเอกสาร" → `openDocPreview()` → `host:open-doc-preview` (`HostPanel:184-205`) — ปุ่ม disable เมื่อ `!isLobby || openingDoc || url ว่าง` (`HostPanel:495`); error mapping: `EXAM_NOT_IN_LOBBY` → "เปิดได้เฉพาะก่อนเริ่มสอบ (Lobby)", `MODE_NOT_IN_APP_DOCS` → "ใช้กับโหมด In-App Docs เท่านั้น", else → "URL ไม่ถูกต้อง (http/https)"
4. `DocPreviewController.open()` (`doc-preview.ts:43-127`): guard `ROOM_NOT_OPEN / MODE_NOT_IN_APP_DOCS / examStatus!=='lobby' → EXAM_NOT_IN_LOBBY / INVALID_URL (new URL fail หรือ protocol ไม่ใช่ http/https)` → เปิดครั้งแรกสร้าง `WebContentsView` (partition `doc-preview-${roomId}`, sandbox, no node) ใน `BrowserWindow` 1100x800 + `DomainRecorderHook.attachRecord(session)` (main frame + subresources + fetch/XHR) → เปิดซ้ำห้องเดิม reuse หน้าต่างเดิม `loadURL` ต่อ (record รวมรายการเดียว) → `did-navigate` → `recordTopUrl(topUrl)` = **โดเมนหลัก auto-approved (source=top-url)** + `pushRecords()` → `closed` → `detach + flush + push`
5. `onFlush` → `allowlist.recordBatch(sessionId)` → `pushRecords()` → event `host:recorded-domains-updated` → `setRecordedDomains` (`HostPanel:124-126`); mount ถ้า `isDocsMode` ยิง `listRecordedDomains()` หนึ่งรอบ (`HostPanel:127-129`)
6. รายการแสดง `domain/topDomain/hits/source/approved` (`domain-handlers:41-48`): แถวละ `CheckCircle2` (approved) / `CircleDashed` (pending) + ป้าย "โดเมนหลัก" ถ้า `source==='top-url'` + ป้ายแดง "ชนโดเมน AI ที่รู้จัก — โปรดตรวจเอง" ถ้า `isKnownForbiddenDomain()` (`HostPanel:39-42,549-553` — เช็ก `DEFAULT_FORBIDDEN_DOMAINS` แบบ suffix) + ข้อความ `เรียกจาก {topDomain} · {hits} ครั้ง` + ปุ่ม `อนุญาต / ยกเลิก` ต่อแถว (`approveDomain(domain, bool)` → `host:approve-domain`)
7. ปุ่ม "อนุญาตทั้งหมด" → `approveDomain({domain:'*', approved:true})` → `allowlist.approveAll(sessionId)` (`domain-handlers:60`) → notify `อนุมัติทั้งหมด (N รายการ)`; ปุ่ม disable เมื่อ `pendingDomains.length===0`; badge "รอตัดสิน N รายการ" ซ่อนเมื่อ N=0 (`HostPanel:475-479,526-533`)
8. Select "เมื่อนักเรียนใช้โดเมนนอกเหนือรายการ" → `warn (เตือน แจ้งครู ปล่อยผ่าน) / block (ตัดทันที + แจ้งครู)` → `changeDomainEnforcement()` → `setDomainEnforcement({mode})` → `allowlist.setEnforcementOverride(mode)` (`HostPanel:221-224`, `domain-handlers:78-82`)
9. `approve-domain` กลางสอบ (`examState running/collecting`) → `pushPolicyUpdate()` (เวอร์ชัน+1 เซ็นใหม่รายคน → POLICY_UPDATE ทุกเครื่องออนไลน์ทันที) (`domain-handlers:72-74`); revoke (`approved:false`) ก็ push เหมือนกัน (code ไม่แยก)
10. เริ่มสอบ → `startExam()` → นักเรียนได้ `EXAM_STARTED` พร้อม `docsUrl = getLastUrl(roomId)` (Phase 5, `doc-preview:37-40`) → ฝั่ง นร. ใช้เป็น `preferredStartUrl`

### 1B. ฝั่งนักเรียน (ExamView + DocsPanel + docs-view)
1. `ExamView` subscribe `exam:docs-state` → `useDocsStore.setDocs` (`ExamView:88-90`); `completed/time-up` → `reset()` (ปิดแผง)
2. เข้า `phase==='active'` → `enterKiosk()`; ถ้า `examMode==='in-app-docs'` + `docs===null` → `docsToggle({open:true})` อัตโนมัติครั้งเดียว (auto-open, `ExamView:187-192`)
3. Layout (`ExamView:262-279`): `hasCodeIdeModule / hasFormModule` ชนะก่อน (เต็มจอ) → else ถ้า `examMode==='in-app-docs'` → split `w-1/2 QuestionRenderer | w-1/2 DocsPanel (border-l)` → else เต็มจอ; `frozen/reconnecting` บังทั้งจอ (รวมเอกสาร) + `DocsView.setHidden(true)` fail-closed (`docs-view:161-175`)
4. `DocsPanel` (`DocsPanel.tsx` ทั้งไฟล์): ถ้า `!docs?.open` return `<div flex-1/>` (คงครึ่งขวาว่างไว้); toolbar สูง `h-11` (44px) = Home (→ `docsNavigate({url:'ztexam-docs:home'})`) + URL bar (mono, auto-prefix `https://` ถ้าไม่มี scheme, `submitUrl`) + reload + ปุ่มปิดแผง (`docsToggle({open:false})`); แบนเนอร์แดง `ไม่อนุญาตให้เข้าถึง: {blockedUrl}` ถ้ามี; พื้นที่ล่าง `data-docs-space="reserved-for-webcontentsview"` — main วาง `WebContentsView` ทับ (`DOCS_HUD_HEIGHT=100 = 56 HudBar + 44 toolbar`)
5. `DocsViewController` (`docs-view.ts`): session `nopersist:exam-docs-*`, sandbox, no devTools; `toggle(open)` ต้องมี window+policy ไม่งั้น `{ok:false}`; เปิดครั้งแรก `resolveHomeUrl()` — `preferredStartUrl` (docsUrl ครู) ต้อง `evaluateUrlAgainstWhitelist===allowed` ไม่งั้นตกไปหน้า home (`data:` รวมลิสต์โดเมนอนุมัติ); `navigate()` — `DOCS_HOME_URL` ข้าม whitelist (data url เขียนเอง), http/https เท่านั้น, `allowed → logUrl(DOCS_URL_LOG) + loadURL`, `นอก whitelist → emit UNAUTHORIZED_DOCS_URL_ATTEMPT (critical, score 40, detail {url, verdict, mode}) เสมอ` + ถ้า `block → lastBlockedUrl + หน้า BLOCKED_PAGE_HTML`, ถ้า `warn → return {off-whitelist}` เฉยๆ (ไม่โชว์หน้าเตือน, ดู 2.6)
6. ดัก 3 ชั้น (`attachInterceptors`): `setWindowOpenHandler` (deny popup เสมอ, allowed → load ในกรอบเดิม) → `will-navigate/will-redirect` (block เท่านั้นถึง preventDefault + โชว์หน้าแดง; warn ปล่อยโหลดต่อแต่ report ไปแล้ว) → `webRequest.onBeforeRequest` (ทุก resource; block → cancel; warn → ผ่าน; log เฉพาะ mainFrame เพื่อลด noise) → `did-navigate/did-start-navigation` อัปเดต `lastUrl` + `pushState({open, url, allowedDomains, enforcement, blockedUrl})` → renderer sync URL bar
7. `data:/about:` ที่ controller เขียนเอง (home/blocked page) ถูกยกเว้นจาก `reportAttempt` (`docs-view:384`)

## 2. Testcases (อ่านโค้ด)

| รหัส | บทบาท+ขั้นตอน | ข้อมูล | ผลคาดหวัง | ผลจากการอ่านโค้ด | สถานะ |
|---|---|---|---|---|---|
| TC-D01 | ครู: สร้างห้องโหมด in-app-docs | roomName+mode+enforcement | เห็นการ์ดเตรียมเอกสาร | `isDocsMode` gate (`HostPanel:470`) ตรง; `domainEnforcement` ตั้งต้นตามห้อง (`HostPanel:232`) | ผ่าน |
| TC-D02 | ครู: สร้างห้องโหมด closed/external-tools | — | ไม่เห็นการ์ดเอกสาร | การ์ด render เฉพาะ `isDocsMode` ตรง | ผ่าน |
| TC-D03 | ครู: กดเปิดตรวจเอกสารตอน URL ว่าง | `docUrl=''` | ปุ่มกดไม่ได้ | `disabled={...docUrl.trim().length===0}` (`HostPanel:495`) ตรง | ผ่าน |
| TC-D04 | ครู: เปิด URL ผิด scheme | `ftp://x`, `file:///x`, `not-a-url` | แจ้ง "URL ไม่ถูกต้อง" | main guard protocol http/https + try new URL (`doc-preview:49-57`) + renderer mapping fallback (`HostPanel:197`) ตรง | ผ่าน |
| TC-D05 | ครู: เปิด Doc Preview กลางสอบ (running) | examStatus!=='lobby' | ถูกปฏิเสธ "เปิดได้เฉพาะ Lobby" | `room.examStatus!=='lobby'` (`doc-preview:48`) + mapping `EXAM_NOT_IN_LOBBY` (`HostPanel:193`) ตรง | ผ่าน |
| TC-D06 | ครู: เปิดหลายเว็บต่อเนื่องก่อนสอบ | docs.python.org → developer.mozilla.org | หน้าต่างเดิม reuse + โดเมนรวมรายการเดียว | `isOpen&&view → loadURL ต่อ` (`doc-preview:60-64`) + recorder ตัวเดียวต่อ session ตรง | ผ่าน |
| TC-D07 | ครู: ดูรายการ record | เปิด docs มี CDN/fonts/XHR | เห็น domain/topDomain/hits/source/approved + push อัตโนมัติ | `DomainRecorderHook + onFlush→recordBatch→pushRecords→host:recorded-domains-updated` (`doc-preview:105-114,141-159`) ตรง; mount `listRecordedDomains` ครั้งเดียว (`HostPanel:127-129`) | ผ่าน |
| TC-D08 | ครู: โดเมนหลัก auto-approved | เปิด `https://docs.python.org/...` | `docs.python.org` มีป้าย "โดเมนหลัก" + approved แล้ว | `recordTopUrl` (`doc-preview:111-114`) + ป้าย `source==='top-url'` (`HostPanel:554-556`) ตรง | ผ่าน (เสี่ยง — ดู R2) |
| TC-D09 | ครู: approve รายโดเมน | กด "อนุญาต" แถว pending | แถวเปลี่ยนเป็นเขียว + ปุ่มเป็น "ยกเลิก" | `approveDomain(domain,true)` → `setApproved` (`domain-handlers:62`) ตรง | ผ่าน |
| TC-D10 | ครู: revoke รายโดเมน | กด "ยกเลิก" แถว approved | กลับเป็น pending | `approveDomain(domain,false)` ตรง; log `DOMAIN_REVOKED_` (`domain-handlers:69`) | ผ่าน |
| TC-D11 | ครู: อนุมัติทั้งหมด | pending N รายการ → กดปุ่ม | notify "อนุมัติทั้งหมด (N)" + pending=0 + ปุ่ม disable | `domain:'*'` → `approveAll` + `updatedCount` (`domain-handlers:58-60`, `HostPanel:214-219,528`) ตรง | ผ่าน (เสี่ยง — ดู R1) |
| TC-D12 | ครู: เปิด docs ชนโดเมน AI | record เจอ `chatgpt.com / *.openai.com` | เห็นป้ายแดงเตือน | `isKnownForbiddenDomain` suffix-match (`HostPanel:39-42,549`) ตรง | ผ่าน (เสี่ยง — ดู R3) |
| TC-D13 | ครู: สลับ warn ↔ block | เลือกใน select | ฝั่ง นร. เปลี่ยนพฤติกรรมทันที (policy ปัจจุบัน) | `setDomainEnforcement → setEnforcementOverride` (`domain-handlers:78-82`); docs-view อ่าน `getPolicy().enforcement` ทุกครั้ง ตรง | ผ่าน |
| TC-D14 | ครู: approve/revoke กลางสอบ | running + กดอนุญาต | นักเรียนได้ POLICY_UPDATE ทันที | `pushPolicyUpdate()` เมื่อ running/collecting (`domain-handlers:72-74`) ตรง | ผ่าน |
| TC-D15 | นร: เริ่มสอบ Mode 2 | `phase=active, examMode=in-app-docs` | split โจทย์ซ้าย/เอกสารขวา + เปิดแผงอัตโนมัติ | `w-1/2 + DocsPanel` (`ExamView:271-279`) + auto `docsToggle open:true` เมื่อ `docs===null` (`ExamView:187-192`) ตรง | ผ่าน (เสี่ยง — ดู R5) |
| TC-D16 | นร: หน้าแรกเอกสาร (ครูเตรียม docsUrl ไว้ + อยู่ใน allowlist) | docsUrl=`https://docs.python.org/...` approved | เปิดมาหน้า docsUrl เลย | `resolveHomeUrl: preferred→verdict allowed→return preferred + logUrl` (`docs-view:240-261`) ตรง | ผ่าน |
| TC-D17 | นร: หน้าแรกเอกสาร (ครูไม่เคยเปิด preview / docsUrl นอก allowlist) | `preferredStartUrl=null` หรือโดน deny | ตกไปหน้า home รวมลิงก์อนุมัติ | `resolveHomeUrl` fallback `DOCS_HOME_HTML` ตรง; home ว่างโชว์ "ครูยังไม่ได้อนุญาตโดเมนใด" (`docs-view:63`) | ผ่าน |
| TC-D18 | นร: พิมพ์ URL ใน allowlist ใน URL bar | `docs.python.org/...` | โหลด + มี DOCS_URL_LOG | `navigate: allowed→logUrl+loadURL` (`docs-view:204-213`) ตรง; ไม่มี scheme เติม `https://` เอง (`DocsPanel:29`) | ผ่าน |
| TC-D19 | นร: พิมพ์ URL นอก allowlist โหมด warn | `https://chatgpt.com/` + enforcement=warn | ฟ้อง critical ไปเครื่องแม่ + **ยังโหลดหน้าต่อนอก allowlist** | `navigate: emit เสมอ + return off-whitelist` แต่ไม่ cancel (`docs-view:215-236`); `will-navigate/onBeforeRequest` тожеปล่อยเมื่อ warn (`docs-view:329,347`) — **warn = detect-only จริง** | ผ่าน (เสี่ยง — ดู R4) |
| TC-D20 | นร: พิมพ์ URL นอก allowlist โหมด block | เหมือน TC-D19 + block | โดนตัด + เห็นหน้าแดง + แบนเนอร์ `blockedUrl` + ฟ้องครู | `navigate→lastBlockedUrl+BLOCKED_PAGE` + `will-navigate preventDefault + showBlockedPage` + `onBeforeRequest cancel` + `pushState blockedUrl → DocsPanel:81-86` ตรง | ผ่าน |
| TC-D21 | นร: คลิกลิงก์ออกนอก allowlist / popup / redirect / XHR | ลิงก์ใน docs ชี้ออก | เหมือน TC-D19/D20 ตามโหมด (3 ชั้นดักครบ) | `setWindowOpenHandler deny + judge`, `will-navigate/redirect`, `onBeforeRequest (mainFrame+subFrame+XHR)` (`docs-view:316-352`) ตรง | ผ่าน |
| TC-D22 | นร: ใช้ IP ตรงแทนชื่อโดเมน | `http://192.168.0.15/notes.html` | verdict `direct-ip` + ฟ้อง critical (+block ตัด) | `evaluateUrlAgainstWhitelist → direct-ip` (`url-filter.test:38-39`) + `reportAttempt(target, verdict)` ตรง | ผ่าน |
| TC-D23 | นร: กด Home / Reload / ปิดแผง | toolbar 3 ปุ่ม | Home→ลิสต์อนุมัติ (ไม่ผ่าน whitelist), Reload→โหลด url ปัจจุบัน, ปิด→ครึ่งขวาว่าง | `DOCS_HOME_URL` ข้าม whitelist (`docs-view:180-191`), reload `docsNavigate({url:docs.url})`, close `docsToggle false → !open → div flex-1` (`DocsPanel:24,40,62-76`) ตรง | ผ่าน (เสี่ยง — ดู R6) |
| TC-D24 | นร: หลุดเชื่อมต่อกลางสอบ | frozen/reconnecting | โจทย์+เอกสารถูกซ่อน (fail-closed) | `ExamView:247-254` บังทั้งจอ + `setHidden(true)` ถอด view (`docs-view:161-175`) ตรง | ผ่าน |
| TC-D25 | นร: จบสอบ (completed/time-up) | — | แผงเอกสาร reset | `onCompleted→reset + time-up→reset` (`ExamView:82-86`) + `destroy()` ถอด view ตรง | ผ่าน |
| TC-D26 | นร: ปิดแผงแล้วเปิดใหม่ (HudBar toggle) | กดปุ่มเอกสารใน HudBar | เปิด/ปิดได้ (เฉพาะ Mode 2) | `HudBar:80 docsToggle({open:!docsOpen})` + `toggle()` ต้องมี policy+window (`docs-view:130-158`) ตรง | ผ่าน |

## 3. Review ปัญหา UX / ความปลอดภัย

- **R1 (High — approve-all กวาด AI/CDN หลุด):** `approveAll` อนุมัติทุก pending ครั้งเดียว (`domain-handlers:60`) + ปุ่มอยู่ติดหัวรายการ (`HostPanel:526-533`) — ถ้า docs ดึงสคริปต์โฆษณา/tracker/AI-assist ปนมา ครูกดทีเดียวหลุดหมด รวมกับป้าย AI ที่เป็นแค่ label (R3) ยิ่งเสี่ยง → เสนอ: ยืนยันสองชั้น + แสดงจำนวน/รายชื่อที่จะอนุมัติ + แยกหมวด `top-url / cdn-static / api-xhr` + ห้าม approve-all ถ้ามีแถวชน AI (บังคับติกรายตัว)
- **R2 (High — top-url auto-approved + reuse window):** โดเมนของ URL ชั้นบนอนุมัติอัตโนมัติ (`doc-preview:110-114`) และเปิด URL ที่สอง reuse หน้าต่างเดิมรวมรายการเดียว — ครูเผลอเปิดเว็บผิด (เช่น เสิร์ชแล้วหลงไปเว็บ AI) โดเมนนั้น approved ทันทีโดยไม่ต้องกด → เสนอ: top-url เริ่มต้นเป็น pending เหมือนกัน (หรือ approved แต่ไฮไลต์ + ปุ่ม revoke ชัด) + ปุ่ม "ล้างรายการ/เริ่ม record ใหม่" ต่อห้อง + แสดง URL ต้นทางที่ทำให้เกิดแต่ละโดเมน
- **R3 (High — AI domain warning ไม่ขวาง):** `isKnownForbiddenDomain` เป็นแค่ `<span>` ข้อมูล "ระบบไม่ขวาง — ให้ครูสังเกตเอง" (`HostPanel:38,549-553`) — ครูไม่สังเกต = AI domain ผ่าน approve-all (R1) เข้า Signed Policy ได้เลย → เสนอ: ถ้าแถวชน `DEFAULT_FORBIDDEN_DOMAINS` ให้ default เป็น blocked + ต้องพิมพ์ยืนยัน/ติ๊ก "รับทราบความเสี่ยง" รายตัว + audit log ระบุชื่อครู/เวลา (ปัจจุบันแค่ `console.info DOMAIN_APPROVED_*`, `domain-handlers:66-70`)
- **R4 (Medium — warn = ปล่อยโหลดต่อ):** warn mode emit critical แต่ไม่ cancel (`docs-view:215-236,329,347`) — นักเรียนเปิด AI/เว็บนอกได้จริงทั้งหน้า (แค่ครูได้ event) ชื่อ select "เตือน (แจ้งครู — ปล่อยผ่าน)" ตรงความจริงแล้ว แต่ครูอาจเข้าใจว่า "เตือนนักเรียน" → เสนอ: เปลี่ยนข้อความ UI เป็น "ตรวจจับอย่างเดียว — ไม่บล็อก (นักเรียนยังเข้าได้)" + ฝั่ง นร. ควรมีแบนเนอร์เหลือง "เว็บนี้อยู่นอกเอกสารที่อนุญาต — ครูได้รับแจ้งแล้ว" (ปัจจุบันแบนเนอร์แดงมีเฉพาะ block, `DocsPanel:81-86`)
- **R5 (Medium — auto-open + ปิดแผงได้เอง):** `ExamView:187-192` เปิดเอกสารอัตโนมัติ (ดี) แต่นักเรียนกดปิดแผงเองได้ (`DocsPanel:73`, `HudBar:80`) แล้วสอบต่อด้วยโจทย์ครึ่งเดียวโดยไม่มีบังคับเปิด — อาจใช้บังหน้า? → เสนอ: ถ้าปิดแผงให้โจทย์ขยายเต็มจอชัดเจน (ปัจจุบัน `!open → div flex-1` ว่างเปล่าครึ่งขวา) หรือนโยบาย "ห้ามปิด" ต่อห้อง + log `docsToggle close` เป็น event ให้ครูเห็น
- **R6 (Low — reload URL นอก allowlist ค้าง):** ปุ่ม reload ยิง `docsNavigate({url: docs.url})` ตรงๆ (`DocsPanel:64`) — ถ้า `docs.url` ค้างเป็น URL ที่เคย allowed แต่เพิ่งโดน revoke กลางสอบ (POLICY_UPDATE) การ reload จะ `off-whitelist` เงียบๆ (warn: ไม่มี feedback; block: หน้าแดง) → เสนอ: disable reload เมื่อ url ไม่อยู่ใน `allowedDomains` ปัจจุบัน + toast อธิบาย
- **R7 (Low — list โหลดครั้งเดียว + key ซ้ำ):** `listRecordedDomains` ยิงแค่ตอน mount ถ้า `isDocsMode` (`HostPanel:127-129`, dep `[]`-ish) — ถ้าครูสร้างห้องหลัง mount หรือ preview เปิดจากเครื่องอื่น รายการไม่อัปเดตจนกว่าจะมี flush push; key แถว `${domain}|${topDomain}|${source}` (`HostPanel:539`) ชนได้ถ้าโดเมนเดียวถูกเรียกจากหลาย top → เสนอ: refetch เมื่อ `room` เปลี่ยน + รวมแถวซ้ำเป็น `topDomains: string[]` หรือ key รวม hits
- **R8 (Low — ความไม่สอดคล้อง toolbar/bounds):** comment `DocsPanel:35` บอก main อ้าง `DOCS_HUD_HEIGHT=100 (56+44)` ตรงกับ `h-11` แล้ว (โอเค) แต่ placeholder "หน้าเอกสารจะปรากฏตรงนี้" (`DocsPanel:93-101`) จะถูก WebContentsView ทับมิด — ถ้า view สร้างช้า/ล้มเหลว นักเรียนเห็นข้อความนี้ค้างโดยไม่มีปุ่ม retry → เสนอ: สถานะ loading/error จาก `pushState` (เช่น `open=true แต่ view ว่าง`) + ปุ่ม "เปิดเอกสารอีกครั้ง"

## 4. สรุปผล

- Flow ครู (เลือก in-app-docs → preview เฉพาะ Lobby → record รวม → approve/revoke/all + warn/block → POLICY_UPDATE กลางสอบ) และ flow นักเรียน (split view + auto-open + home/docsUrl + default-deny 3 ชั้น + fail-closed + reset ตอนจบ) **ตรงสเปก Phase 3a-plus/Phase 5 จากการอ่านโค้ดทั้งหมด 26 เคส (TC-D01–D26) ผ่าน**
- ความปลอดภัยหลักดี: **default-deny** (`evaluateUrlAgainstWhitelist`, allowlist ว่าง = deny หมด), sandbox+`nopersist` session แยกห้อง, ดัก navigation 3 ชั้น + รายงาน `UNAUTHORIZED_DOCS_URL_ATTEMPT (critical)` ทุกครั้งแม้โหมด warn, IP ตรง = `direct-ip` โดนด้วย, preview ล็อกเฉพาะ Lobby+Mode 2
- จุดต้องแก้ก่อนใช้จริง: **(1) approve-all + top-url auto-approve + AI-warning ที่ไม่ขวาง = ช่องหลุด AI/trackers ใหญ่สุด** (R1–R3), **(2) warn mode ปล่อยโหลดจริง + ไม่มีแบนเนอร์ฝั่ง นร.** (R4), **(3) นักเรียนปิดแผงเอกสารเองได้โดยครูไม่รู้** (R5) — ที่เหลือ R6–R8 เป็น UX เล็กน้อย

# ทดสอบ Dashboard Triage + Screen Monitoring (มุมครูผู้คุมสอบ) — ZT-Exam

วันที่ทดสอบ: 20251031
ผู้ทดสอบ: Tester Agent #4 (ครูผู้คุม)
ขอบเขต: `TriageDashboard.tsx`, `TriageSummaryHeader.tsx`, `StudentTriageCard.tsx`, `EvidenceTimelineDrawer.tsx`, `ProctorScreenModal.tsx`, `store/triage-store.ts`, `store/screen-store.ts`, `core-student/ProctorOverlay.tsx` + IPC `host:guard-events`, `host:resolve-triage`, `host:send-proctor-warning`, `host:set-student-freeze`, `host:screen-inspect`, `host:pin-screen-buffer`, `host:export-incident-report`, `host:export-audit-bundle`, audit chain `PROCTOR_VIEWED_SCREEN`
วิธีทดสอบ: Static review + trace code path (ไม่ได้รันสอบจริง, ไม่แก้โค้ด)

## 1. Flow ที่ไล่ได้จริง (Guard → Triage → Action → Screen → Audit)

1. Guard event เข้าเครื่องแม่: `core-session-manager.ts:522` / `main/index.ts:714` ยิง `host:guard-events` → `HostPanel.tsx:113` ฟิลเตอร์เฉพาะ `severity==='critical'` แล้ว `notify({severity:'critical'})` เป็น toast แดงทันที
2. Triage scoring: `triage-engine.ts:303-344` — `activeSuspicionScore` = ผลรวม score ของ alert ที่ยังไม่ `cleared`; `resolveTriageLevel`: critical = `unackCritical>0 || score>=40`, warning = `score>=15 || unackWarning>0`, นอกนั้น normal; sort ด้วย `compareTriagePriority` (critical → disconnected → warning → normal, แล้วคะแนนมากก่อน)
3. Event dedup: `triage-engine.ts:151` เหตุการณ์เดิม (คนเดิม/โค้ดเดิม/หลักฐานเดิม) ใน `correlationWindowMs` ได้ `scoreDeltaApplied=0` ไม่บวกคะแนนซ้ำ — แต่ถ้า `pid` เปลี่ยน = บวกใหม่ทันที
4. Dashboard: `TriageDashboard.tsx:55-79` subscribe `host:triage-updated` + `getTriageOverview()` ครั้งแรก, filter ผ่าน `matchesTriageFilter` + search ชื่อ/รหัส; การ์ดคนแดงมี `ring-1 ring-red-700` + badge `รอตรวจ N` (`StudentTriageCard.tsx:107-112`) + คะแนนสีแดงเมื่อ ≥40
5. เปิดหลักฐาน: กด `ดูหลักฐาน` → `selectedStudentId` → `EvidenceTimelineDrawer` เรียก `getStudentEvidence` แสดง info เครื่อง (online/focus/VM/Remote/joined/lastSeen) + `Hash Chain Verified/TAMPERED` + Timeline เรียงล่าสุดขึ้นบน พร้อม `+N คะแนน`, `eventCode`, `details.technique JSON`, `seq/hash`
6. Action ผู้คุม (3 ทางใน Drawer + 1 บนการ์ด):
   - `sendProctorWarning` (maxLength 300) → ฝั่ง นร. `ProctorOverlay.tsx` แบนเนอร์เหลืองบนจอ 10 วินาทีแล้วหาย (`WARNING_VISIBLE_MS`)
   - `setStudentFreeze` toggle → ฝั่ง นร. overlay เต็มจอ `z-[60]` + blur บอก "ห้ามปิดแอป" จนกว่าจะปลด; บนการ์ดมี badge `แช่แข็ง` และปุ่ม Freeze/ปลด
   - `resolveTriage({resolution:'cleared'|'confirmed', note≤500})` → toast "ลง audit chain แล้ว / ปักหมุดหลักฐานแล้ว" + reload evidence
7. ดูจอ: กด `ดูหน้าจอ` / คลิก thumbnail → `ProctorScreenModal` — mount ปุ๊บยิง `screenInspect({mode:'playback'})` ทันที, unmount ยิง `mode:'stop'`; สลับ `live (720p UDP)` ↔ `playback (5 นาที)` ผ่าน `switchMode`; multi-display มี tab `Display 1/2`; thumbnail บนการ์ดคลิกได้ (`StudentTriageCard.tsx:91-100`)
8. Timeline 5 นาที: block segment (ฟ้า, เหลืองถ้า pinned) + ขีด alert (แดง/เหลืองจาก `overview.alerts` ใน window) + countdown "ถูกเขียนทับในอีก M:SS"; คลิก = `fetchRingSegment` pull-on-demand, `fetching` มี spinner; โหมด live มี follow-live + `กลับไปดูสด` + auto-advance `onEnded→advanceToNext`
9. Pin หลักฐาน: ปุ่ม `Pin ล็อกหลักฐาน` → `pinScreenBuffer({reason:'PROCTOR_PIN-DASHBOARD'})` กัน segment ถูก ring overwrite
10. Audit: `proctor-view-service.ts:224` เปิด modal ทุกครั้งบันทึก `PROCTOR_VIEWED_SCREEN` ลง hash chain อัตโนมัติ; `resolveTriage`/freeze/warn ก็ลง chain ผ่าน `triage-service.ts`/`audit-log.ts`; export ท้ายสอบผ่าน `TriageSummaryHeader` ปุ่ม `รายงานเหตุการณ์ (HTML)` / `.ztaudit` — ถูก disable จนกว่า `canExport` (หลังสอบ) และมี `exporting` กันกดซ้ำ; `host:exam-completed` ล้าง thumbnails ทั้งหมด (`TriageDashboard.tsx:38`)

## 2. Testcases (มุมครูคุมสอบ)

| ID | สถานการณ์ | ขั้นตอน | ผลคาดหวัง | ผล review (โค้ดจริง) | ระดับ |
|---|---|---|---|---|---|
| TRI-01 | นร.เปิดโปรแกรมต้องห้าม 1 คน | จำลอง `BLACKLISTED_PROCESS_DETECTED critical score 45` | toast แดง + การ์ดแดงขึ้นบนสุด + badge รอตรวจ 1 + คะแนนแดง 45 | ผ่านตามโค้ด `HostPanel:113-122`, `resolveTriageLevel` | P0 |
| TRI-02 | เหตุการณ์ซ้ำ poll ถี่ๆ | ส่ง event เดิมซ้ำใน correlation window | คะแนนไม่บวกซ้ำ, occurrenceCount ขึ้น | ผ่าน `scoreDeltaApplied=0` | P1 |
| TRI-03 | โปรเซสเปิดใหม่ pid เปลี่ยน | ส่ง event เดิมแต่ pid ใหม่ | บวกคะแนนใหม่ทันที | ผ่านตามคอมเมนต์ engine | P1 |
| TRI-04 | หลายคนแดงพร้อมกัน 5 คน | ดู dashboard | เรียง critical มากสุด/คะแนนมากสุดก่อน, ไม่ใช่ผังที่นั่ง | ผ่าน `compareTriagePriority` | P0 |
| TRI-05 | filter + search ตอนวิกฤต | กด filter `วิกฤต` + พิมพ์รหัส | เห็นเฉพาะคนแดงตรง search | ผ่าน `matchesTriageFilter` + search | P1 |
| TRI-06 | ปิดเสียงเตือน | กดปุ่มลำโพง mute | ไม่ต้องทนเสียง alert รัวๆ (แต่ toast ยังมา) | ผ่าน — มี `muted` state แต่**ไม่พบ wiring ใช้ muted กับ notify จริง** ⚠️ | P1 Bug? |
| TRI-07 | เปิด evidence timeline | กด `ดูหลักฐาน` | เห็น info/chain/timeline/scoreDelta/technique JSON | ผ่าน | P0 |
| TRI-08 | chain ถูกแก้ไข | mock `chain.valid=false` | แบนเนอร์แดง `TAMPERED seq ?` | ผ่าน `EvidenceTimelineDrawer:140-152` | P0 |
| TRI-09 | ส่ง warn ขึ้นจอ นร. | พิมพ์ข้อความ ≤300 กดส่ง | จอ นร.แบนเนอร์เหลือง 10 วิแล้วหาย, ปุ่ม disabled ถ้าว่าง | ผ่านทั้ง 2 ฝั่ง | P0 |
| TRI-10 | Freeze ฉุกเฉินจากการ์ด | กด Freeze บนการ์ดคนออฟไลน์ | ปุ่ม disabled (`!online`) กดไม่ได้ — ต้องใช้วิธีอื่น (เดินไปหา) | ผ่าน (`disabled={!online}`) — ถูกต้องแต่ต้องมีคู่มือ | P1 |
| TRI-11 | Freeze → ปลดจาก Drawer | กด Freeze/ปลดใน Drawer | toast critical/info + reload evidence + badge แช่แข็ง | ผ่าน | P0 |
| TRI-12 | mark reviewed + note | เลือก cleared/confirmed + note แล้วยิงซ้ำ | toast เคลียร์ N เหตุการณ์/ปักหมุด + note ลง chain | ผ่าน — แต่**ไม่มี confirm dialog กันกดผิด** ⚠️ | P1 |
| TRI-13 | เปิด Screen Inspector | กด `ดูหน้าจอ` | ยิง playback ทันที + ลง `PROCTOR_VIEWED_SCREEN` audit อัตโนมัติ | ผ่าน `proctor-view-service:224` | P0 |
| TRI-14 | สลับ live/playback | กดสลับโหมด | reset segment/follow + ยิง inspect ใหม่, live มี fallback JPEG ถ้า UDP ไม่พร้อม | ผ่าน | P1 |
| TRI-15 | ดูย้อนหลัง + alert marker | คลิก segment ตรงขีดแดง | ดึง webm มาเล่น, spinner ระหว่างดึง, marker มี title | ผ่าน | P0 |
| TRI-16 | Pin กันหลักฐานหายก่อนหมด 5 นาที | กด Pin | segment เหลืองค้าง ไม่โดน overwrite + มี countdown เตือน | ผ่าน | P0 |
| TRI-17 | ปิด modal ระหว่างดึง | ปิดขณะ `fetching` | ยิง `mode:stop`, ไม่มีค้าง (แต่ `fetching` อาจค้างถ้า promise reject เงียบ — มี catch reset แล้ว) | ผ่านแบบมีข้อควรระวัง | P2 |
| TRI-18 | จบสอบแล้ว export | กด export HTML/.ztaudit หลังสอบ | ไฟล์ออก + toast path, ระหว่างสอบปุ่ม disabled | ผ่าน `canExport/exporting` | P0 |
| TRI-19 | นร.อ้างว่าไม่เห็น warn ตอน frozen | ส่ง warn ขณะ frozen | โค้ดซ่อน warn เมื่อ frozen (`warning && !frozen`) — นร.ไม่เห็นจริง | ผ่านตามโค้ด = **เสี่ยงข้อพิพาท ต้องส่งซ้ำหลังปลด** ⚠️ | P1 |
| TRI-20 | Thumbnail ค้างหลังจบสอบ | จบสอบ | `clearAllThumbnails` ล้างหมด | ผ่าน | P2 |

## 3. Review มุมครูคุมสอบ

**Alert fatigue:** เกณฑ์แดงเชื่อง่าย (`unackCritical>0` = แดงทันทีแม้คะแนน 5) + toast ทุก critical + ไม่มี grouping/ack จาก toast — ห้อง 30-40 คนเจอพร้อมกันครูไล่ไม่ทัน; `muted` มี state แต่ไม่เห็นผูกกับเสียง/toast จริง (TRI-06) ควรผูก + เพิ่ม "ack ทั้งหมด" / กรองตาม severity; countdown 5 นาที + badge `รอตรวจ N` ช่วยได้แต่ยังไม่มี auto-escalate

**การจัดการวิกฤต:** Freeze จากการ์ด disabled ตอนออฟไลน์ถูกต้อง (กันกดลม) แต่ครูต้องมี playbook สำรอง; Freeze overlay ฝั่ง นร.ชัดเจน + ห้ามปิดแอป; ไม่มี confirm ก่อน `resolve confirmed` เสี่ยงกดผิดแล้วปักหมุดถาวร — ควรมี modal ยืนยัน; live มี fallback JPEG ดี, follow-live + `กลับไปดูสด` ใช้งานจริงได้

**ความเป็นส่วนตัว:** เปิดดูจอ = ลง audit อัตโนมัติ + header แจ้งชัด — ดีมาก; แต่ thumbnail แสดงบนการ์ดทุกใบโดยไม่ต้อง audit (ดูได้โดยไม่เปิด modal) อาจถือว่าแอบดู — ควร audit ตั้งแต่ thumbnail ingest หรือเบลอจนกว่ากดดู; playback ดึงจากเครื่อง นร. ตรง (pull-on-demand) ไม่มี consent banner ฝั่ง นร. ควรมีไฟสถานะ "ครูกำลังดูจอ"

**Audit:** chain verified/tampered แสดงชัด + seq/hash/evidence JSON ครบ + export HTML/.ztaudit ล็อกหลังสอบกันหลุดระหว่างสอบ — ดี; จุดอ่อน: note/warn จำกัดความยาวฝั่ง UI อย่างเดียว (500/300) ต้องมี validate ฝั่ง main ด้วย, `setStudentFreeze` จากการ์ด `.catch(()=>undefined)` กลืน error เงียบ (Drawer มี toast แต่การ์ดไม่มี) ครูอาจคิดว่า freeze แล้วแต่จริงไม่สำเร็จ

**สรุป:** Flow หลักครบใช้คุมสอบได้จริง (detect→แดง→evidence→warn/freeze/review→screen+pin→audit/export) แต่ควรแก้ 3 เรื่องก่อนใช้จริง: (1) ผูก `muted` + ลด alert รัว, (2) confirm ก่อน confirmed/freeze + toast error บนการ์ด, (3) privacy/audit ของ thumbnail + ไฟเตือนฝั่ง นร.ว่าถูกดูจอ

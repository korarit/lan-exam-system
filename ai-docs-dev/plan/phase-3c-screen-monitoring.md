# Phase 3c: Screen Monitoring (Thumbnails, 5-Min Ring Buffer & Pull-on-Demand)

## 1. เป้าหมายและขอบเขต (Objectives & Scope)
เสริมการทำงานของ Dashboard Triage (Phase 3b) ให้ผู้คุมสอบเห็นภาพหน้าจอของนักเรียนได้ครบทุกจอ (Multi-display) โดยมี **ภาพย่อ (Thumbnail ~1 fps)** สำหรับดูภาพรวม และมี **Ring Buffer วิดีโอความละเอียดสูงย้อนหลัง 5 นาที** ที่เก็บแบบเข้ารหัสไว้ในเครื่องนักเรียนเอง เมื่อผู้คุมคลิกเรียกดูเครื่องไหน เครื่องนักเรียนจึงจะสตรีมภาพย้อนหลังและภาพสดส่งมาที่เครื่องแม่ทันที (Pull-on-Demand)

### สิ่งที่ต้องได้เมื่อจบ Phase 3c
- จับภาพครบทุกหน้าจอที่เชื่อมต่ออยู่กับเครื่องนักเรียน (แยกต่อ Display)
- ส่งภาพย่อขนาดเล็ก (~1 fps, JPEG/WebP บีบอัด) ผ่านท่อ TLS ไปแสดงบนการ์ดใน Dashboard ครูโดยไม่กินแบนด์วิดท์
- บันทึกวิดีโอหน้าจอเป็นเซกเมนต์สั้นๆ เซกเมนต์ละ **10 วินาที** หมุนวนเก็บไว้เฉพาะ **5 นาทีล่าสุด (30 เซกเมนต์ต่อจอ)** เข้ารหัสด้วย AES-256-GCM บนเครื่องนักเรียน และลบทิ้งทั้งหมดเมื่อจบสอบ
- ระบบ **Pin on Critical:** เมื่อเกิดเหตุการณ์วิกฤต (สีแดงจาก Phase 3a) ให้ล็อกเซกเมนต์ก่อนหน้าและขณะเกิดเหตุไม่ให้ถูกเขียนทับ
- หน้าต่าง **Screen Inspector** บนเครื่องแม่: ดูภาพสดความละเอียดสูง หรือเลื่อนดูวิดีโอย้อนหลัง 5 นาทีของนักเรียนคนที่เลือกได้ทันที พร้อมบันทึกการเปิดดูลง Audit Log

---

## 2. การแบ่งงานย่อย (Detailed Sub-phases)

### 3c.1 Multi-Display Enumeration & Platform Permission Check (`src/main/screen/capture-manager.ts`)
1. **การตรวจสอบสิทธิ์และสภาพแวดล้อมก่อนเริ่มสอบ:**
   - **Windows:** ใช้งาน `desktopCapturer.getSources({ types: ['screen'] })` ได้ทันทีโดยไม่ต้องขอสิทธิ์เพิ่ม
   - **macOS:** ตรวจสอบ `systemPreferences.getMediaAccessStatus('screen')` ตอนอยู่ในหน้า Lobby:
     - หากสถานะไม่ใช่ `'granted'` ให้ขึ้นหน้าจอแนะนำให้นักเรียนเปิดสิทธิ์ Screen Recording ก่อนจึงจะกดพร้อมเริ่มสอบได้ (และแจ้งสถานะให้เครื่องแม่เห็น)
   - **Linux:** ตรวจสอบ `process.env.XDG_SESSION_TYPE`:
     - หากเป็น `'x11'` สามารถจับภาพทุกจอได้โดยตรง
     - หากเป็น `'wayland'` ให้แจ้งเตือนบนหน้าจอและส่งสถานะบอกเครื่องแม่ว่าต้องใช้ X11 session เพื่อจับภาพหน้าจอแบบอัตโนมัติโดยไม่ติดหน้าต่างขออนุญาตของ PipeWire Portal
2. **การจัดการเรื่อง `setContentProtection` ชนกับการจับภาพหน้าจอ:**
   - ตั้งค่าใน `RoomPolicy`: `screenProtectionMode: 'allow-proctor-stream' | 'strict-os-content-protection'`
   - ค่าเริ่มต้นคือ `'allow-proctor-stream'` (`win.setContentProtection(false)`) เพื่อให้ผู้คุมสอบมองเห็นหน้าต่างข้อสอบและหน้าต่างอื่นบนหน้าจอนักเรียนได้ครบ 100% ไม่กลายเป็นกรอบสีดำ (โดยอาศัย `OverlayInspector` และ `ProcessInspector` จาก Phase 3a คอยตรวจจับโปรแกรมอัดหน้าจอของนักเรียนแทน)
3. **การจับครบทุกหน้าจอ (Multi-Monitor Support):**
   - ใช้ `screen.getAllDisplays()` คู่กับ `desktopCapturer.getSources({ types: ['screen'] })`
   - ผูก `display_id` ของแต่ละจอเข้ากับ Stream แยกกัน หากนักเรียนเสียบ 2 จอ ทั้ง 2 จอจะถูกจับภาพและบันทึกแยกกันครบทั้งหมด

---

### 3c.2 Low-Bandwidth Live Thumbnail Streamer (~1 fps) (`src/renderer/src/student/screen-worker.ts`)
1. **การสร้างภาพย่อ (Thumbnail Capture):**
   - ทุกๆ `1000 ms` (หรือปรับลดเป็น `2000 ms` อัตโนมัติหากห้องสอบมีนักเรียนเกิน 50 เครื่องตามคำสั่งเครื่องแม่):
   - ย่อขนาดเฟรมปัจจุบันของแต่ละจอลงเหลือความกว้าง `320px` (เช่น `320x180`) บน OffscreenCanvas
   - บีบอัดเป็น `image/webp` หรือ `image/jpeg` ที่ `quality: 0.55` (ขนาดต่อเฟรมจะอยู่ที่ประมาณ `8 - 15 KB` เท่านั้น สำหรับ 40 เครื่องจะใช้แบนด์วิดท์รวมกันเพียง ~0.5 MB/s)
2. **การส่งผ่าน TLS Binary Frame:**
   - ส่งผ่าน Binary Frame (`FrameType = 0x02`) ชนิด `SCREEN_THUMBNAIL_FRAME` ที่มี Header ระบุ `displayIndex`, `timestamp`, และ `hasMultipleDisplays`
   - เครื่องแม่เก็บเฟรมล่าสุดของแต่ละจอไว้ในหน่วยความจำ (ไม่เขียนลง SQLite) แล้วส่งต่อไปแสดงบนการ์ดของนักเรียนใน Dashboard

---

### 3c.3 Encrypted 5-Minute Ring Buffer (10-Second Playable Segments) (`src/main/screen/ring-buffer.ts`)
เนื่องจาก `MediaRecorder` หากสั่ง `requestData()` เฉยๆ จะได้เพียง WebM cluster ย่อยที่ไม่มีส่วน Header (EBML/Tracks) ทำให้ไม่สามารถนำไฟล์ท่อนกลางไปเปิดเล่นเดี่ยวๆ ได้ จึงต้องใช้วิธี **Segment Rotation**:

1. **การตัดเซกเมนต์ละ 10 วินาทีให้เล่นได้ในตัว (Self-Contained Segments):**
   - ตั้งค่าความละเอียดการบันทึกสำหรับ Ring Buffer ที่ `1280x720` (720p), `5 - 10 fps`, codec `video/webm;codecs=vp8` (หรือ `vp9`), `videoBitsPerSecond: 400_000` (~50 KB/s หรือ ~500 KB ต่อเซกเมนต์ 10 วินาที)
   - ทุกๆ `10,000 ms` ให้หยุด `MediaRecorder` ตัวปัจจุบันแล้วเริ่มตัวใหม่ทันที (ใช้ Double-buffered recorder สลับกันเพื่อไม่ให้ภาพขาดช่วง)
   - แต่ละเซกเมนต์ที่ได้จะเป็นไฟล์ `.webm` ที่สมบูรณ์ มี Header ครบ สามารถเปิดเล่นได้ทันทีตั้งแต่ต้นจนจบ 10 วินาที
2. **การเข้ารหัสและหมุนวน 5 นาที (Encrypted Ring Storage):**
   - เมื่อได้ Buffer ของเซกเมนต์ 10 วินาทีมาแล้ว ส่งผ่าน IPC ไปให้ Main process
   - Main process เข้ารหัสด้วย **AES-256-GCM** โดยใช้ `screenBufferKey` (คีย์สุ่มเฉพาะเซสชันที่เครื่องแม่ส่งมาให้ในหน่วยความจำ)
   - เขียนลงโฟลเดอร์ชั่วคราวของเซสชัน: `os.tmpdir()/ztexam-ring-<sessionId>/seg-<displayId>-<seqNo>.enc`
   - เก็บดัชนีเซกเมนต์ไว้ในหน่วยความจำ (`RingSegmentIndex`):
     ```ts
     interface RingSegmentMeta {
       segmentId: string
       displayId: string
       seqNo: number
       startTimeMs: number
       endTimeMs: number
       filePath: string
       ivBase64: string
       authTagBase64: string
       byteLength: number
       pinnedReason?: string // ถ้ามีค่า จะไม่ถูกลบเมื่อครบรอบ 5 นาที
     }
     ```
   - **กฎการหมุนทับ (Eviction Rule):**
     - สำหรับแต่ละจอ จะเก็บเซกเมนต์ปกติไม่เกิน `30 เซกเมนต์` (`30 x 10s = 300 วินาที = 5 นาที` ใช้พื้นที่ดิสก์เพียง ~15 MB ต่อจอ)
     - เมื่อมีเซกเมนต์ที่ 31 เข้ามา ให้ลบไฟล์ของเซกเมนต์ที่เก่าที่สุดที่ `pinnedReason === undefined` ทิ้งจากดิสก์ทันที

---

### 3c.4 Pin-on-Critical & Expiration Countdown
1. **การล็อกหลักฐานเมื่อเกิดเหตุวิกฤต (Pin on Critical):**
   - เมื่อเอนจินตรวจจับ (Phase 3a) พบเหตุการณ์ระดับ `CRITICAL` (เช่น พบโปรเซสต้องห้าม, พบหน้าต่าง Overlay, หรือพยายามต่อเน็ตนอก):
   - สั่ง `ringBuffer.pinAroundTimestamp(eventTimestamp)` ทันที:
     - ล็อกเซกเมนต์ก่อนเกิดเหตุ 2 เซกเมนต์ (20 วินาทีก่อนหน้า), เซกเมนต์ขณะเกิดเหตุ, และเซกเมนต์หลังเกิดเหตุอีก 3 เซกเมนต์ (รวม 60 วินาทีรอบเหตุการณ์) โดยตั้งค่า `pinnedReason = eventId`
     - เซกเมนต์ที่ถูก Pin จะไม่ถูกหมุนทับแม้เวลาจะผ่านไปเกิน 5 นาที (จำกัดโควตา Pin สูงสุดไม่เกิน 30 เซกเมนต์เพื่อกันดิสก์เต็ม)
2. **ตัวนับเวลาถอยหลังสำหรับเหตุการณ์ระดับ Warning:**
   - สำหรับเหตุการณ์ระดับ `WARNING` ที่ไม่ได้ถูก Pin อัตโนมัติ บน Dashboard ของครูจะแสดงเวลานับถอยหลัง เช่น `"วิดีโอย้อนหลังช่วงนี้จะถูกเขียนทับในอีก 03:42 นาที"` เพื่อให้ผู้คุมกดเรียกดูหรือกด Pin เองได้ทันเวลา

---

### 3c.5 Pull-on-Demand Streaming & Proctor Screen Viewer (`src/main/screen/stream-controller.ts`)
1. **ขั้นตอนการเรียกดูจากเครื่องแม่ (Pull-on-Demand Flow):**
   - ผู้คุมคลิกปุ่ม **"ดูหน้าจอสด / ย้อนหลัง 5 นาที"** บนการ์ดของนักเรียน:
   - **ขั้นที่ 1:** เครื่องแม่บันทึกเหตุการณ์ `PROCTOR_VIEW_SCREEN_STARTED` ลงใน Audit Log Hash Chain ทันที (ระบุเวลาและเครื่องที่ถูกดู)
   - **ขั้นที่ 2:** เครื่องแม่ส่งคำสั่ง `SCREEN_INSPECT_REQUEST` ไปยังเครื่องนักเรียน:
     - โหมด `LIVE_STREAM`: สั่งให้เครื่องนักเรียนเริ่มส่งเฟรมความละเอียดสูง (`720p/1080p`, `5-10 fps`) หรือเปิดช่องสตรีมสดส่งมาที่เครื่องแม่ทันที
     - โหมด `PLAYBACK_HISTORY`: เครื่องนักเรียนส่งรายการ `RingSegmentMeta[]` ทั้งหมดที่มีอยู่ในช่วง 5 นาทีล่าสุด (พร้อมหมุดตำแหน่งที่เกิด Event สีเหลือง/แดงบนแถบเวลา) ไปให้เครื่องแม่
   - **ขั้นที่ 3:** เมื่อผู้คุมคลิกเลือกช่วงเวลาบนแถบ Timeline 5 นาที เครื่องแม่ส่ง `FETCH_RING_SEGMENT(segmentId)` -> เครื่องนักเรียนถอดรหัสไฟล์เซกเมนต์นั้นและสตรีมก้อน `.webm` ผ่านท่อ TLS มาเล่นบนหน้าจอครูทันที (ใช้เวลาโหลดเพียง ~0.1 วินาทีในวง LAN)
2. **การล้างข้อมูลเมื่อจบการสอบ (Zero-Trace Cleanup):**
   - เมื่อจบการสอบ (`EXAM_ENDED`) หรือปิดแอป:
   - ลบคีย์ `screenBufferKey` ออกจากหน่วยความจำ และลบโฟลเดอร์ `ztexam-ring-<sessionId>` ทั้งหมดออกจากเครื่องนักเรียนทันที
3. **การต่อยอดสู่ WebRTC (Optional Upgrade):**
   - ออกแบบ `ScreenTransportInterface` ให้แยกส่วน Transport ออกจาก UI เพื่อให้สามารถสลับโหมด `LIVE_STREAM` จาก TLS Binary Chunk ไปเป็น `RTCPeerConnection` (DTLS-SRTP over UDP) ได้โดยใช้ท่อ TLS เดิมเป็นตัวแลกเปลี่ยน SDP Offer/Answer และ ICE Candidates

---

## 3. Checklist งานย่อย (Implementation Checklist)

- [x] **3c.1.1** สร้าง `CaptureManager` ตรวจสอบสิทธิ์ Screen Recording (macOS) และชนิดเซสชัน (Linux X11/Wayland) พร้อมดึงรายการทุก Display
- [x] **3c.2.1** สร้างตัวส่ง Thumbnail ~1 fps (`320x180` WebP/JPEG) ผ่าน TLS Binary Frame
- [x] **3c.3.1** สร้างตัวบันทึกเซกเมนต์วิดีโอละ 10 วินาทีแบบสลับ Recorder เพื่อให้ทุกไฟล์ `.webm` เปิดเล่นได้ในตัว
- [x] **3c.3.2** สร้าง `EncryptedRingBuffer` เข้ารหัสเซกเมนต์ด้วย AES-256-GCM และหมุนลบไฟล์เก่าเมื่อเกิน 5 นาที (30 เซกเมนต์ต่อจอ)
- [x] **3c.4.1** เชื่อมต่อระบบ `Pin-on-Critical` ล็อกเซกเมนต์รอบเหตุการณ์วิกฤตไม่ให้ถูกหมุนทับ
- [x] **3c.5.1** สร้างโปรโตคอล `SCREEN_INSPECT_REQUEST` และ `FETCH_RING_SEGMENT` สำหรับดึงวิดีโอย้อนหลังและภาพสดเมื่อผู้คุมกดดู
- [x] **3c.5.2** บันทึกทุกการเปิดดูหน้าจอลงใน `AuditLog` ที่เครื่องแม่
- [x] **3c.5.3** สร้าง UI `ProctorScreenModal.tsx` บนหน้าจอครู รองรับการสลับดูหลายจอ (Display 1 / Display 2), สลับโหมดดูสดกับย้อนหลัง 5 นาที และมีจุดมาร์กตำแหน่งที่เกิด Alert บนแถบเวลา
- [x] **3c.5.4** สร้างระบบลบไฟล์ Ring Buffer ทั้งหมดเมื่อจบสอบหรือเมื่อเริ่มเซสชันใหม่

---

## 4. การทดสอบและเกณฑ์ผ่าน (Verification & Definition of Done)

1. **Automated Tests (`vitest`):**
   - **Ring Buffer Rotation & Pinning Test:** จำลองการใส่เซกเมนต์เข้ามา 45 เซกเมนต์ โดยสั่ง Pin เซกเมนต์ที่ 5, 6, 7 ไว้ -> ตรวจสอบว่าเซกเมนต์ที่ 1–4 และ 8–15 ถูกลบออกจากดิสก์จริง ส่วนเซกเมนต์ที่ 5, 6, 7 และเซกเมนต์ล่าสุด 30 ตัวอยู่ครบ และสามารถถอดรหัสกลับมาได้ข้อมูลตรงกับต้นฉบับ 100%
   - **Encrypted Segment Test:** ตรวจสอบว่าไฟล์ `.enc` บนดิสก์ไม่สามารถเปิดด้วยโปรแกรมเล่นวิดีโอทั่วไปได้จนกว่าจะถูกถอดรหัสด้วย `screenBufferKey`
2. **Manual Verification:**
   - เปิดการสอบและปล่อยให้รันเกิน 6 นาที -> ตรวจสอบโฟลเดอร์ชั่วคราวในเครื่องนักเรียนว่ามีจำนวนไฟล์คงที่ ไม่เพิ่มขึ้นเรื่อยๆ
   - บนหน้าจอครู คลิกดูหน้าจอของนักเรียน -> ดูภาพสดได้ลื่นไหล และสามารถคลิกย้อนดูเหตุการณ์เมื่อ 3 นาทีที่แล้วได้ทันที พร้อมมีบันทึกการเปิดดูปรากฏใน Audit Log


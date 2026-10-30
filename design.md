# LAN Exam System — Redesign Spec (shadcn, full migration)

## 1. Goal
ย้าย UI ทั้งก้อนออกจากทรง AI slop (slate-950 + rounded-2xl ทุกการ์ด + emoji) ไปใช้ shadcn-style component system เดียวกันทั้ง host/student, รองรับ dark/light mode, ทำงาน offline บน Electron `file://` ได้, ข้อความไทยเป็นหลัก

## 2. Stack
- React 19 + Tailwind CSS v4 (`@tailwindcss/vite`) + Electron-Vite, `file://` production
- shadcn approach = copy-paste source ใน `src/renderer/src/components/ui/*` (ไม่ใช่ CDN, ไม่เรียก network)
- deps ที่อนุญาตเพิ่ม: `clsx`, `tailwind-merge`, `class-variance-authority`, `@radix-ui/react-slot`, `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-tabs`, `@radix-ui/react-toast` หรือ `sonner`
- ห้ามเพิ่ม UI framework ซ้อน (no MUI/Chakra/Mantine), ห้าม webfont CDN — ใช้ system Thai stack เดิม
- Icons: `lucide-react` เท่านั้น, ห้าม emoji ใน UI (`✅⛔📝` ให้ใช้ Badge/Icon แทน)

## 3. Theme: dark/light
- กลยุทธ์ `class` strategy: `:root` = light tokens, `.dark` = dark tokens, เก็บใน `src/renderer/src/index.css` ด้วย `@theme inline` + CSS vars (`--background`, `--foreground`, `--card`, `--border`, `--primary`, `--muted`, `--destructive` ฯลฯ)
- Tailwind v4: ใช้ `@custom-variant dark (&:where(.dark, .dark *));` เพื่อให้ `dark:` อิง class
- Default = dark (คงพฤติกรรมสอบเดิม), มี toggle ใน `HostShell` / `StudentShell` header, เก็บใน `localStorage zt-theme`, ไม่กระพริบตอน reload (อ่านก่อน render)
- ห้าม hardcode `bg-slate-950/text-slate-100/border-slate-800` ในหน้าจออีก — ใช้ `bg-background text-foreground border-border bg-card bg-muted` เท่านั้น
- Radius กลาง `0.625rem`, focus ring ใช้ `ring-ring`, font ใช้ `--font-sans` เดิม (Segoe UI/Leelawadee/Noto Sans Thai/Sarabun)

## 4. Component map (ใช้ให้หมด, ห้ามทำ custom ซ้ำ)
| งาน | shadcn primitive |
|---|---|
| ปุ่ม | `ui/button` (variants: default/secondary/outline/ghost/destructive) |
| อินพุต/PIN/ค้นหา | `ui/input` + `ui/label` |
| Select/โหมดสอบ | `ui/select` (Radix) |
| การ์ด | `ui/card` (CardHeader/Title/Content เดียว) |
| Badge/สถานะ | `ui/badge` (ไม่ใช้ pill hand-made) |
| Tabs ฝั่ง host | `ui/tabs` |
| Dialog/Confirm/Preview | `ui/dialog` (แทน `window.confirm` ทั้งหมด) |
| Drawer ฝั่ง triage | `ui/sheet` |
| Table ความคืบหน้า/submissions | `ui/table` |
| Toast/notify | `sonner` ผ่าน `ui/sonner` แทน `app-store.notify` custom div ใน `App.tsx` |
| Tooltip | `ui/tooltip` สำหรับ fingerprint/port/ตัวย่อ |
| Skeleton/empty | `ui/skeleton`, `ui/empty`-pattern เดียวกัน |
| Scroll | `ui/scroll-area` สำหรับ list ยาว (domains, evidence) |

## 5. Layout rules (กันกลับไป slop)
- Shell เดียว: `HostShell`/`StudentShell` ใช้ header เดียวกัน (title + connection badge + theme toggle), `main` เป็น `container max-w-6xl`
- Density: ฝั่งครู (triage, submissions, domains) เป็น table-first — การ์ดใช้แค่ lobby/empty state
- ฝั่งนักเรียนสอบ: HUD Bar สูง ≤48px, โจทย์ `max-w-3xl`, ปุ่มหลักปุ่มเดียว (`ยืนยันและไปข้อถัดไป`)
- ข้อความไทยสั้น, ตัวเลขใช้ `tabular-nums`, PIN ใช้ `font-mono tracking-widest`
- สถานะเชื่อมต่อ/สอบ/ack ใช้ Badge 3 สีเท่านั้น (emerald/amber/red mapping ผ่าน `badge` variant) — ห้ามไล่เฉดเองรายไฟล์

## 6. Zone ownership (ห้ามแตะไฟล์ข้ามโซน)
- Foundation: `index.css`, `lib/utils.ts`, `components/ui/*`, `components/theme-*`, `App.tsx` (sonner mount + theme init)
- Zone A Shell: `components/RoleSelector.tsx`, `components/HostShell.tsx`, `components/StudentShell.tsx`
- Zone B Lobby: `components/StudentPanel.tsx`
- Zone C Exam: `core-student/ExamView.tsx`, `QuestionRenderer.tsx`, `HudBar.tsx`, `DocsPanel.tsx`, `ProctorOverlay.tsx`, `WatermarkOverlay.tsx`, `FloatingHud.tsx`
- Zone D Host: `components/HostPanel.tsx` (room/exam/docs/attestation/students)
- Zone E Triage: `core-host/dashboard/*` (5 ไฟล์)
- Zone F Modules: `src/modules/dynamic-form/renderer/**/*`, `src/modules/code-ide/renderer/**/*`
- Store/API ห้ามเปลี่ยน signature (`window.ztExam`, zustand stores) — เปลี่ยนแค่ presentation

## 7. A11y + Kiosk constraints
- ทุก Dialog มี title/description, focus trap ของ Radix, ปุ่ม destructive ต้อง confirm 2 ชั้น
- Kiosk exam: `user-select:none` บนโจทย์คงเดิม, ห้าม auto-focus ดึงคีย์บอร์ด, timer ต้อง `aria-live=off` (อัปเดตทุกวิห้าม329รีด)
- Fail-closed overlays (frozen/closed/timeup) ใช้ pattern เดียว: icon + title + 1 คำอธิบาย + 1 action

## 8. Verification (ทุกโซนต้องผ่านก่อนจบ)
- `npm run typecheck` (node + web) ผ่าน
- `npm test` ไม่พังเพิ่ม
- `npm run build` (electron-vite build) ผ่าน — เช็ค `file://` ไม่มี dynamic CDN import
- ห้ามเหลือ `window.confirm`, emoji UI, `bg-slate-950`, `rounded-2xl border border-slate-800 bg-slate-900/60` hardcode ในไฟล์ที่แตะ

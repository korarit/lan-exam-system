import { useEffect, useState } from 'react'
import {
  DoorOpen,
  DoorClosed,
  Copy,
  Check,
  KeyRound,
  Users,
  Wifi,
  WifiOff,
  ShieldAlert,
  FileUp,
  Play,
  StopCircle,
  ClipboardList,
  GraduationCap,
  Globe,
  ExternalLink,
  CheckCircle2,
  CircleDashed,
  ShieldCheck,
  ShieldQuestion
} from 'lucide-react'
import type { ExamMode, EnforcementMode } from '@shared/types/exam'
import type { RecordedDomainItem, AttestationConfigResponse } from '@shared/ipc-channels'
import { DEFAULT_FORBIDDEN_DOMAINS } from '@shared/policy-schema'
import { useHostNetworkStore } from '../store/network-store'
import { useAppStore } from '../store/app-store'
import type { HostExamSummariesEvent } from '@shared/ipc-channels'
import TriageDashboard from '../core-host/dashboard/TriageDashboard'

const MODE_LABELS: Record<ExamMode, string> = {
  closed: 'Closed — ปิดเครือข่าย',
  'in-app-docs': 'In-App Docs — เอกสารในแอป',
  'external-tools': 'External Tools — อนุญาต VS Code'
}

/** ป้ายเตือนเชิงข้อมูล: รายการที่ชนโดเมน AI ที่รู้จัก (ระบบไม่ขวาง — ให้ครูสังเกตเอง) */
function isKnownForbiddenDomain(domain: string): boolean {
  const host = domain.toLowerCase()
  return DEFAULT_FORBIDDEN_DOMAINS.some((f) => host === f || host.endsWith(`.${f}`))
}

export default function HostPanel(): React.JSX.Element {
  const room = useHostNetworkStore((s) => s.room)
  const students = useHostNetworkStore((s) => s.students)
  const setRoom = useHostNetworkStore((s) => s.setRoom)
  const notify = useAppStore((s) => s.notify)
  const [roomName, setRoomName] = useState('ห้องสอบ 401')
  const [mode, setMode] = useState<ExamMode>('closed')
  const [enforcement, setEnforcement] = useState<EnforcementMode>('report-only')
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  /* ---------- Exam Core (Phase 2) ---------- */
  const [loadedExam, setLoadedExam] = useState<{ title: string; questionCount: number; durationSeconds: number } | null>(null)
  const [examState, setExamState] = useState<'idle' | 'running' | 'collecting' | 'finished'>('idle')
  const [summaries, setSummaries] = useState<HostExamSummariesEvent['summaries']>([])
  const [starting, setStarting] = useState(false)
  const [picking, setPicking] = useState(false)

  /* ---------- Guard events (Phase 3a) — notify เหตุการณ์วิกฤต / triage จัดการแสดงผลเอง ---------- */
  const studentNames = new Map(students.map((s) => [s.studentId, s.studentName]))

  /* ---------- Doc Preview & Domain Allowlist (Phase 3a-plus) ---------- */
  const [docUrl, setDocUrl] = useState('')
  const [recordedDomains, setRecordedDomains] = useState<RecordedDomainItem[]>([])
  const [domainEnforcement, setDomainEnforcement] = useState<'warn' | 'block'>('warn')
  const [openingDoc, setOpeningDoc] = useState(false)
  const isDocsMode = room?.mode === 'in-app-docs'
  const isLobby = examState === 'idle'
  const pendingDomains = recordedDomains.filter((r) => !r.approved)

  /* ---------- Attestation (Phase 4) — ป้าย DEV MODE + สวิตช์บังคับตรวจลายเซ็น ---------- */
  const [attestation, setAttestation] = useState<AttestationConfigResponse | null>(null)
  const refreshAttestation = (): void => {
    void window.ztExam.getAttestationConfig().then(setAttestation)
  }

  async function setAttestationEnforcement(enforced: boolean): Promise<void> {
    await window.ztExam.setAttestationEnforce({ enforced })
    refreshAttestation()
    notify({
      severity: enforced ? 'warning' : 'info',
      message: enforced
        ? 'บังคับตรวจลายเซ็น Manifest จริง — client ที่ไม่ได้เซ็นจะถูกปฏิเสธ'
        : 'กลับสู่โหมด dev — อนุญาต client ที่ไม่ได้เซ็นลายเซ็น'
    })
  }

  useEffect(() => {
    // กู้สถานะห้องเมื่อกลับมาที่หน้านี้ (เช่น reload)
    void window.ztExam.getRoom().then((res) => setRoom(res.room))
    const unsub = window.ztExam.onEvent('host:students-updated', (event) =>
      useHostNetworkStore.getState().setStudents(event.students)
    )
    const unsubState = window.ztExam.onEvent('host:exam-state-changed', (event) => {
      setExamState(event.state)
      if (event.title !== null) {
        setLoadedExam({ title: event.title, questionCount: event.questionCount, durationSeconds: 0 })
      }
    })
    const unsubSummaries = window.ztExam.onEvent('host:exam-summaries', (event) =>
      setSummaries(event.summaries)
    )
    const unsubCompleted = window.ztExam.onEvent('host:exam-completed', (event) => {
      setExamState('finished')
      notify({
        severity: event.reason === 'time-up' ? 'warning' : 'info',
        message: event.reason === 'time-up' ? 'หมดเวลาสอบ — เก็บข้อสอบอัตโนมัติแล้ว' : 'จบการสอบแล้ว (คำสั่งครู)'
      })
    })
    const unsubGuard = window.ztExam.onEvent('host:guard-events', (event) => {
      const critical = event.events.filter((e) => e.severity === 'critical')
      if (critical.length > 0) {
        const names = studentNames.get(event.studentId) ?? event.studentId
        notify({
          severity: 'critical',
          message: `ตรวจพบพฤติกรรมน่าสงสัย: ${names} — ${critical.map((e) => e.code).join(', ')}`
        })
      }
    })
    // โดเมนที่ record จาก Doc Preview (Phase 3a-plus) — push หลัง flush ทุกรอบ
    const unsubDomains = window.ztExam.onEvent('host:recorded-domains-updated', (event) =>
      setRecordedDomains(event.records)
    )
    if (isDocsMode) {
      void window.ztExam.listRecordedDomains().then((res) => setRecordedDomains(res.records))
    }
    // Attestation state (Phase 4)
    void window.ztExam.getAttestationConfig().then(setAttestation)
    return () => {
      unsub()
      unsubState()
      unsubSummaries()
      unsubCompleted()
      unsubGuard()
      unsubDomains()
    }
  }, [setRoom, notify])

  async function selectExamFile(): Promise<void> {
    setPicking(true)
    try {
      const result = await window.ztExam.selectExamFile()
      if (result.ok) {
        setLoadedExam({ title: result.title, questionCount: result.questionCount, durationSeconds: result.durationSeconds })
        notify({ severity: 'info', message: `โหลด "${result.title}" (${result.questionCount} ข้อ)` })
      } else if (result.message) {
        notify({ severity: 'warning', message: result.message })
      }
    } finally {
      setPicking(false)
    }
  }

  async function startExam(): Promise<void> {
    setStarting(true)
    try {
      await window.ztExam.startExam()
      setExamState('running')
      notify({ severity: 'info', message: 'เริ่มการสอบ — เครื่องนักเรียนทุกเครื่องได้รับข้อแรกแล้ว' })
    } catch (err) {
      notify({
        severity: 'critical',
        message: err instanceof Error ? err.message : 'เริ่มการสอบไม่สำเร็จ'
      })
    } finally {
      setStarting(false)
    }
  }

  async function endExam(): Promise<void> {
    try {
      await window.ztExam.endExam()
      notify({ severity: 'warning', message: 'สั่งจบการสอบ — กำลังเก็บคำตอบทั้งหมด' })
    } catch {
      notify({ severity: 'critical', message: 'จบการสอบไม่สำเร็จ' })
    }
  }

  /* ---------- Doc Preview & Domain Allowlist (Phase 3a-plus) ---------- */

  async function openDocPreview(): Promise<void> {
    if (!docUrl.trim()) return
    setOpeningDoc(true)
    try {
      const res = await window.ztExam.openDocPreview({ url: docUrl.trim() })
      if (!res.ok) {
        notify({
          severity: 'warning',
          message:
            res.reason === 'EXAM_NOT_IN_LOBBY'
              ? 'เปิดเอกสารได้เฉพาะก่อนเริ่มสอบ (Lobby)'
              : res.reason === 'MODE_NOT_IN_APP_DOCS'
                ? 'การเตรียมเอกสารใช้กับโหมด In-App Docs เท่านั้น'
                : 'URL ไม่ถูกต้อง (ใช้ได้เฉพาะ http/https)'
        })
      }
    } catch {
      notify({ severity: 'critical', message: 'เปิดเอกสารไม่สำเร็จ' })
    } finally {
      setOpeningDoc(false)
    }
  }

  async function approveDomain(domain: string, approved: boolean): Promise<void> {
    const res = await window.ztExam.approveDomain({ domain, approved })
    if (!res.ok) {
      notify({ severity: 'warning', message: 'อัปเดตรายการโดเมนไม่สำเร็จ' })
    }
  }

  async function approveAllDomains(): Promise<void> {
    const res = await window.ztExam.approveDomain({ domain: '*', approved: true })
    if (res.ok) {
      notify({ severity: 'info', message: `อนุมัติทั้งหมด (${res.updatedCount ?? 0} รายการ)` })
    }
  }

  async function changeDomainEnforcement(mode: 'warn' | 'block'): Promise<void> {
    setDomainEnforcement(mode)
    await window.ztExam.setDomainEnforcement({ mode })
  }

  async function createRoom(): Promise<void> {
    setCreating(true)
    try {
      const info = await window.ztExam.createRoom({ roomName, mode, enforcement })
      setRoom(info)
      // ค่าเริ่มต้นของการบังคับโดเมนสืบจาก enforcement ของห้อง (ครูตั้งทับได้ในการ์ด)
      setDomainEnforcement(enforcement === 'block-and-report' ? 'block' : 'warn')
      notify({ severity: 'info', message: `เปิดห้อง "${info.roomName}" สำเร็จ` })
    } catch (err) {
      notify({
        severity: 'critical',
        message: err instanceof Error ? err.message : 'เปิดห้องไม่สำเร็จ'
      })
    } finally {
      setCreating(false)
    }
  }

  async function closeRoom(): Promise<void> {
    await window.ztExam.closeRoom()
    setRoom(null)
    useHostNetworkStore.getState().setStudents([])
    notify({ severity: 'warning', message: 'ปิดห้องสอบแล้ว' })
  }

  async function copy(label: string, value: string): Promise<void> {
    await navigator.clipboard.writeText(value)
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }

  if (!room) {
    return (
      <div className="mx-auto w-full max-w-md">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8">
          <div className="mb-6 flex items-center gap-3">
            <DoorOpen className="text-emerald-400" size={24} />
            <h2 className="text-lg font-semibold">เปิดห้องสอบ</h2>
          </div>

          <label className="mb-1.5 block text-sm text-slate-300" htmlFor="room-name">
            ชื่อห้อง
          </label>
          <input
            id="room-name"
            value={roomName}
            maxLength={80}
            onChange={(e) => setRoomName(e.target.value)}
            className="mb-4 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 focus:border-emerald-500 focus:outline-none"
          />

          <label className="mb-1.5 block text-sm text-slate-300" htmlFor="mode">
            โหมดการสอบ
          </label>
          <select
            id="mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as ExamMode)}
            className="mb-4 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 focus:border-emerald-500 focus:outline-none"
          >
            {(Object.keys(MODE_LABELS) as ExamMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>

          <label className="mb-1.5 block text-sm text-slate-300" htmlFor="enforcement">
            นโยบายบังคับ
          </label>
          <select
            id="enforcement"
            value={enforcement}
            onChange={(e) => setEnforcement(e.target.value as EnforcementMode)}
            className="mb-6 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 focus:border-emerald-500 focus:outline-none"
          >
            <option value="report-only">Report-only — ตรวจจับและฟ้อง</option>
            <option value="block-and-report">Block &amp; Report — บล็อกพร้อมฟ้อง</option>
          </select>

          <button
            type="button"
            disabled={creating || roomName.trim().length === 0}
            onClick={() => void createRoom()}
            className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {creating ? 'กำลังสร้างคีย์ + เปิด TLS…' : 'เปิดห้องสอบ'}
          </button>
        </div>
      </div>
    )
  }

  const onlineStudents = students.filter((s) => s.online)

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div className="rounded-2xl border border-emerald-800/50 bg-slate-900/60 p-8">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <DoorClosed className="text-emerald-400" size={22} />
            <h2 className="text-lg font-semibold">{room.roomName}</h2>
          </div>
          <button
            type="button"
            onClick={() => void closeRoom()}
            className="rounded-lg border border-red-800/60 px-3 py-1.5 text-sm text-red-300 transition hover:bg-red-950/60"
          >
            ปิดห้อง
          </button>
        </div>

        <div className="rounded-xl bg-slate-950 p-6 text-center">
          <div className="mb-1 flex items-center justify-center gap-2 text-sm text-slate-400">
            <KeyRound size={16} />
            Room PIN — ขึ้นบนจอหน้าห้องสอบ
          </div>
          <div className="font-mono text-6xl font-bold tracking-[0.3em] text-emerald-400">
            {room.roomPin}
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <dt className="text-xs text-slate-500">Room ID (สำหรับกรอกด้วยตนเอง)</dt>
            <dd className="mt-1 flex items-center gap-2">
              <code className="truncate font-mono text-xs text-slate-300">{room.roomId}</code>
              <button
                type="button"
                onClick={() => void copy('id', room.roomId)}
                className="shrink-0 text-slate-500 hover:text-slate-200"
              >
                {copied === 'id' ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </dd>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <dt className="text-xs text-slate-500">TLS port / Cert fingerprint (ย่อ)</dt>
            <dd className="mt-1 flex items-center gap-2">
              <code className="font-mono text-xs text-slate-300">
                :{room.tcpPort} · {room.certFpShort}…
              </code>
              <button
                type="button"
                onClick={() => void copy('fp', room.certFingerprint)}
                className="shrink-0 text-slate-500 hover:text-slate-200"
              >
                {copied === 'fp' ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </dd>
          </div>
        </dl>
      </div>

      {/* ---------- Exam Core (Phase 2): โหลดข้อสอบ + เริ่ม/จบ + ความคืบหน้า ---------- */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="mb-4 flex items-center gap-2">
          <ClipboardList size={18} className="text-sky-400" />
          <h3 className="font-semibold">ข้อสอบและการเริ่มการสอบ</h3>
          {examState === 'running' && (
            <span className="ml-auto rounded-full border border-emerald-800/60 bg-emerald-950/40 px-3 py-1 text-xs text-emerald-300">
              กำลังสอบ
            </span>
          )}
          {examState === 'finished' && (
            <span className="ml-auto rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-xs text-slate-400">
              จบแล้ว
            </span>
          )}
        </div>

        {examState === 'idle' && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={picking}
              onClick={() => void selectExamFile()}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-200 transition hover:bg-slate-800 disabled:opacity-40"
            >
              <FileUp size={16} />
              {picking ? 'กำลังอ่านไฟล์…' : 'เลือกไฟล์ข้อสอบ (JSON)'}
            </button>
            {loadedExam && (
              <>
                <div className="text-sm text-slate-300">
                  <span className="font-semibold">{loadedExam.title}</span> · {loadedExam.questionCount} ข้อ
                </div>
                <button
                  type="button"
                  disabled={starting || onlineStudents.length === 0}
                  onClick={() => void startExam()}
                  className="ml-auto inline-flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 font-semibold text-white transition hover:bg-sky-500 disabled:opacity-40"
                >
                  <Play size={16} />
                  {starting ? 'กำลังเริ่ม…' : 'เริ่มการสอบ'}
                </button>
              </>
            )}
            {!loadedExam && onlineStudents.length === 0 && (
              <span className="text-xs text-slate-500">ดูนักเรียนในห้องก่อน แล้วเลือกไฟล์ข้อสอบเพื่อเริ่ม</span>
            )}
          </div>
        )}

        {examState === 'running' && (
          <button
            type="button"
            onClick={() => void endExam()}
            className="inline-flex items-center gap-2 rounded-xl border border-red-800/60 px-4 py-2.5 text-sm text-red-300 transition hover:bg-red-950/60"
          >
            <StopCircle size={16} /> จบการสอบ (เก็บทั้งห้อง)
          </button>
        )}

        {summaries.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
              <GraduationCap size={14} /> ความคืบหน้ารายคน (สามารถดูระบบให้คะแนนโดยอัตโนมัติ — ข้อจัดตั้งให้ข้อมือตรวจหลังสอบ)
            </div>
            <ul className="space-y-2">
              {summaries.map((s) => (
                <li key={s.studentId} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-200">{s.studentName}</span>
                    <span className="font-mono text-xs text-slate-400">
                      {s.maxReachedCursor}/{s.totalQuestions} ข้อ · {s.awardedPoints} คะแนน
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-900">
                    <div
                      className="h-full rounded-full bg-emerald-500/80 transition-all"
                      style={{
                        width: `${s.totalQuestions > 0 ? (s.maxReachedCursor / s.totalQuestions) * 100 : 0}%`
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ---------- เตรียมเอกสาร & โดเมนที่อนุญาต (Phase 3a-plus — Mode 2) ---------- */}
      {isDocsMode && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="mb-4 flex items-center gap-2">
            <Globe size={18} className="text-indigo-400" />
            <h3 className="font-semibold">เตรียมเอกสาร &amp; โดเมนที่อนุญาต</h3>
            {pendingDomains.length > 0 && (
              <span className="ml-auto rounded-full border border-amber-800/60 bg-amber-950/40 px-3 py-1 text-xs text-amber-300">
                รอตัดสิน {pendingDomains.length} รายการ
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[240px]">
              <ExternalLink size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={docUrl}
                onChange={(e) => setDocUrl(e.target.value)}
                placeholder="https://docs.example.com/exam-material"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              disabled={!isLobby || openingDoc || docUrl.trim().length === 0}
              onClick={() => void openDocPreview()}
              className="inline-flex items-center gap-2 rounded-xl border border-indigo-700/60 px-4 py-2 text-sm text-indigo-200 transition hover:bg-indigo-950/60 disabled:opacity-40"
            >
              {openingDoc ? 'กำลังเปิด…' : 'เปิดตรวจเอกสาร'}
            </button>
          </div>
          {!isLobby && (
            <p className="mt-2 text-xs text-slate-500">
              การเปิดเอกสารทำได้เฉพาะช่วงเตรียมห้อง (ก่อนเริ่มสอบ)
            </p>
          )}

          <label className="mt-4 mb-1.5 block text-xs text-slate-500" htmlFor="domain-enforcement">
            เมื่อนักเรียนใช้โดเมนนอกเหนือรายการ
          </label>
          <select
            id="domain-enforcement"
            value={domainEnforcement}
            onChange={(e) => void changeDomainEnforcement(e.target.value as 'warn' | 'block')}
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none sm:max-w-xs"
          >
            <option value="warn">เตือน (แจ้งครู — ปล่อยผ่าน)</option>
            <option value="block">บล็อก (ตัดทันที + แจ้งครู)</option>
          </select>

          {recordedDomains.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-slate-500">
                  โดเมนที่เว็บเอกสารเรียกใช้จริง ({recordedDomains.length} รายการ)
                </span>
                <button
                  type="button"
                  disabled={pendingDomains.length === 0}
                  onClick={() => void approveAllDomains()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-800/60 px-3 py-1.5 text-xs text-emerald-300 transition hover:bg-emerald-950/60 disabled:opacity-40"
                >
                  <ShieldCheck size={13} /> อนุญาตทั้งหมด
                </button>
              </div>
              <ul className="max-h-64 space-y-1.5 overflow-y-auto">
                {recordedDomains.map((r) => (
                  <li
                    key={`${r.domain}|${r.topDomain}|${r.source}`}
                    className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm"
                  >
                    {r.approved ? (
                      <CheckCircle2 size={14} className="shrink-0 text-emerald-400" />
                    ) : (
                      <CircleDashed size={14} className="shrink-0 text-amber-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <code className="truncate font-mono text-xs text-slate-200">{r.domain}</code>
                        {isKnownForbiddenDomain(r.domain) && (
                          <span className="rounded bg-red-950/60 px-1.5 py-0.5 text-[10px] text-red-300">
                            ชนโดเมน AI ที่รู้จัก — โปรดตรวจเอง
                          </span>
                        )}
                        {r.source === 'top-url' && (
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">โดเมนหลัก</span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-slate-500">
                        เรียกจาก {r.topDomain} · {r.hits} ครั้ง
                      </div>
                    </div>
                    {r.approved ? (
                      <button
                        type="button"
                        onClick={() => void approveDomain(r.domain, false)}
                        className="shrink-0 rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-400 transition hover:bg-slate-800"
                      >
                        ยกเลิก
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void approveDomain(r.domain, true)}
                        className="shrink-0 rounded-lg border border-emerald-800/60 px-2.5 py-1 text-xs text-emerald-300 transition hover:bg-emerald-950/60"
                      >
                        อนุญาต
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ---------- Triage Dashboard (Phase 3b): hash chain + คัดกรองคนแดง ---------- */}
      <TriageDashboard students={students} summaries={summaries} canExport={examState === 'finished'} />

      {/* ---------- Attestations (Phase 4): DEV MODE banner + สวิตช์บังคับตรวจลายเซ็น ---------- */}
      {attestation?.devMode && (
        <div
          className={`rounded-2xl border p-4 ${
            attestation.signatureEnforced
              ? 'border-amber-800/60 bg-amber-950/30'
              : 'border-amber-700/70 bg-amber-950/40'
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <ShieldQuestion size={18} className="text-amber-300" />
            <span className="font-semibold text-amber-200">
              ⚠️ DEV MODE: อนุญาต Client ที่ไม่ได้เซ็นลายเซ็น
            </span>
            <button
              type="button"
              onClick={() => void setAttestationEnforcement(!attestation.signatureEnforced)}
              className={`ml-auto rounded-lg border px-3 py-1.5 text-xs transition ${
                attestation.signatureEnforced
                  ? 'border-emerald-800/60 text-emerald-300 hover:bg-emerald-950/60'
                  : 'border-amber-800/60 text-amber-200 hover:bg-amber-900/50'
              }`}
            >
              {attestation.signatureEnforced ? 'ตรวจลายเซ็นจริง: เปิด' : 'บังคับตรวจลายเซ็นจริง'}
            </button>
          </div>
          <p className="mt-2 text-xs text-amber-300/80">
            Manifest {attestation.signatureEnforced ? 'ต้องผ่านลายเซ็น Ed25519' : 'ยอมรับแม้ไม่มีลายเซ็น (พัฒนาเท่านั้น)'}
            {' · '}platform: {attestation.platform}
            {attestation.trackedStudents.length > 0 &&
              ` · ตรวจแล้ว ${attestation.trackedStudents.filter((t) => t.signed).length}/${attestation.trackedStudents.length} คน`}
          </p>
        </div>
      )}

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="mb-4 flex items-center gap-2">
          <Users size={18} className="text-slate-400" />
          <h3 className="font-semibold">นักเรียน ({onlineStudents.length} ออนไลน์)</h3>
        </div>
        {students.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            ยังไม่มีใครเข้าห้อง — นักเรียนในวง LAN เดียวกันจะเห็นห้องนี้อัตโนมัติ
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {students.map((s) => (
              <li
                key={s.studentId}
                className={`rounded-xl border p-3 ${
                  s.online
                    ? s.focusState === 'focused'
                      ? 'border-emerald-800/50 bg-emerald-950/30'
                      : 'border-amber-800/50 bg-amber-950/30'
                    : 'border-red-900/50 bg-red-950/20 opacity-70'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  {s.online ? (
                    <Wifi size={14} className="text-emerald-400" />
                  ) : (
                    <WifiOff size={14} className="text-red-400" />
                  )}
                  <span className="truncate">{s.studentName}</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">{s.studentId}</div>
                <div className="mt-1.5 text-xs">
                  {s.focusState === 'blurred' || s.focusState === 'fullscreen-exit' ? (
                    <span className="inline-flex items-center gap-1 text-amber-300">
                      <ShieldAlert size={12} /> เสียโฟกัส
                    </span>
                  ) : (
                    <span className="text-slate-500">
                      {s.online ? 'โฟกัสปกติ' : 'ออฟไลน์'}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

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
import { playCriticalBeep, shouldAlertToast, useTriageStore } from '../store/triage-store'
import type { HostExamSummariesEvent } from '@shared/ipc-channels'
import TriageDashboard from '../core-host/dashboard/TriageDashboard'

const MODE_LABELS: Record<ExamMode, string> = {
  closed: 'Closed — ปิดเครือข่าย',
  'in-app-docs': 'In-App Docs — เอกสารในแอป',
  'external-tools': 'External Tools — อนุญาต VS Code'
}

/** ป้ายเตือนเชิงข้อมูล: รายการที่ชนโดเมน AI ที่รู้จัก (ค่าเริ่มต้น = บล็อก ต้องติ๊กรับทราบความเสี่ยงรายตัว — R3) */
function isKnownForbiddenDomain(domain: string): boolean {
  const host = domain.toLowerCase()
  return DEFAULT_FORBIDDEN_DOMAINS.some((f) => host === f || host.endsWith(`.${f}`))
}

/** R7: รวมแถวโดเมนซ้ำ (โดเมนเดียวถูกเรียกจากหลาย top) เป็นรายการเดียว — แสดง topDomains หลายค่า */
interface MergedDomain {
  domain: string
  topDomains: string[]
  sources: string[]
  hits: number
  approved: boolean
  lastSeenAtMs: number
}

function mergeRecordedDomains(rows: RecordedDomainItem[]): MergedDomain[] {
  const byDomain = new Map<string, MergedDomain>()
  for (const r of rows) {
    const key = r.domain.toLowerCase()
    const existing = byDomain.get(key)
    if (!existing) {
      byDomain.set(key, {
        domain: r.domain,
        topDomains: [r.topDomain],
        sources: [r.source],
        hits: r.hits,
        approved: r.approved,
        lastSeenAtMs: r.lastSeenAtMs
      })
    } else {
      if (!existing.topDomains.includes(r.topDomain)) existing.topDomains.push(r.topDomain)
      if (!existing.sources.includes(r.source)) existing.sources.push(r.source)
      existing.hits += r.hits
      existing.approved = existing.approved && r.approved
      existing.lastSeenAtMs = Math.max(existing.lastSeenAtMs, r.lastSeenAtMs)
    }
  }
  return [...byDomain.values()].sort((a, b) => b.hits - a.hits || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0))
}

/** แปล error code ฝั่ง main เป็นภาษาครู (I-05) */
function translateHostError(message: string): string {
  if (message.includes('NO_ONLINE_STUDENTS')) return 'ยังไม่มีนักเรียนออนไลน์ — รอนักเรียนเข้าห้องก่อนเริ่มสอบ'
  if (message.includes('EXAM_NOT_LOADED')) return 'ยังไม่ได้เลือกไฟล์ข้อสอบ — เลือกไฟล์ข้อสอบก่อนเริ่ม'
  if (message.includes('ROOM_NOT_OPEN')) return 'ยังไม่ได้เปิดห้องสอบ — เปิดห้องก่อนเริ่มสอบ'
  if (message.includes('EXAM_IN_PROGRESS')) return 'การสอบกำลังดำเนินอยู่แล้ว'
  if (message.includes('ROOM_ALREADY_OPEN')) return 'เปิดห้องสอบไว้แล้ว — ไม่ต้องเปิดซ้ำ'
  if (message.includes('HOST_ROLE_REQUIRED')) return 'ต้องอยู่ในบทบาทเครื่องแม่ (host) เท่านั้น'
  return message
}

export default function HostPanel(): React.JSX.Element {
  const room = useHostNetworkStore((s) => s.room)
  const students = useHostNetworkStore((s) => s.students)
  const setRoom = useHostNetworkStore((s) => s.setRoom)
  const notify = useAppStore((s) => s.notify)
  const setConnectionState = useAppStore((s) => s.setConnectionState)
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
  /* R1: ยืนยันอนุมัติทั้งหมดสองชั้น */
  const [approveConfirm, setApproveConfirm] = useState(false)
  /* R3: ติ๊กรับทราบความเสี่ยงรายตัวก่อนอนุมัติโดเมนชน AI */
  const [riskAck, setRiskAck] = useState<Record<string, boolean>>({})
  const isDocsMode = room?.mode === 'in-app-docs'
  const isLobby = examState === 'idle'
  const mergedDomains = mergeRecordedDomains(recordedDomains)
  const pendingDomains = mergedDomains.filter((r) => !r.approved)
  const aiPendingDomains = pendingDomains.filter((r) => isKnownForbiddenDomain(r.domain))

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
    // กู้สถานะห้องเมื่อกลับมาที่หน้านี้ (เช่น reload) — TC-H15:
    // กู้ room + examState/loadedExam + students + summaries ไม่ให้รีเซ็ตเป็น idle ผิดๆ
    void (async () => {
      try {
        const res = await window.ztExam.getRoom()
        setRoom(res.room)
        setConnectionState(res.room ? 'connected' : 'offline')
        if (res.room) {
          try {
            const examStateRes = await window.ztExam.getExamState()
            setExamState(examStateRes.state)
            if (examStateRes.title !== null) {
              setLoadedExam({
                title: examStateRes.title,
                questionCount: examStateRes.questionCount,
                durationSeconds: examStateRes.durationSeconds ?? 0
              })
            }
          } catch {
            /* คง idle ไว้ถ้าอ่านสถานะสอบไม่ได้ */
          }
          try {
            const studentsRes = await window.ztExam.getStudents()
            useHostNetworkStore.getState().setStudents(studentsRes.students)
          } catch {
            /* คงรายชื่อว่างไว้ถ้าอ่านไม่ได้ */
          }
          try {
            const summariesRes = await window.ztExam.getSummaries()
            setSummaries(summariesRes.summaries)
          } catch {
            /* คง summaries ว่างไว้ถ้าอ่านไม่ได้ */
          }
        }
      } catch {
        /* กู้ห้องไม่ได้ — คงหน้าเปิดห้องไว้ */
      }
    })()
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
    // TRI-06: ผูก muted + กรอง severity กับ toast/เสียง alert จริง — mute แล้วเงียบทั้งหมด
    const unsubGuard = window.ztExam.onEvent('host:guard-events', (event) => {
      const critical = event.events.filter((e) => e.severity === 'critical')
      if (critical.length === 0) return
      const { muted, toastSeverity } = useTriageStore.getState()
      if (!shouldAlertToast('critical', { muted, toastSeverity })) return
      const names = studentNames.get(event.studentId) ?? event.studentId
      notify({
        severity: 'critical',
        message: `ตรวจพบพฤติกรรมน่าสงสัย: ${names} — ${critical.map((e) => e.code).join(', ')}`
      })
      playCriticalBeep(muted)
    })
    // โดเมนที่ record จาก Doc Preview (Phase 3a-plus) — push หลัง flush ทุกรอบ
    const unsubDomains = window.ztExam.onEvent('host:recorded-domains-updated', (event) =>
      setRecordedDomains(event.records)
    )
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
  }, [setRoom, notify, setConnectionState])

  // R7: โหลดรายการโดเมนใหม่ทุกครั้งที่ห้องเปลี่ยน (ไม่ใช่แค่ตอน mount) — กันเปิดห้องหลัง mount แล้วรายการค้างว่าง
  const roomId = room?.roomId
  useEffect(() => {
    if (!isDocsMode || !roomId) return
    void window.ztExam.listRecordedDomains().then((res) => setRecordedDomains(res.records))
  }, [isDocsMode, roomId])

  // R1: ปิดแผงยืนยันอัตโนมัติเมื่อไม่มีรายการรอแล้ว (กันกดยืนยันซ้ำกับรายการว่าง)
  const pendingCount = pendingDomains.length
  useEffect(() => {
    if (pendingCount === 0) setApproveConfirm(false)
  }, [pendingCount])

  async function selectExamFile(): Promise<void> {
    setPicking(true)
    try {
      const result = await window.ztExam.selectExamFile()
      if (result.ok) {
        setLoadedExam({ title: result.title, questionCount: result.questionCount, durationSeconds: result.durationSeconds })
        notify({ severity: 'info', message: `โหลด "${result.title}" (${result.questionCount} ข้อ)` })
      } else if (result.message) {
        // I-04: กดยกเลิก dialog ไม่ใช่ความผิดพลาด — ใช้ info หรือเงียบ ไม่ใช้ warning
        const isCancel = result.message.includes('ยกเลิกการเลือกไฟล์')
        if (!isCancel) {
          notify({ severity: 'warning', message: result.message })
        } else {
          notify({ severity: 'info', message: result.message })
        }
      }
    } finally {
      setPicking(false)
    }
  }

  async function startExam(): Promise<void> {
    // NC-09: กันลืม enforce — dev build หลุดไปสอบจริงโดยไม่บังคับลายเซ็น = ช่องโหว่
    // ต้องให้ครูยืนยันชัดเจนนก่อนเริ่มสอบ
    if (attestation?.devMode && !attestation.signatureEnforced) {
      const ok = window.confirm(
        '⚠️ คำเตือนความปลอดภัย\n\nกำลังเริ่มสอบใน DEV MODE โดย "ไม่ได้บังคับตรวจลายเซ็น" — เครื่องนักเรียนที่ถูกแก้ไขไฟล์แอปจะผ่านการตรวจได้\n\n• กด ตกลง = ยืนยันเริ่มสอบแบบไม่บังคับลายเซ็น (ซ้อม/พัฒนาเท่านั้น)\n• กด ยกเลิก = กลับไปกด "บังคับตรวจลายเซ็นจริง" ก่อน'
      )
      if (!ok) return
    }
    setStarting(true)
    try {
      await window.ztExam.startExam()
      setExamState('running')
      notify({ severity: 'info', message: 'เริ่มการสอบ — เครื่องนักเรียนทุกเครื่องได้รับข้อแรกแล้ว' })
    } catch (err) {
      notify({
        severity: 'critical',
        message: err instanceof Error ? translateHostError(err.message) : 'เริ่มการสอบไม่สำเร็จ'
      })
    } finally {
      setStarting(false)
    }
  }

  async function endExam(): Promise<void> {
    // I-07: confirm กันเผลอกดจบ + กันกดซ้ำตอน collecting
    if (examState === 'collecting') return
    if (!window.confirm('ยืนยันจบการสอบทั้งห้อง?\nนักเรียนทุกคนจะถูกเก็บคำตอบทันที การกระทำนี้ย้อนกลับไม่ได้')) return
    try {
      await window.ztExam.endExam()
      setExamState('collecting')
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
    // R1: ชั้นที่สอง — ส่งจริงหลังครูเห็นจำนวน+รายชื่อแล้ว; backend กัน AI ปนอีกชั้น
    const res = await window.ztExam.approveDomain({ domain: '*', approved: true })
    if (res.ok) {
      notify({ severity: 'info', message: `อนุมัติทั้งหมด (${res.updatedCount ?? 0} รายการ)` })
      setApproveConfirm(false)
    } else if (res.reason === 'FORBIDDEN_DOMAIN_PRESENT') {
      notify({ severity: 'warning', message: 'มีโดเมนชน AI ปนอยู่ — ห้ามอนุมัติทั้งหมด ต้องอนุมัติรายตัว' })
      setApproveConfirm(false)
    } else {
      notify({ severity: 'warning', message: 'อนุมัติทั้งหมดไม่สำเร็จ' })
    }
  }

  async function clearRecordedDomains(): Promise<void> {
    // R2: ล้างรายการ/เริ่ม record ใหม่ต่อห้อง (เช่น เผลอเปิดเว็บผิด)
    if (!window.confirm('ล้างรายการโดเมนที่ record ไว้ทั้งหมดของห้องนี้?\nต้องเปิดตรวจเอกสารใหม่อีกรอบเพื่อเก็บรายการใหม่')) return
    const res = await window.ztExam.clearRecordedDomains()
    if (res.ok) {
      setRecordedDomains([])
      setApproveConfirm(false)
      setRiskAck({})
      notify({ severity: 'info', message: 'ล้างรายการโดเมนแล้ว — เปิดตรวจเอกสารใหม่เพื่อเริ่ม record' })
    } else {
      notify({ severity: 'warning', message: 'ล้างรายการโดเมนไม่สำเร็จ' })
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
      setConnectionState('connected')
      // ค่าเริ่มต้นของการบังคับโดเมนสืบจาก enforcement ของห้อง (ครูตั้งทับได้ในการ์ด)
      setDomainEnforcement(enforcement === 'block-and-report' ? 'block' : 'warn')
      notify({ severity: 'info', message: `เปิดห้อง "${info.roomName}" สำเร็จ` })
    } catch (err) {
      notify({
        severity: 'critical',
        message: err instanceof Error ? translateHostError(err.message) : 'เปิดห้องไม่สำเร็จ'
      })
    } finally {
      setCreating(false)
    }
  }

  async function closeRoom(): Promise<void> {
    // I-07: บล็อกปิดห้องขณะกำลังสอบ/กำลังเก็บ — กันเผลอตัดการเชื่อมต่อทั้งห้อง
    if (examState === 'running' || examState === 'collecting') {
      notify({ severity: 'warning', message: 'กำลังสอบอยู่ — จบการสอบก่อนปิดห้อง' })
      return
    }
    if (!window.confirm('ปิดห้องสอบ?\nนักเรียนที่เชื่อมต่ออยู่จะหลุดทั้งหมด')) return
    await window.ztExam.closeRoom()
    setRoom(null)
    useHostNetworkStore.getState().setStudents([])
    setSummaries([])
    setExamState('idle')
    setLoadedExam(null)
    setConnectionState('offline')
    notify({ severity: 'warning', message: 'ปิดห้องสอบแล้ว' })
  }

  async function copy(label: string, value: string): Promise<void> {
    // TC-H16: clipboard อาจล้มเหลว (permission) — ดักไว้ + แจ้งครู
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      notify({ severity: 'warning', message: 'คัดลอกไม่สำเร็จ — อนุญาต clipboard หรือจดด้วยตนเอง' })
    }
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
            disabled={examState === 'running' || examState === 'collecting'}
            title={
              examState === 'running' || examState === 'collecting'
                ? 'กำลังสอบอยู่ — จบการสอบก่อนปิดห้อง'
                : 'ปิดห้องสอบ'
            }
            onClick={() => void closeRoom()}
            className="rounded-lg border border-red-800/60 px-3 py-1.5 text-sm text-red-300 transition hover:bg-red-950/60 disabled:opacity-40"
          >
            ปิดห้อง
          </button>
        </div>

        <div className="rounded-xl bg-slate-950 p-6 text-center">
          <div className="mb-1 flex items-center justify-center gap-2 text-sm text-slate-400">
            <KeyRound size={16} />
            Room PIN — ขึ้นบนจอหน้าห้องสอบ
          </div>
          <div className="flex items-center justify-center gap-3">
            <div className="font-mono text-6xl font-bold tracking-[0.3em] text-emerald-400">
              {room.roomPin}
            </div>
            <button
              type="button"
              title="คัดลอก Room PIN"
              onClick={() => void copy('pin', room.roomPin)}
              className="shrink-0 rounded-lg border border-slate-700 px-2.5 py-2 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
            >
              {copied === 'pin' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <dt className="text-xs text-slate-500">Room ID (สำหรับกรอกด้วยตนเอง)</dt>
            <dd className="mt-1 flex items-center gap-2">
              <code className="truncate font-mono text-xs text-slate-300">{room.roomId}</code>
              <button
                type="button"
                title="คัดลอก Room ID"
                onClick={() => void copy('id', room.roomId)}
                className="shrink-0 text-slate-500 hover:text-slate-200"
              >
                {copied === 'id' ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </dd>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <dt className="text-xs text-slate-500">TLS port + Cert fingerprint (ย่อ)</dt>
            <dd className="mt-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-500">port</span>
                <code className="font-mono text-xs text-slate-300">:{room.tcpPort}</code>
                <button
                  type="button"
                  title="คัดลอก TLS port"
                  onClick={() => void copy('port', String(room.tcpPort))}
                  className="shrink-0 text-slate-500 hover:text-slate-200"
                >
                  {copied === 'port' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-500">fingerprint</span>
                <code className="truncate font-mono text-xs text-slate-300">{room.certFpShort}…</code>
                <button
                  type="button"
                  title="คัดลอก Cert fingerprint (เต็ม)"
                  onClick={() => void copy('fp', room.certFingerprint)}
                  className="shrink-0 text-slate-500 hover:text-slate-200"
                >
                  {copied === 'fp' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
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
          {examState === 'collecting' && (
            <span className="ml-auto rounded-full border border-amber-800/60 bg-amber-950/40 px-3 py-1 text-xs text-amber-300">
              กำลังเก็บคำตอบ…
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
            {onlineStudents.length === 0 && !loadedExam && (
              <span className="text-xs text-slate-500">ยังไม่มีนักเรียนออนไลน์ — รอนักเรียนเข้าห้อง แล้วเลือกไฟล์ข้อสอบเพื่อเริ่ม</span>
            )}
            {onlineStudents.length === 0 && loadedExam && (
              <span className="text-xs text-slate-500">โหลดข้อสอบแล้ว — รอนักเรียนออนไลน์ก่อนเริ่มสอบ</span>
            )}
            {onlineStudents.length > 0 && !loadedExam && (
              <span className="text-xs text-slate-500">มีนักเรียนพร้อมแล้ว — เลือกไฟล์ข้อสอบเพื่อเริ่มการสอบ</span>
            )}
          </div>
        )}

        {(examState === 'running' || examState === 'collecting') && (
          <button
            type="button"
            disabled={examState === 'collecting'}
            onClick={() => void endExam()}
            className="inline-flex items-center gap-2 rounded-xl border border-red-800/60 px-4 py-2.5 text-sm text-red-300 transition hover:bg-red-950/60 disabled:opacity-40"
          >
            <StopCircle size={16} />
            {examState === 'collecting' ? 'กำลังเก็บคำตอบ…' : 'จบการสอบ (เก็บทั้งห้อง)'}
          </button>
        )}

        {summaries.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
              <GraduationCap size={14} /> ความคืบหน้ารายคน (อัตโนมัติเฉพาะปรนัย/เติมคำสั้น — อัตนัยรอครูตรวจ)
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
            {/* R4: warn = ตรวจจับอย่างเดียว ไม่ได้เตือนนักเรียน — ข้อความต้องไม่ทำให้เข้าใจผิด */}
            <option value="warn">ตรวจจับอย่างเดียว — ไม่บล็อก (นักเรียนยังเข้าได้)</option>
            <option value="block">บล็อก (ตัดทันที + แจ้งครู)</option>
          </select>

          {mergedDomains.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs text-slate-500">
                  โดเมนที่เว็บเอกสารเรียกใช้จริง ({mergedDomains.length} รายการ)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    title="ล้างรายการทั้งหมดของห้องนี้เพื่อเริ่ม record ใหม่"
                    onClick={() => void clearRecordedDomains()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800"
                  >
                    ล้างรายการ / เริ่มใหม่
                  </button>
                  {/* R1: ห้าม approve-all ถ้ามีแถวชน AI — บังคับอนุมัติรายตัว */}
                  {aiPendingDomains.length > 0 ? (
                    <span className="rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-300">
                      มีโดเมนชน AI {aiPendingDomains.length} รายการ — อนุมัติรายตัวเท่านั้น
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={pendingDomains.length === 0}
                      onClick={() => setApproveConfirm(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-800/60 px-3 py-1.5 text-xs text-emerald-300 transition hover:bg-emerald-950/60 disabled:opacity-40"
                    >
                      <ShieldCheck size={13} /> อนุญาตทั้งหมด
                    </button>
                  )}
                </div>
              </div>
              {/* R1: ยืนยันสองชั้น — แสดงจำนวน + รายชื่อที่จะอนุมัติก่อนส่งจริง */}
              {approveConfirm && aiPendingDomains.length === 0 && (
                <div className="mb-2 rounded-xl border border-amber-800/60 bg-amber-950/30 p-3">
                  <div className="text-xs font-semibold text-amber-200">
                    ยืนยันอนุมัติทั้งหมด {pendingDomains.length} รายการ:
                  </div>
                  <ul className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto text-xs text-amber-100/90">
                    {pendingDomains.map((r) => (
                      <li key={r.domain} className="truncate font-mono">
                        {r.domain} <span className="text-amber-300/70">({r.hits} ครั้ง)</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2.5 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void approveAllDomains()}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
                    >
                      ยืนยันอนุมัติ {pendingDomains.length} รายการ
                    </button>
                    <button
                      type="button"
                      onClick={() => setApproveConfirm(false)}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800"
                    >
                      ยกเลิก
                    </button>
                  </div>
                </div>
              )}
              <ul className="max-h-64 space-y-1.5 overflow-y-auto">
                {mergedDomains.map((r) => {
                  const ai = isKnownForbiddenDomain(r.domain)
                  const acked = riskAck[r.domain] === true
                  return (
                    <li
                      key={r.domain}
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
                          {ai && (
                            <span className="rounded bg-red-950/60 px-1.5 py-0.5 text-[10px] text-red-300">
                              ชนโดเมน AI — ค่าเริ่มต้นบล็อก
                            </span>
                          )}
                          {r.sources.includes('top-url') && (
                            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                              โดเมนหลัก (รอครูอนุมัติ)
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-slate-500">
                          {/* R2: แสดง URL ต้นทางของแต่ละโดเมน */}
                          ต้นทาง {r.topDomains.map((t) => `https://${t}`).join(', ')} · {r.hits} ครั้ง
                        </div>
                        {/* R3: แถวชน AI ต้องติ๊กรับทราบความเสี่ยงรายตัวก่อนปุ่มอนุญาตกดได้ */}
                        {ai && !r.approved && (
                          <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-red-300/90">
                            <input
                              type="checkbox"
                              checked={acked}
                              onChange={(e) =>
                                setRiskAck((prev) => ({ ...prev, [r.domain]: e.target.checked }))
                              }
                              className="accent-red-500"
                            />
                            รับทราบความเสี่ยง: โดเมนนี้เกี่ยวกับ AI — อนุญาตให้นักเรียนเข้าถึงได้
                          </label>
                        )}
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
                          disabled={ai && !acked}
                          title={ai && !acked ? 'ติ๊กรับทราบความเสี่ยงก่อนอนุญาต' : 'อนุญาตโดเมนนี้'}
                          onClick={() => void approveDomain(r.domain, true)}
                          className="shrink-0 rounded-lg border border-emerald-800/60 px-2.5 py-1 text-xs text-emerald-300 transition hover:bg-emerald-950/60 disabled:opacity-40"
                        >
                          อนุญาต
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ---------- Triage Dashboard (Phase 3b): hash chain + คัดกรองคนแดง ---------- */}
      <TriageDashboard students={students} summaries={summaries} canExport={examState === 'finished'} />

      {/* ---------- Attestations (Phase 4): DEV MODE banner + สวิตช์บังคับตรวจลายเซ็น ---------- */}
      {/* NC-09: production (devMode=false) แสดงสถานะย่อด้วย — ครูเห็นว่ากำลังบังคับลายเซ็นจริงอยู่ */}
      {attestation && !attestation.devMode && (
        <div className="rounded-2xl border border-emerald-800/50 bg-emerald-950/20 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldQuestion size={18} className="text-emerald-300" />
            <span className="font-semibold text-emerald-200">
              ✅ บังคับตรวจลายเซ็น Manifest (production)
            </span>
            <span className="ml-auto text-xs text-emerald-300/70">
              {attestation.trackedStudents.length > 0
                ? `ตรวจแล้ว ${attestation.trackedStudents.filter((t) => t.signed).length}/${attestation.trackedStudents.length} คน · platform: ${attestation.platform}`
                : `platform: ${attestation.platform}`}
            </span>
          </div>
        </div>
      )}
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

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
import NetworkGatewayPanel from '../core-host/dashboard/NetworkGatewayPanel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Badge } from './ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { Skeleton } from './ui/skeleton'
import { ScrollArea } from './ui/scroll-area'
import { cn } from '../lib/utils'

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

const EXAM_STATE_META: Record<
  'idle' | 'running' | 'collecting' | 'finished',
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  idle: { label: 'รอเริ่มสอบ', variant: 'outline' },
  running: { label: 'กำลังสอบ', variant: 'default' },
  collecting: { label: 'กำลังเก็บคำตอบ', variant: 'secondary' },
  finished: { label: 'จบแล้ว', variant: 'outline' }
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

  /* ---------- ยืนยัน destructive 2 ชั้นผ่าน Dialog (แทน native confirm เดิม) ---------- */
  const [confirmClose, setConfirmClose] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmDevStart, setConfirmDevStart] = useState(false)

  /* ---------- Guard events (Phase 3a) — notify เหตุการณ์วิกฤต / triage จัดการแสดงผลเอง ---------- */
  const studentNames = new Map(students.map((s) => [s.studentId, s.studentName]))

  /* ---------- Doc Preview & Domain Allowlist (Phase 3a-plus) ---------- */
  const [docUrl, setDocUrl] = useState('')
  const [recordedDomains, setRecordedDomains] = useState<RecordedDomainItem[]>([])
  const [domainEnforcement, setDomainEnforcement] = useState<'warn' | 'block'>('warn')
  const [openingDoc, setOpeningDoc] = useState(false)
  /* R1: ยืนยันอนุมัติทั้งหมดสองชั้น (Dialog แสดงจำนวน + รายชื่อ) */
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
    // TRI-06: ผูก muted + กรอง severity กับ toast/severity alert จริง — mute แล้วเงียบทั้งหมด
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

  // R1: ปิด Dialog ยืนยันอัตโนมัติเมื่อไม่มีรายการรอแล้ว (กันกดยืนยันซ้ำกับรายการว่าง)
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

  /** เริ่มสอบจริง (หลังผ่าน Dialog ยืนยัน DEV MODE ถ้าจำเป็น) */
  async function doStartExam(): Promise<void> {
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

  function requestStartExam(): void {
    // NC-09: กันลืม enforce — dev build หลุดไปสอบจริงโดยไม่บังคับลายเซ็น = ช่องโหว่
    // ต้องให้ครูยืนยันชัดเจนผ่าน Dialog ก่อนเริ่มสอบ
    if (attestation?.devMode && !attestation.signatureEnforced) {
      setConfirmDevStart(true)
      return
    }
    void doStartExam()
  }

  function requestEndExam(): void {
    // I-07: กันเผลอกดจบ + กันกดซ้ำตอน collecting
    if (examState === 'collecting') return
    setConfirmEnd(true)
  }

  async function doEndExam(): Promise<void> {
    setConfirmEnd(false)
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

  function requestClearDomains(): void {
    // R2: ล้างรายการ/เริ่ม record ใหม่ต่อห้อง (เช่น เผลอเปิดเว็บผิด)
    setConfirmClear(true)
  }

  async function doClearRecordedDomains(): Promise<void> {
    setConfirmClear(false)
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

  async function changeDomainEnforcement(m: 'warn' | 'block'): Promise<void> {
    setDomainEnforcement(m)
    await window.ztExam.setDomainEnforcement({ mode: m })
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

  function requestCloseRoom(): void {
    // I-07: บล็อกปิดห้องขณะกำลังสอบ/กำลังเก็บ — กันเผลอตัดการเชื่อมต่อทั้งห้อง
    if (examState === 'running' || examState === 'collecting') {
      notify({ severity: 'warning', message: 'กำลังสอบอยู่ — จบการสอบก่อนปิดห้อง' })
      return
    }
    setConfirmClose(true)
  }

  async function doCloseRoom(): Promise<void> {
    setConfirmClose(false)
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
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <DoorOpen size={20} className="text-primary" />
              <CardTitle>เปิดห้องสอบ</CardTitle>
            </div>
            <CardDescription>ตั้งชื่อห้องและนโยบายก่อนให้นักเรียนเข้าห้อง</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="room-name">ชื่อห้อง</Label>
              <Input
                id="room-name"
                value={roomName}
                maxLength={80}
                onChange={(e) => setRoomName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mode">โหมดการสอบ</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as ExamMode)}>
                <SelectTrigger id="mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(MODE_LABELS) as ExamMode[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {MODE_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="enforcement">นโยบายบังคับ</Label>
              <Select value={enforcement} onValueChange={(v) => setEnforcement(v as EnforcementMode)}>
                <SelectTrigger id="enforcement">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="report-only">Report-only — ตรวจจับและฟ้อง</SelectItem>
                  <SelectItem value="block-and-report">Block &amp; Report — บล็อกพร้อมฟ้อง</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              className="w-full"
              disabled={creating || roomName.trim().length === 0}
              onClick={() => void createRoom()}
            >
              {creating ? 'กำลังสร้างคีย์ + เปิด TLS…' : 'เปิดห้องสอบ'}
            </Button>
          </CardContent>
        </Card>
        <NetworkGatewayPanel examMode={mode} />
      </div>
    )
  }

  const onlineStudents = students.filter((s) => s.online)
  const examMeta = EXAM_STATE_META[examState]

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      {/* ---------- Room info ---------- */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <DoorClosed size={20} className="text-primary" />
              <CardTitle>{room.roomName}</CardTitle>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={examState === 'running' || examState === 'collecting'}
              title={
                examState === 'running' || examState === 'collecting'
                  ? 'กำลังสอบอยู่ — จบการสอบก่อนปิดห้อง'
                  : 'ปิดห้องสอบ'
              }
              onClick={requestCloseRoom}
            >
              ปิดห้อง
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg bg-muted p-6 text-center">
            <div className="mb-1 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <KeyRound size={16} />
              Room PIN — ขึ้นบนจอหน้าห้องสอบ
            </div>
            <div className="flex items-center justify-center gap-2">
              <div className="font-mono text-4xl font-bold tracking-widest tabular-nums">
                {room.roomPin}
              </div>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="คัดลอก Room PIN"
                      onClick={() => void copy('pin', room.roomPin)}
                    >
                      {copied === 'pin' ? <Check size={16} /> : <Copy size={16} />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>คัดลอก Room PIN</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          <TooltipProvider>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>รายการ</TableHead>
                  <TableHead>ค่า</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">คัดลอก</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="text-muted-foreground">Room ID (สำหรับกรอกด้วยตนเอง)</TableCell>
                  <TableCell>
                    <code className="font-mono text-xs tabular-nums">{room.roomId}</code>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="คัดลอก Room ID"
                          onClick={() => void copy('id', room.roomId)}
                        >
                          {copied === 'id' ? <Check size={16} /> : <Copy size={16} />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>คัดลอก Room ID</TooltipContent>
                    </Tooltip>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">TLS port</TableCell>
                  <TableCell>
                    <code className="font-mono text-xs tabular-nums">:{room.tcpPort}</code>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="คัดลอก TLS port"
                          onClick={() => void copy('port', String(room.tcpPort))}
                        >
                          {copied === 'port' ? <Check size={16} /> : <Copy size={16} />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>คัดลอก TLS port</TooltipContent>
                    </Tooltip>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">Cert fingerprint (ย่อ)</TableCell>
                  <TableCell>
                    <code className="font-mono text-xs tabular-nums">{room.certFpShort}…</code>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="คัดลอก Cert fingerprint (เต็ม)"
                          onClick={() => void copy('fp', room.certFingerprint)}
                        >
                          {copied === 'fp' ? <Check size={16} /> : <Copy size={16} />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>คัดลอก Cert fingerprint (เต็ม)</TooltipContent>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TooltipProvider>
        </CardContent>
      </Card>

      {/* ---------- Host-as-Gateway (security item 2): DHCP/DNS/forwarding ---------- */}
      <NetworkGatewayPanel examMode={room.mode} />

      {/* ---------- Exam Core (Phase 2): โหลดข้อสอบ + เริ่ม/จบ + ความคืบหน้า ---------- */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ClipboardList size={18} className="text-primary" />
            <CardTitle>ข้อสอบและการเริ่มการสอบ</CardTitle>
            <Badge variant={examMeta.variant} className="ml-auto">
              {examMeta.label}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {examState === 'idle' && (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" disabled={picking} onClick={() => void selectExamFile()}>
                <FileUp size={16} />
                {picking ? 'กำลังอ่านไฟล์…' : 'เลือกไฟล์ข้อสอบ (JSON)'}
              </Button>
              {loadedExam && (
                <>
                  <div className="text-sm">
                    <span className="font-semibold">{loadedExam.title}</span>
                    <span className="text-muted-foreground"> · {loadedExam.questionCount} ข้อ</span>
                  </div>
                  <Button
                    type="button"
                    disabled={starting || onlineStudents.length === 0}
                    onClick={requestStartExam}
                    className="ml-auto"
                  >
                    <Play size={16} />
                    {starting ? 'กำลังเริ่ม…' : 'เริ่มการสอบ'}
                  </Button>
                </>
              )}
              {onlineStudents.length === 0 && !loadedExam && (
                <span className="text-xs text-muted-foreground">
                  ยังไม่มีนักเรียนออนไลน์ — รอนักเรียนเข้าห้อง แล้วเลือกไฟล์ข้อสอบเพื่อเริ่ม
                </span>
              )}
              {onlineStudents.length === 0 && loadedExam && (
                <span className="text-xs text-muted-foreground">โหลดข้อสอบแล้ว — รอนักเรียนออนไลน์ก่อนเริ่มสอบ</span>
              )}
              {onlineStudents.length > 0 && !loadedExam && (
                <span className="text-xs text-muted-foreground">มีนักเรียนพร้อมแล้ว — เลือกไฟล์ข้อสอบเพื่อเริ่มการสอบ</span>
              )}
            </div>
          )}

          {(examState === 'running' || examState === 'collecting') && (
            <Button
              type="button"
              variant="destructive"
              disabled={examState === 'collecting'}
              onClick={requestEndExam}
            >
              <StopCircle size={16} />
              {examState === 'collecting' ? 'กำลังเก็บคำตอบ…' : 'จบการสอบ (เก็บทั้งห้อง)'}
            </Button>
          )}

          {summaries.length > 0 ? (
            <div className="mt-5 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <GraduationCap size={14} /> ความคืบหน้ารายคน (อัตโนมัติเฉพาะปรนัย/เติมคำสั้น — อัตนัยรอครูตรวจ)
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ชื่อ</TableHead>
                    <TableHead>ข้อที่ทำ</TableHead>
                    <TableHead>ความคืบหน้า</TableHead>
                    <TableHead className="text-right">คะแนน</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summaries.map((s) => {
                    const pct = s.totalQuestions > 0 ? (s.maxReachedCursor / s.totalQuestions) * 100 : 0
                    return (
                      <TableRow key={s.studentId}>
                        <TableCell className="font-medium">{s.studentName}</TableCell>
                        <TableCell className="font-mono tabular-nums">
                          {s.maxReachedCursor}/{s.totalQuestions}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary transition-all"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {Math.round(pct)}%
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{s.awardedPoints}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            (examState === 'running' || examState === 'collecting') && (
              <div className="mt-5 space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            )
          )}
        </CardContent>
      </Card>

      {/* ---------- เตรียมเอกสาร & โดเมนที่อนุญาต (Phase 3a-plus — Mode 2) ---------- */}
      {isDocsMode && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Globe size={18} className="text-primary" />
              <CardTitle>เตรียมเอกสาร &amp; โดเมนที่อนุญาต</CardTitle>
              {pendingDomains.length > 0 && (
                <Badge variant="secondary" className="ml-auto">
                  รอตัดสิน {pendingDomains.length} รายการ
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-60 flex-1">
                <ExternalLink
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={docUrl}
                  onChange={(e) => setDocUrl(e.target.value)}
                  placeholder="https://docs.example.com/exam-material"
                  className="pl-9"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={!isLobby || openingDoc || docUrl.trim().length === 0}
                onClick={() => void openDocPreview()}
              >
                {openingDoc ? 'กำลังเปิด…' : 'เปิดตรวจเอกสาร'}
              </Button>
            </div>
            {!isLobby && (
              <p className="mt-2 text-xs text-muted-foreground">
                การเปิดเอกสารทำได้เฉพาะช่วงเตรียมห้อง (ก่อนเริ่มสอบ)
              </p>
            )}

            <div className="mt-4 max-w-xs space-y-1.5">
              <Label htmlFor="domain-enforcement">เมื่อนักเรียนใช้โดเมนนอกเหนือรายการ</Label>
              <Select value={domainEnforcement} onValueChange={(v) => void changeDomainEnforcement(v as 'warn' | 'block')}>
                <SelectTrigger id="domain-enforcement">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* R4: warn = ตรวจจับอย่างเดียว ไม่ได้เตือนนักเรียน — ข้อความต้องไม่ทำให้เข้าใจผิด */}
                  <SelectItem value="warn">ตรวจจับอย่างเดียว — ไม่บล็อก (นักเรียนยังเข้าได้)</SelectItem>
                  <SelectItem value="block">บล็อก (ตัดทันที + แจ้งครู)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {mergedDomains.length > 0 && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    โดเมนที่เว็บเอกสารเรียกใช้จริง ({mergedDomains.length} รายการ)
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      title="ล้างรายการทั้งหมดของห้องนี้เพื่อเริ่ม record ใหม่"
                      onClick={requestClearDomains}
                    >
                      ล้างรายการ / เริ่มใหม่
                    </Button>
                    {/* R1: ห้าม approve-all ถ้ามีแถวชน AI — บังคับอนุมัติรายตัว */}
                    {aiPendingDomains.length > 0 ? (
                      <Badge variant="destructive">
                        มีโดเมนชน AI {aiPendingDomains.length} รายการ — อนุมัติรายตัวเท่านั้น
                      </Badge>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pendingDomains.length === 0}
                        onClick={() => setApproveConfirm(true)}
                      >
                        <ShieldCheck size={13} /> อนุญาตทั้งหมด
                      </Button>
                    )}
                  </div>
                </div>
                <ScrollArea className="max-h-64">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>โดเมน</TableHead>
                        <TableHead>เรียกใช้</TableHead>
                        <TableHead>สถานะ</TableHead>
                        <TableHead className="text-right">จัดการ</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {mergedDomains.map((r) => {
                        const ai = isKnownForbiddenDomain(r.domain)
                        const acked = riskAck[r.domain] === true
                        return (
                          <TableRow key={r.domain}>
                            <TableCell>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <code className="font-mono text-xs">{r.domain}</code>
                                {ai && <Badge variant="destructive">ชนโดเมน AI — ค่าเริ่มต้นบล็อก</Badge>}
                                {r.sources.includes('top-url') && (
                                  <Badge variant="outline">โดเมนหลัก (รอครูอนุมัติ)</Badge>
                                )}
                              </div>
                              <div className="mt-0.5 text-[11px] text-muted-foreground">
                                {/* R2: แสดง URL ต้นทางของแต่ละโดเมน */}
                                ต้นทาง {r.topDomains.map((t) => `https://${t}`).join(', ')} · {r.hits} ครั้ง
                              </div>
                              {/* R3: แถวชน AI ต้องติ๊กรับทราบความเสี่ยงรายตัวก่อนปุ่มอนุญาตกดได้ */}
                              {ai && !r.approved && (
                                <Label className="mt-1 flex cursor-pointer items-center gap-1.5 text-[11px] font-normal">
                                  <input
                                    type="checkbox"
                                    checked={acked}
                                    onChange={(e) =>
                                      setRiskAck((prev) => ({ ...prev, [r.domain]: e.target.checked }))
                                    }
                                  />
                                  รับทราบความเสี่ยง: โดเมนนี้เกี่ยวกับ AI — อนุญาตให้นักเรียนเข้าถึงได้
                                </Label>
                              )}
                            </TableCell>
                            <TableCell className="font-mono tabular-nums">{r.hits}</TableCell>
                            <TableCell>
                              {r.approved ? (
                                <Badge variant="default">
                                  <CheckCircle2 /> อนุมัติแล้ว
                                </Badge>
                              ) : (
                                <Badge variant="secondary">
                                  <CircleDashed /> รอตัดสิน
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {r.approved ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void approveDomain(r.domain, false)}
                                >
                                  ยกเลิก
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={ai && !acked}
                                  title={ai && !acked ? 'ติ๊กรับทราบความเสี่ยงก่อนอนุญาต' : 'อนุญาตโดเมนนี้'}
                                  onClick={() => void approveDomain(r.domain, true)}
                                >
                                  อนุญาต
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ---------- Triage Dashboard (Phase 3b): hash chain + คัดกรองคนแดง ---------- */}
      <TriageDashboard students={students} summaries={summaries} canExport={examState === 'finished'} />

      {/* ---------- Attestations (Phase 4): DEV MODE banner + สวิตช์บังคับตรวจลายเซ็น ---------- */}
      {/* NC-09: production (devMode=false) แสดงสถานะย่อด้วย — ครูเห็นว่ากำลังบังคับลายเซ็นจริงอยู่ */}
      {attestation === null ? (
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      ) : !attestation.devMode ? (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2 pt-6">
            <ShieldQuestion size={18} className="text-primary" />
            <Badge variant="default">production — บังคับตรวจลายเซ็น Manifest</Badge>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {attestation.trackedStudents.length > 0
                ? `ตรวจแล้ว ${attestation.trackedStudents.filter((t) => t.signed).length}/${attestation.trackedStudents.length} คน · platform: ${attestation.platform}`
                : `platform: ${attestation.platform}`}
            </span>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldQuestion size={18} className="text-primary" />
              <Badge variant={attestation.signatureEnforced ? 'secondary' : 'destructive'}>
                DEV MODE: อนุญาต Client ที่ไม่ได้เซ็นลายเซ็น
              </Badge>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => void setAttestationEnforcement(!attestation.signatureEnforced)}
              >
                {attestation.signatureEnforced ? 'ตรวจลายเซ็นจริง: เปิด' : 'บังคับตรวจลายเซ็นจริง'}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Manifest {attestation.signatureEnforced ? 'ต้องผ่านลายเซ็น Ed25519' : 'ยอมรับแม้ไม่มีลายเซ็น (พัฒนาเท่านั้น)'}
              {' · '}platform: {attestation.platform}
              {attestation.trackedStudents.length > 0 &&
                ` · ตรวจแล้ว ${attestation.trackedStudents.filter((t) => t.signed).length}/${attestation.trackedStudents.length} คน`}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ---------- Students ---------- */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Users size={18} className="text-primary" />
            <CardTitle>นักเรียน ({onlineStudents.length} ออนไลน์)</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {students.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              ยังไม่มีใครเข้าห้อง — นักเรียนในวง LAN เดียวกันจะเห็นห้องนี้อัตโนมัติ
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ชื่อ</TableHead>
                  <TableHead>รหัสนักเรียน</TableHead>
                  <TableHead>สถานะ</TableHead>
                  <TableHead>โฟกัส</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {students.map((s) => (
                  <TableRow key={s.studentId}>
                    <TableCell className="font-medium">{s.studentName}</TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                      {s.studentId}
                    </TableCell>
                    <TableCell>
                      {s.online ? (
                        <Badge variant="default">
                          <Wifi /> ออนไลน์
                        </Badge>
                      ) : (
                        <Badge variant="destructive">
                          <WifiOff /> ออฟไลน์
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {s.focusState === 'blurred' || s.focusState === 'fullscreen-exit' ? (
                        <Badge variant="secondary">
                          <ShieldAlert /> เสียโฟกัส
                        </Badge>
                      ) : (
                        <span className={cn('text-xs text-muted-foreground')}>
                          {s.online ? 'โฟกัสปกติ' : 'ออฟไลน์'}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ---------- Dialog ยืนยัน 2 ชั้น (แทน native confirm เดิมทั้งหมด) ---------- */}
      <Dialog open={confirmDevStart} onOpenChange={setConfirmDevStart}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>เริ่มสอบโดยไม่บังคับลายเซ็น?</DialogTitle>
            <DialogDescription>
              กำลังเริ่มสอบใน DEV MODE โดยไม่ได้บังคับตรวจลายเซ็น — เครื่องนักเรียนที่ถูกแก้ไขไฟล์แอปจะผ่านการตรวจได้
              เหมาะกับการซ้อม/พัฒนาเท่านั้น กดยืนยันเพื่อเริ่มสอบ หรือยกเลิกเพื่อกลับไปกดบังคับตรวจลายเซ็นจริงก่อน
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmDevStart(false)}>
              ยกเลิก
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmDevStart(false)
                void doStartExam()
              }}
            >
              ยืนยันเริ่มสอบ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmEnd} onOpenChange={setConfirmEnd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ยืนยันจบการสอบทั้งห้อง?</DialogTitle>
            <DialogDescription>
              นักเรียนทุกคนจะถูกเก็บคำตอบทันที การกระทำนี้ย้อนกลับไม่ได้
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmEnd(false)}>
              ยกเลิก
            </Button>
            <Button type="button" variant="destructive" onClick={() => void doEndExam()}>
              จบการสอบ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ปิดห้องสอบ?</DialogTitle>
            <DialogDescription>นักเรียนที่เชื่อมต่ออยู่จะหลุดทั้งหมด</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmClose(false)}>
              ยกเลิก
            </Button>
            <Button type="button" variant="destructive" onClick={() => void doCloseRoom()}>
              ปิดห้อง
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ล้างรายการโดเมน?</DialogTitle>
            <DialogDescription>
              ล้างรายการโดเมนที่ record ไว้ทั้งหมดของห้องนี้ ต้องเปิดตรวจเอกสารใหม่อีกรอบเพื่อเก็บรายการใหม่
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmClear(false)}>
              ยกเลิก
            </Button>
            <Button type="button" variant="destructive" onClick={() => void doClearRecordedDomains()}>
              ล้างรายการ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* R1: ยืนยันอนุมัติทั้งหมดสองชั้น — แสดงจำนวน + รายชื่อที่จะอนุมัติก่อนส่งจริง */}
      <Dialog open={approveConfirm} onOpenChange={setApproveConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ยืนยันอนุมัติทั้งหมด {pendingDomains.length} รายการ?</DialogTitle>
            <DialogDescription>
              โดเมนต่อไปนี้จะถูกเพิ่มใน allowlist ของห้องสอบ ตรวจสอบรายชื่อก่อนยืนยัน
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-48">
            <ul className="space-y-0.5 text-xs">
              {pendingDomains.map((r) => (
                <li key={r.domain} className="truncate font-mono tabular-nums">
                  {r.domain} <span className="text-muted-foreground">({r.hits} ครั้ง)</span>
                </li>
              ))}
            </ul>
          </ScrollArea>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setApproveConfirm(false)}>
              ยกเลิก
            </Button>
            <Button type="button" onClick={() => void approveAllDomains()}>
              ยืนยันอนุมัติ {pendingDomains.length} รายการ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

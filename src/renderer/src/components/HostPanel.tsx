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
  ShieldAlert
} from 'lucide-react'
import type { ExamMode, EnforcementMode } from '@shared/types/exam'
import { useHostNetworkStore } from '../store/network-store'
import { useAppStore } from '../store/app-store'

const MODE_LABELS: Record<ExamMode, string> = {
  closed: 'Closed — ปิดเครือข่าย',
  'in-app-docs': 'In-App Docs — เอกสารในแอป',
  'external-tools': 'External Tools — อนุญาต VS Code'
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

  useEffect(() => {
    // กู้สถานะห้องเมื่อกลับมาที่หน้านี้ (เช่น reload)
    void window.ztExam.getRoom().then((res) => setRoom(res.room))
    const unsub = window.ztExam.onEvent('host:students-updated', (event) =>
      useHostNetworkStore.getState().setStudents(event.students)
    )
    return unsub
  }, [setRoom])

  async function createRoom(): Promise<void> {
    setCreating(true)
    try {
      const info = await window.ztExam.createRoom({ roomName, mode, enforcement })
      setRoom(info)
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

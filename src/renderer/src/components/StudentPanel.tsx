import { useEffect, useMemo, useState } from 'react'
import {
  Radio,
  RefreshCw,
  KeyRound,
  PlugZap,
  Lock,
  ShieldAlert,
  Clock,
  Search
} from 'lucide-react'
import type { DiscoveredRoom } from '@shared/protocol-schema'
import { useStudentNetworkStore } from '../store/network-store'
import { useAppStore } from '../store/app-store'

function timeSince(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`
}

export default function StudentPanel(): React.JSX.Element {
  const rooms = useStudentNetworkStore((s) => s.rooms)
  const connection = useStudentNetworkStore((s) => s.connection)
  const joinError = useStudentNetworkStore((s) => s.joinError)
  const setJoinError = useStudentNetworkStore((s) => s.setJoinError)
  const notify = useAppStore((s) => s.notify)

  const [selected, setSelected] = useState<DiscoveredRoom | null>(null)
  const [pin, setPin] = useState('')
  const [studentId, setStudentId] = useState('')
  const [studentName, setStudentName] = useState('')
  const [joining, setJoining] = useState(false)

  // manual fallback
  const [manualOpen, setManualOpen] = useState(false)
  const [manualHost, setManualHost] = useState('')
  const [manualRoomId, setManualRoomId] = useState('')

  useEffect(() => {
    void window.ztExam.startDiscovery()
    const unsubRooms = window.ztExam.onEvent('network:rooms-updated', (event) =>
      useStudentNetworkStore.getState().setRooms(event.rooms)
    )
    const unsubConn = window.ztExam.onEvent('network:connection-state', (event) =>
      useStudentNetworkStore.getState().setConnection(event)
    )
    return () => {
      unsubRooms()
      unsubConn()
      void window.ztExam.stopDiscovery()
    }
  }, [])

  async function join(ip: string, port: number, roomId: string): Promise<void> {
    if (!/^\d{6}$/.test(pin)) {
      setJoinError('กรอก PIN 6 หลัก')
      return
    }
    if (studentId.trim().length === 0 || studentName.trim().length === 0) {
      setJoinError('กรอกรหัสและชื่อนักเรียน')
      return
    }
    setJoinError(null)
    setJoining(true)
    try {
      const result = await window.ztExam.joinRoom({
        hostIp: ip,
        hostPort: port,
        roomId,
        roomPin: pin,
        studentId: studentId.trim(),
        studentName: studentName.trim()
      })
      if (result.ok) {
        notify({ severity: 'info', message: 'เข้าห้องสอบสำเร็จ — รอเริ่มข้อสอบ (Phase 2)' })
      } else {
        setJoinError(result.reason ?? 'เข้าห้องไม่สำเร็จ')
      }
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'เข้าห้องไม่สำเร็จ')
    } finally {
      setJoining(false)
    }
  }

  const statusBanner = useMemo(() => {
    switch (connection.state) {
      case 'ready':
        return { icon: Lock, color: 'border-emerald-700/50 bg-emerald-950/40 text-emerald-200', text: 'เชื่อมต่อเครื่องแม่สำเร็จ — รอเริ่มสอบ' }
      case 'connecting':
      case 'reconnecting':
        return { icon: RefreshCw, color: 'border-sky-700/50 bg-sky-950/40 text-sky-200', text: 'กำลังเชื่อมต่อเครื่องแม่…' }
      case 'frozen':
        return { icon: ShieldAlert, color: 'border-amber-700/50 bg-amber-950/40 text-amber-200', text: `ขาดการติดต่อกับเครื่องแม่ — กำลังเชื่อมต่อใหม่ (${connection.reason ?? ''})` }
      case 'rejected':
        return { icon: ShieldAlert, color: 'border-red-800/60 bg-red-950/40 text-red-200', text: `เข้าห้องไม่ได้: ${connection.reason ?? 'unknown'}` }
      case 'closed':
        return { icon: Clock, color: 'border-slate-700 bg-slate-900 text-slate-300', text: 'ห้องปิดแล้ว' }
      default:
        return null
    }
  }, [connection])

  const frozenFull = connection.state === 'frozen'

  return (
    <div className="relative h-full">
      {/* Fail-closed overlay บังทุกอย่างเมื่อหลุดการเชื่อมต่อ */}
      {frozenFull && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-slate-950/95">
          <ShieldAlert size={48} className="mb-4 text-amber-400" />
          <h2 className="text-lg font-semibold text-amber-200">ขาดการติดต่อกับเครื่องแม่</h2>
          <p className="mt-2 text-sm text-slate-400">กำลังเชื่อมต่อใหม่อัตโนมัติ… ห้ามปิดแอป</p>
        </div>
      )}

      <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
        {statusBanner && (
          <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-sm ${statusBanner.color}`}>
            <statusBanner.icon size={16} />
            {statusBanner.text}
          </div>
        )}

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="mb-4 flex items-center gap-2">
            <Radio size={18} className="text-sky-400" />
            <h2 className="font-semibold">ห้องสอบในวง LAN ({rooms.length})</h2>
            <span className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500">
              <Search size={12} /> UDP discovery ทุก 2 วิ
            </span>
          </div>
          {rooms.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              ยังไม่พบห้องสอบ — ให้ครูเปิดห้องก่อน หรือกรอก IP เองด้านล่าง
            </p>
          ) : (
            <ul className="space-y-2">
              {rooms.map((room) => (
                <li key={room.roomId}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(room)
                      setManualRoomId(room.roomId)
                    }}
                    className={`w-full rounded-xl border p-4 text-left transition ${
                      selected?.roomId === room.roomId
                        ? 'border-sky-500/70 bg-sky-950/30'
                        : 'border-slate-800 bg-slate-950/40 hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{room.roomName}</span>
                      <span className="flex items-center gap-1 text-xs text-slate-500">
                        <Clock size={12} />
                        {timeSince(room.lastSeenAtMs)}ที่แล้ว
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {room.sourceIp}:{room.tcpPort} · {room.hostName} · นักเรียน {room.studentCount} คน
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-slate-600">
                      cert {room.certFpShort}…
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="mb-4 flex items-center gap-2">
            <KeyRound size={18} className="text-emerald-400" />
            <h2 className="font-semibold">เข้าห้องสอบ</h2>
          </div>

          {!selected && !manualOpen && (
            <p className="text-sm text-slate-500">เลือกห้องจากรายการด้านบน หรือ</p>
          )}
          {!selected && (
            <button
              type="button"
              onClick={() => setManualOpen((v) => !v)}
              className="mt-2 text-sm text-sky-400 hover:text-sky-300"
            >
              {manualOpen ? '− ซ่อนช่องกรอกด้วยตนเอง' : '+ กรอก IP เครื่องแม่ด้วยตนเอง'}
            </button>
          )}

          {manualOpen && !selected && (
            <div className="mb-4 mt-3 grid grid-cols-2 gap-3">
              <input
                placeholder="เครื่องแม่ (192.168.1.10:44456)"
                value={manualHost}
                onChange={(e) => setManualHost(e.target.value)}
                className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
              />
              <input
                placeholder="Room ID"
                value={manualRoomId}
                onChange={(e) => setManualRoomId(e.target.value)}
                className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm focus:border-sky-500 focus:outline-none"
              />
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">รหัสนักเรียน</span>
              <input
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">ชื่อ-นามสกุล</span>
              <input
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">Room PIN (จากจอครู)</span>
              <input
                value={pin}
                inputMode="numeric"
                maxLength={6}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                placeholder="••••••"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-lg tracking-[0.3em] focus:border-emerald-500 focus:outline-none"
              />
            </label>
          </div>

          {joinError && (
            <p className="mt-3 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {joinError}
            </p>
          )}

          <button
            type="button"
            disabled={joining}
            onClick={() => {
              const target = selected
              if (target) {
                void join(target.sourceIp, target.tcpPort, target.roomId)
              } else if (manualOpen) {
                const m = manualHost.match(/^(.+):(\d+)$/)
                if (!m || !manualRoomId.trim()) {
                  setJoinError('รูปแบบ IP:Port หรือ Room ID ไม่ถูกต้อง')
                  return
                }
                void join(m[1]!, Number.parseInt(m[2]!, 10), manualRoomId.trim())
              } else {
                setJoinError('เลือกห้องก่อน หรือกรอก IP เครื่องแม่')
              }
            }}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-3 font-semibold text-white transition hover:bg-sky-500 disabled:opacity-40"
          >
            <PlugZap size={18} />
            {joining ? 'กำลังตรวจ PIN + fingerprint…' : 'เข้าห้องสอบ'}
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import {
  Radio,
  RefreshCw,
  KeyRound,
  PlugZap,
  Lock,
  ShieldAlert,
  Clock,
  Search,
  Loader2,
  Wifi,
  WifiOff
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { DiscoveredRoom } from '@shared/protocol-schema'
import { useStudentNetworkStore } from '../store/network-store'
import { useAppStore } from '../store/app-store'
import { useStudentExamStore } from '../store/exam-store'
import { getScreenWorker } from '../student/screen-worker'
import ExamView from '../core-student/ExamView'
import ProctorOverlay from '../core-student/ProctorOverlay'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Badge } from './ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { Skeleton } from './ui/skeleton'
import { ScrollArea } from './ui/scroll-area'
import { cn } from '../lib/utils'

function timeSince(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s} วิ`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} นาที`
  return `${Math.floor(m / 60)} ชม`
}

/** แยก host:port จากช่อง manual — trim, ตัด scheme http(s)://, รองรับ IPv6 `[::1]:port`, เช็ค port 1–65535 (NC-05) */
function parseManualHost(input: string): { ip: string; port: number } | null {
  // ตัด scheme ที่ผู้ใช้เผลอวางมา (เช่น copy URL) + ตัด path/query ที่ติดมา
  let host = input.trim().replace(/^(https?|wss?):\/\//i, '').trim()
  const slash = host.search(/[/?#\s]/)
  if (slash >= 0) host = host.slice(0, slash).trim()
  let m = host.match(/^\[([^\]]+)\]:(\d+)$/)
  if (!m) {
    m = host.match(/^([^:[\]]+):(\d+)$/)
  }
  if (!m) return null
  const port = Number.parseInt(m[2]!, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { ip: m[1]!, port }
}

/** แปลเหตุผลปฏิเสธการเข้าห้องเป็นไทย (NC-04) — รองรับทั้ง `JOIN_REJECTED:<reason>` (tls-client
 * ตรง) และ `rejected: <reason>` (ผ่าน IPC network-handlers) */
const JOIN_REJECTED_TH: Record<string, string> = {
  'bad-auth': 'Room PIN ผิด — ตรวจ PIN จากจอครูแล้วลองใหม่อีกครั้ง',
  'duplicate-id': 'รหัสนักเรียนนี้กำลังใช้งานอยู่ (เข้าห้องแล้วจากอีกเครื่อง) — แจ้งครู',
  'room-full': 'ห้องเต็ม (ครบ 60 คนแล้ว) — แจ้งครู',
  'unknown-message': 'เซสชันหมดอายุ — กดเข้าห้องใหม่อีกครั้ง'
}

function translateJoinError(raw: string): string {
  if (!raw) return 'เข้าห้องไม่สำเร็จ'
  if (raw.includes('bad-proof') || raw.includes('PIN ผิด')) return raw
  if (raw.includes('SERVER_PROOF_MISMATCH')) return raw
  const m = raw.match(/(?:JOIN_REJECTED|rejected)\s*:\s*([a-z-]+)/i)
  const reason = m?.[1]?.toLowerCase() ?? raw.trim().toLowerCase()
  const th = JOIN_REJECTED_TH[reason]
  if (th) return th
  if (raw.startsWith('JOIN_REJECTED:') || raw.startsWith('rejected:')) return `เข้าห้องไม่ได้ (${reason}) — แจ้งครูเพื่อตรวจสอบ`
  return raw
}

type StatusVariant = 'default' | 'secondary' | 'destructive' | 'outline'

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
  const [scanning, setScanning] = useState(true)

  // manual fallback ผ่าน Dialog
  const [manualOpen, setManualOpen] = useState(false)
  const [manualHost, setManualHost] = useState('')
  const [manualRoomId, setManualRoomId] = useState('')

  useEffect(() => {
    setScanning(true)
    void window.ztExam.startDiscovery()
    const unsubRooms = window.ztExam.onEvent('network:rooms-updated', (event) => {
      useStudentNetworkStore.getState().setRooms(event.rooms)
      setScanning(false)
    })
    const unsubConn = window.ztExam.onEvent('network:connection-state', (event) =>
      useStudentNetworkStore.getState().setConnection(event)
    )
    // Phase 3c: เริ่ม/หยุด screen worker ตามคำสั่งเซสชันจากเครื่องแม่
    const unsubScreenSession = window.ztExam.onEvent('screen:session', (event) => {
      const worker = getScreenWorker()
      if (event.active) {
        void worker
          .start(event.thumbnailIntervalMs ?? 1000)
          .catch((err: unknown) => {
            notify({
              severity: 'warning',
              message: `ระบบเฝ้าระวังหน้าจอเริ่มไม่สำเร็จ: ${err instanceof Error ? err.message : 'unknown'}`
            })
          })
      } else {
        void worker.stop()
      }
    })
    const unsubScreenInspect = window.ztExam.onEvent('screen:inspect', (event) => {
      getScreenWorker().setLive(event.mode === 'live', event.requestId, event.displayId, event.transport)
    })
    return () => {
      unsubRooms()
      unsubConn()
      unsubScreenSession()
      unsubScreenInspect()
      void getScreenWorker().stop()
      void window.ztExam.stopDiscovery()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function join(ip: string, port: number, roomId: string): Promise<void> {
    if (!/^\d{6}$/.test(pin)) {
      const msg = 'กรอก PIN 6 หลัก'
      setJoinError(msg)
      toast.error(msg)
      return
    }
    // NC-02: แยกข้อความรหัสว่าง vs ชื่อว่าง — ครูตามตัวง่ายกว่า
    if (studentId.trim().length === 0) {
      const msg = 'กรอกรหัสนักเรียน (ยังว่างอยู่)'
      setJoinError(msg)
      toast.error(msg)
      return
    }
    if (studentName.trim().length === 0) {
      const msg = 'กรอกชื่อ-นามสกุล (ยังว่างอยู่)'
      setJoinError(msg)
      toast.error(msg)
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
        useStudentExamStore.setState({
          identity: {
            studentId: studentId.trim(),
            studentName: studentName.trim()
          },
          phase: 'waiting'
        })
        notify({ severity: 'info', message: 'เข้าห้องสอบสำเร็จ — รอครูเริ่มข้อสอบ' })
        toast.success('เข้าห้องสอบสำเร็จ — รอครูเริ่มข้อสอบ')
      } else {
        const msg = translateJoinError(result.reason ?? 'เข้าห้องไม่สำเร็จ')
        setJoinError(msg)
        toast.error(msg)
      }
    } catch (err) {
      const msg = translateJoinError(err instanceof Error ? err.message : 'เข้าห้องไม่สำเร็จ')
      setJoinError(msg)
      toast.error(msg)
    } finally {
      setJoining(false)
    }
  }

  function handleManualJoin(): void {
    const parsed = parseManualHost(manualHost)
    if (!parsed || !manualRoomId.trim()) {
      const msg = !parsed
        ? 'รูปแบบ IP:Port ไม่ถูกต้อง (เช่น 192.168.1.10:44456)'
        : 'กรอก Room ID ด้วย'
      setJoinError(msg)
      toast.error(msg)
      return
    }
    setManualOpen(false)
    void join(parsed.ip, parsed.port, manualRoomId.trim())
  }

  const statusBanner = useMemo<{ icon: LucideIcon; variant: StatusVariant; title: string; detail: string } | null>(() => {
    switch (connection.state) {
      case 'ready':
        return { icon: Wifi, variant: 'default', title: 'พร้อมสอบ', detail: 'เชื่อมต่อเครื่องแม่สำเร็จ — รอเริ่มสอบ' }
      case 'connecting':
      case 'reconnecting':
        return { icon: RefreshCw, variant: 'secondary', title: 'กำลังเชื่อมต่อ', detail: 'กำลังเชื่อมต่อเครื่องแม่…' }
      case 'frozen':
        return { icon: ShieldAlert, variant: 'outline', title: 'ขาดการติดต่อ', detail: `กำลังเชื่อมต่อใหม่ (${connection.reason ?? ''})` }
      case 'rejected':
        return { icon: WifiOff, variant: 'destructive', title: 'เข้าห้องไม่ได้', detail: translateJoinError(connection.reason ?? 'unknown') }
      case 'closed':
        return { icon: Clock, variant: 'destructive', title: 'ห้องปิดแล้ว', detail: 'แจ้งครูให้เปิดห้องใหม่ แล้วเข้าอีกครั้ง' }
      default:
        return null
    }
  }, [connection])

  // NC-06/10: เหลือ frozen overlay ชั้นเดียวตอน phase active/timeup — ExamView บังโจทย์อยู่แล้ว
  // ชั้นนี้แสดงเฉพาะตอนยังไม่เข้าสอบ (idle/waiting) กันซ้อนกันสองชั้นเต็มจอ
  const examPhase = useStudentExamStore((s) => s.phase)
  const frozenFull = connection.state === 'frozen' && examPhase !== 'active' && examPhase !== 'timeup'

  return (
    <TooltipProvider>
      <div className="relative h-full">
        {/* หน้าทำข้อสอบ (Kiosk) ครอบทั้งหน้าเมื่อ phase ≥ waiting */}
        <StudentExamLayers />
        {/* ผลของปุ่มผู้คุมสอบ: ข้อความเตือนขึ้นจอ + Freeze เครื่อง (Phase 3b) */}
        <ProctorOverlay />

        {/* Fail-closed overlay บังทุกอย่างเมื่อหลุดการเชื่อมต่อ */}
        {frozenFull && (
          <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-background/95">
            <ShieldAlert size={48} className="mb-4 text-amber-500" />
            <h2 className="text-lg font-semibold">ขาดการติดต่อกับเครื่องแม่</h2>
            <p className="mt-2 text-sm text-muted-foreground">กำลังเชื่อมต่อใหม่อัตโนมัติ… ห้ามปิดแอป</p>
          </div>
        )}

        <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
          {statusBanner && (
            <Card>
              <CardContent className="flex items-center gap-3 pt-6">
                <Badge variant={statusBanner.variant}>
                  <statusBanner.icon />
                  {statusBanner.title}
                </Badge>
                <span className="text-sm text-muted-foreground">{statusBanner.detail}</span>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Radio size={18} className="text-muted-foreground" />
                <CardTitle>ห้องสอบในวง LAN</CardTitle>
                <Badge variant="secondary" className="ml-1 tabular-nums">
                  {rooms.length}
                </Badge>
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Search size={12} /> สแกนทุก 2 วิ
                </span>
              </div>
              <CardDescription>เลือกห้อง แล้วกรอก PIN จากจอครู</CardDescription>
            </CardHeader>
            <CardContent>
              {scanning && rooms.length === 0 ? (
                <div className="space-y-2" aria-label="กำลังค้นหาห้องสอบ">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : rooms.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-6 text-center">
                  <Radio size={24} className="text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">ยังไม่พบห้องสอบ — ให้ครูเปิดห้องก่อน หรือกรอก IP เอง</p>
                  <Button variant="outline" size="sm" onClick={() => setManualOpen(true)}>
                    กรอก IP เอง
                  </Button>
                </div>
              ) : (
                <ScrollArea className="max-h-72">
                  <ul className="space-y-2 pr-4">
                    {rooms.map((room) => {
                      const isActive = selected?.roomId === room.roomId
                      return (
                        <li key={room.roomId}>
                          <Button
                            type="button"
                            variant={isActive ? 'secondary' : 'outline'}
                            onClick={() => {
                              setSelected(room)
                              setManualRoomId(room.roomId)
                            }}
                            className={cn('h-auto w-full justify-start p-4 text-left', isActive && 'border-primary')}
                            aria-pressed={isActive}
                          >
                            <span className="w-full">
                              <span className="flex items-center justify-between gap-2">
                                <span className="font-medium">{room.roomName}</span>
                                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                                  <Clock size={12} />
                                  {timeSince(room.lastSeenAtMs)}
                                </span>
                              </span>
                              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="font-mono tabular-nums">
                                      {room.sourceIp}:{room.tcpPort}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <span className="font-mono">
                                      {room.sourceIp}:{room.tcpPort}
                                    </span>
                                  </TooltipContent>
                                </Tooltip>
                                <span>{room.hostName}</span>
                                <span className="tabular-nums">นักเรียน {room.studentCount} คน</span>
                              </span>
                              <span className="mt-1 block">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="font-mono text-[10px] text-muted-foreground">
                                      cert {room.certFpShort.length > 16 ? `${room.certFpShort.slice(0, 16)}…` : room.certFpShort}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <span className="font-mono">{room.certFpShort}</span>
                                  </TooltipContent>
                                </Tooltip>
                              </span>
                            </span>
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                </ScrollArea>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <KeyRound size={18} className="text-muted-foreground" />
                <CardTitle>เข้าห้องสอบ</CardTitle>
                {selected && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelected(null)
                      setManualRoomId('')
                    }}
                    className="ml-auto"
                  >
                    ล้างห้องที่เลือก
                  </Button>
                )}
              </div>
              <CardDescription>
                {selected ? `ห้อง: ${selected.roomName}` : 'เลือกห้องด้านบน หรือกรอก IP เอง'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="student-id">รหัสนักเรียน</Label>
                  <Input
                    id="student-id"
                    value={studentId}
                    onChange={(e) => setStudentId(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="student-name">ชื่อ-นามสกุล</Label>
                  <Input
                    id="student-name"
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="room-pin">PIN 6 หลัก</Label>
                  <Input
                    id="room-pin"
                    value={pin}
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="••••••"
                    className="font-mono tracking-widest tabular-nums"
                  />
                </div>
              </div>

              {joinError && (
                <Card role="alert" className="mt-3 border-destructive/50 bg-destructive/10">
                  <CardContent className="pt-6 text-sm text-destructive">{joinError}</CardContent>
                </Card>
              )}

              <Button
                type="button"
                variant="default"
                disabled={joining}
                onClick={() => {
                  const target = selected
                  if (target) {
                    void join(target.sourceIp, target.tcpPort, target.roomId)
                  } else {
                    setJoinError('เลือกห้องก่อน หรือกรอก IP เอง')
                    setManualOpen(true)
                  }
                }}
                className="mt-4 w-full"
              >
                {joining ? <Loader2 className="animate-spin" /> : <PlugZap />}
                {joining ? 'กำลังตรวจ PIN…' : 'เข้าห้องสอบ'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setManualOpen(true)}
                className="mt-2 w-full"
              >
                กรอก IP เอง
              </Button>
            </CardContent>
          </Card>
        </div>

        <Dialog open={manualOpen} onOpenChange={setManualOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>กรอก IP เครื่องแม่เอง</DialogTitle>
              <DialogDescription>ใช้เมื่อสแกน LAN ไม่เจอห้อง — ขอ IP กับ Room ID จากครู</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="manual-host">IP:Port</Label>
                <Input
                  id="manual-host"
                  placeholder="192.168.1.10:44456"
                  value={manualHost}
                  onChange={(e) => setManualHost(e.target.value)}
                  className="font-mono tabular-nums"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="manual-room">Room ID</Label>
                <Input
                  id="manual-room"
                  placeholder="Room ID"
                  value={manualRoomId}
                  onChange={(e) => setManualRoomId(e.target.value)}
                  className="font-mono"
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setManualOpen(false)}>
                ยกเลิก
              </Button>
              <Button type="button" variant="default" disabled={joining} onClick={handleManualJoin}>
                {joining ? <Loader2 className="animate-spin" /> : <Lock />}
                เข้าห้อง
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}

/** ชั้นรวม view การสอบ (waiting banner + Kiosk ExamView ครอบทั้งหน้าเมื่อ phase เกิดขึ้น) */
function StudentExamLayers(): React.JSX.Element {
  const phase = useStudentExamStore((s) => s.phase)
  const connState = useStudentNetworkStore((s) => s.connection.state)

  if (phase === 'idle') return <></>
  return (
    <>
      {phase === 'waiting' && (
        <div className="fixed inset-0 z-30 flex flex-col items-center justify-center bg-background">
          <Lock size={40} className="mb-3 text-muted-foreground" />
          {connState === 'closed' ? (
            <>
              <h2 className="text-lg font-semibold">ห้องปิดแล้ว</h2>
              <p className="mt-2 text-sm text-muted-foreground">แจ้งครูให้เปิดห้องใหม่ แล้วเข้าอีกครั้ง</p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold">เชื่อมต่อสำเร็จ</h2>
              <p className="mt-2 text-sm text-muted-foreground">รอครูกดเริ่มสอบ…</p>
            </>
          )}
        </div>
      )}
      <ExamView />
    </>
  )
}

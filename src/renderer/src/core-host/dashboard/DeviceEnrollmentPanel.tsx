import { useCallback, useEffect, useState } from 'react'
import { Ban, RefreshCw, ShieldCheck, Trash2, Undo2 } from 'lucide-react'
import type { EnrolledDeviceView } from '@shared/device-roster-schema'
import { useAppStore } from '../../store/app-store'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '../../components/ui/table'

function shortDeviceId(deviceId: string): string {
  return `${deviceId.slice(0, 10)}…${deviceId.slice(-6)}`
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toLocaleString('th-TH', { hour12: false })
}

/**
 * แผง TOFU device enrollment — แสดง device ที่ join มาแล้ว (auto-accept)
 * ครูใช้ block/unblock/remove เพื่อตัดเครื่องที่ไม่ควรอยู่ในห้อง
 */
export default function DeviceEnrollmentPanel(): React.JSX.Element {
  const [devices, setDevices] = useState<EnrolledDeviceView[] | null>(null)
  const [busy, setBusy] = useState(false)
  const notify = useAppStore((s) => s.notify)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await window.ztExam.listEnrolledDevices()
      setDevices(res.devices)
    } catch (err) {
      notify({
        severity: 'warning',
        message: err instanceof Error ? err.message : 'โหลดรายการอุปกรณ์ไม่สำเร็จ'
      })
    }
  }, [notify])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  async function act(deviceId: string, action: 'block' | 'unblock' | 'remove'): Promise<void> {
    setBusy(true)
    try {
      if (action === 'remove') {
        const confirmed = window.confirm(
          'ลบอุปกรณ์นี้ออกจากรายการ? เครื่องนี้จะต้อง enroll ใหม่เมื่อ join ครั้งถัดไป'
        )
        if (!confirmed) return
        await window.ztExam.removeEnrolledDevice({ deviceId })
      } else {
        await window.ztExam.setEnrolledDeviceStatus({
          deviceId,
          status: action === 'block' ? 'blocked' : 'active'
        })
      }
      await refresh()
    } catch (err) {
      notify({
        severity: 'warning',
        message: err instanceof Error ? err.message : 'ดำเนินการไม่สำเร็จ'
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0 pb-3">
        <ShieldCheck size={18} className="text-primary" />
        <CardTitle className="text-base">อุปกรณ์ที่ลงทะเบียน (TOFU)</CardTitle>
        <Badge variant="secondary" className="tabular-nums">
          {devices ? `${devices.length} เครื่อง` : '…'}
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} className="mr-1" />
          รีเฟรช
        </Button>
      </CardHeader>
      <CardContent>
        {devices === null ? (
          <Skeleton className="h-24 w-full" />
        ) : devices.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            ยังไม่มีอุปกรณ์ — เครื่องนักเรียนจะถูกเพิ่มอัตโนมัติเมื่อ join ครั้งแรก
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>นักเรียน</TableHead>
                <TableHead>Device ID</TableHead>
                <TableHead>สถานะ</TableHead>
                <TableHead>เครื่อง</TableHead>
                <TableHead>เห็นล่าสุด</TableHead>
                <TableHead className="text-right">จัดการ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((device) => (
                <TableRow key={device.deviceId}>
                  <TableCell className="font-mono text-xs">{device.studentId}</TableCell>
                  <TableCell className="font-mono text-xs" title={device.deviceId}>
                    {shortDeviceId(device.deviceId)}
                  </TableCell>
                  <TableCell>
                    {device.status === 'active' ? (
                      <Badge
                        variant="outline"
                        className="border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      >
                        ใช้งาน
                      </Badge>
                    ) : (
                      <Badge variant="destructive">บล็อก</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {device.hardwareBound ? 'ผูก machine-id' : 'fallback'}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {formatTime(device.lastSeenAtMs)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex gap-1">
                      {device.status === 'active' ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          title="บล็อกอุปกรณ์นี้"
                          onClick={() => void act(device.deviceId, 'block')}
                        >
                          <Ban size={14} />
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          title="ปลดบล็อก"
                          onClick={() => void act(device.deviceId, 'unblock')}
                        >
                          <Undo2 size={14} />
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        title="ลบอุปกรณ์"
                        onClick={() => void act(device.deviceId, 'remove')}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

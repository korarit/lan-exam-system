import { useEffect, useState } from 'react'
import { AlertTriangle, Network, Play, RefreshCw, ShieldAlert, Square } from 'lucide-react'
import {
  suggestPool,
  type GatewayDnsLogEntry,
  type GatewayInterfaceInfo,
  type GatewayLease,
  type GatewayStartRequest,
  type GatewayState,
  type GatewayStatus
} from '@shared/gateway'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@renderer/components/ui/table'

const REQUIRED_WARNINGS = [
  'โหมดนี้ต้องให้เครื่องนักเรียนใช้ DHCP ของเครื่องแม่ (ปิด DHCP ของเราเตอร์ หรือแยก VLAN)',
  'ต้องรันเครื่องแม่แบบ Administrator/root เพื่อ bind port 67/53 และปิด forwarding',
  'IPv6 ต้องถูกปิดใน VLAN นักเรียน ไม่งั้น bypass ได้',
  'นักเรียนที่ตั้ง static IP/gateway เองสามารถ bypass ได้ — ต้องคุมด้วยนโยบายห้อง/switch'
]

const STATUS_META: Record<GatewayState, { label: string; variant: 'default' | 'secondary' | 'destructive' }> = {
  stopped: { label: 'หยุดอยู่', variant: 'secondary' },
  running: { label: 'ทำงาน', variant: 'default' },
  degraded: { label: 'ทำงานแบบจำกัด', variant: 'destructive' },
  error: { label: 'ผิดพลาด', variant: 'destructive' }
}

function forwardingLabel(value: boolean | null): string {
  if (value === true) return 'เปิด'
  if (value === false) return 'ปิด'
  return 'ไม่ทราบ'
}

function forwardingVariant(value: boolean | null): 'default' | 'secondary' | 'destructive' {
  if (value === true) return 'destructive'
  if (value === false) return 'default'
  return 'secondary'
}

function formatClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return new Date(ms).toISOString()
  }
}

function translateError(message: string): string {
  if (message.includes('HOST_ROLE_REQUIRED')) return 'เฉพาะเครื่องแม่ (host) เท่านั้น'
  if (message.includes('GATEWAY_CLOSED_MODE_ONLY')) return 'โหมดนี้ใช้กับข้อสอบแบบ closed เท่านั้น'
  if (message.includes('DHCP_BIND_FAILED')) return 'bind DHCP port 67 ไม่สำเร็จ — ต้องรันแบบ Administrator/root และปิด DHCP อื่นบนเครื่องแม่'
  if (message.includes('DNS_BIND_FAILED')) return 'bind DNS port 53 ไม่สำเร็จ — ต้องรันแบบ Administrator/root และปิด DNS service ที่ใช้พอร์ตนี้'
  if (message.includes('GATEWAY_INTERFACE_NOT_FOUND')) return 'ไม่พบ network interface ที่เลือก'
  if (message.includes('GATEWAY_HOST_IP_NOT_ON_INTERFACE')) return 'IP เครื่องแม่ไม่ได้อยู่บน interface ที่เลือก'
  if (message.includes('GATEWAY_HOST_OUTSIDE_SUBNET')) return 'IP เครื่องแม่อยู่นอก subnet'
  if (message.includes('GATEWAY_POOL_')) return 'ช่วง IP pool ไม่ถูกต้อง (ต้องอยู่ใน subnet และไม่ทับ network/broadcast)'
  if (message.includes('GATEWAY_ALREADY_RUNNING')) return 'gateway ทำงานอยู่แล้ว'
  if (message.includes('GATEWAY_INVALID_CONFIG')) return 'ค่าตั้งต้นไม่ถูกต้อง'
  return message.slice(0, 300)
}

export default function NetworkGatewayPanel({
  examMode
}: {
  examMode: 'closed' | 'in-app-docs' | 'external-tools'
}): React.JSX.Element {
  const [interfaces, setInterfaces] = useState<GatewayInterfaceInfo[]>([])
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [leases, setLeases] = useState<GatewayLease[]>([])
  const [dnsLog, setDnsLog] = useState<GatewayDnsLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [interfaceName, setInterfaceName] = useState('')
  const [hostIp, setHostIp] = useState('')
  const [subnetCidr, setSubnetCidr] = useState('')
  const [poolStart, setPoolStart] = useState('')
  const [poolEnd, setPoolEnd] = useState('')
  const [leaseTimeSeconds, setLeaseTimeSeconds] = useState('3600')
  const [allowlistText, setAllowlistText] = useState('')
  const [upstreamDns, setUpstreamDns] = useState('1.1.1.1')

  const isClosed = examMode === 'closed'
  const running = status?.running === true
  const state = status?.state ?? 'stopped'
  const meta = STATUS_META[state]

  function applyInterface(iface: GatewayInterfaceInfo): void {
    setInterfaceName(iface.name)
    setHostIp(iface.address)
    setSubnetCidr(iface.cidr)
    const pool = suggestPool(iface.address, iface.cidr)
    setPoolStart(pool.poolStart)
    setPoolEnd(pool.poolEnd)
  }

  async function refresh(): Promise<void> {
    const [ifaceResponse, nextStatus, leaseResponse, dnsResponse] = await Promise.all([
      window.ztExam.gatewayInterfaces(),
      window.ztExam.gatewayStatus(),
      window.ztExam.gatewayLeases(),
      window.ztExam.gatewayDnsLog()
    ])
    setInterfaces(ifaceResponse.interfaces)
    setStatus(nextStatus)
    setLeases(leaseResponse.leases)
    setDnsLog([...dnsResponse.entries].reverse())
    if (nextStatus.running) {
      setInterfaceName(nextStatus.interfaceName ?? '')
      setHostIp(nextStatus.hostIp ?? '')
      setSubnetCidr(nextStatus.subnetCidr ?? '')
      setPoolStart(nextStatus.poolStart ?? '')
      setPoolEnd(nextStatus.poolEnd ?? '')
    } else if (interfaceName.length === 0 && ifaceResponse.interfaces[0]) {
      applyInterface(ifaceResponse.interfaces[0])
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await refresh()
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'โหลดสถานะ gateway ไม่สำเร็จ')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    const unsubscribeStatus = window.ztExam.onEvent('gateway:status-changed', (next) => {
      setStatus(next)
      if (!next.running) {
        setLeases([])
        return
      }
      void window.ztExam
        .gatewayLeases()
        .then((response) => setLeases(response.leases))
        .catch(() => undefined)
    })
    const unsubscribeDns = window.ztExam.onEvent('gateway:dns-query', (entry) => {
      setDnsLog((previous) => [entry, ...previous].slice(0, 500))
    })

    return () => {
      cancelled = true
      unsubscribeStatus()
      unsubscribeDns()
    }
    // mount once — refresh() อ่านค่าปัจจุบันจาก main เอง
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleInterfaceChange(value: string): void {
    const iface = interfaces.find((item) => `${item.name}::${item.address}` === value)
    if (iface) applyInterface(iface)
  }

  async function handleStart(): Promise<void> {
    setBusy(true)
    setActionError(null)
    try {
      const request: GatewayStartRequest = {
        interfaceName,
        hostIp,
        subnetCidr,
        poolStart,
        poolEnd,
        leaseTimeSeconds: Number(leaseTimeSeconds),
        allowlistDomains: allowlistText
          .split(/[\s,]+/)
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
        upstreamDns,
        examMode
      }
      const next = await window.ztExam.gatewayStart(request)
      setStatus(next)
      const leaseResponse = await window.ztExam.gatewayLeases()
      setLeases(leaseResponse.leases)
    } catch (error) {
      setActionError(translateError(error instanceof Error ? error.message : 'เริ่ม gateway ไม่สำเร็จ'))
    } finally {
      setBusy(false)
    }
  }

  async function handleStop(): Promise<void> {
    setBusy(true)
    setActionError(null)
    try {
      const next = await window.ztExam.gatewayStop()
      setStatus(next)
      setLeases([])
    } catch (error) {
      setActionError(translateError(error instanceof Error ? error.message : 'หยุด gateway ไม่สำเร็จ'))
    } finally {
      setBusy(false)
    }
  }

  const postureWarnings = status?.posture?.warnings ?? []
  const allWarnings = [...new Set([...(status?.warnings ?? []), ...postureWarnings])]

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Network size={18} className="text-primary" />
          <CardTitle>Network Gateway (ปิดเน็ตนักเรียน)</CardTitle>
          <Badge variant={meta.variant} className="ml-auto">
            {meta.label}
          </Badge>
        </div>
        <CardDescription>
          ให้เครื่องแม่เป็น default gateway + DHCP/DNS ของ VLAN นักเรียน — ค่าเริ่มต้นบล็อก DNS/อินเทอร์เน็ตทั้งหมด
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <div className="mb-1 flex items-center gap-2 font-medium text-destructive">
            <ShieldAlert size={16} />
            เงื่อนไขความปลอดภัยของโหมดนี้
          </div>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {REQUIRED_WARNINGS.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>

        {!isClosed && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            โหมดนี้ใช้กับข้อสอบแบบ Closed เท่านั้น — โหมดปัจจุบันคือ {examMode}
          </div>
        )}
        {loadError && <div className="text-sm text-destructive">{loadError}</div>}
        {actionError && <div className="text-sm text-destructive">{actionError}</div>}

        {running ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-muted-foreground">Interface</div>
              <div className="font-medium">{status?.interfaceName ?? '—'}</div>
              <div className="text-muted-foreground">Host IP / gateway</div>
              <div className="font-mono tabular-nums">{status?.hostIp ?? '—'}</div>
              <div className="text-muted-foreground">Subnet</div>
              <div className="font-mono tabular-nums">{status?.subnetCidr ?? '—'}</div>
              <div className="text-muted-foreground">Pool</div>
              <div className="font-mono tabular-nums">
                {status?.poolStart ?? '—'} – {status?.poolEnd ?? '—'}
              </div>
              <div className="text-muted-foreground">Leases</div>
              <div className="tabular-nums">
                {status?.leaseCount ?? leases.length} / {leases.length} รายการที่แสดง
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="destructive" disabled={busy} onClick={() => void handleStop()}>
                <Square size={16} />
                {busy ? 'กำลังหยุด…' : 'หยุด gateway'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void refresh().catch((error) =>
                    setActionError(translateError(error instanceof Error ? error.message : 'รีเฟรชไม่สำเร็จ'))
                  )
                }}
              >
                <RefreshCw size={16} />
                รีเฟรช
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="gateway-interface">Network interface</Label>
              <Select
                value={interfaceName && hostIp ? `${interfaceName}::${hostIp}` : ''}
                onValueChange={handleInterfaceChange}
                disabled={loading || interfaces.length === 0}
              >
                <SelectTrigger id="gateway-interface">
                  <SelectValue placeholder={interfaces.length === 0 ? 'ไม่พบ IPv4 interface' : 'เลือก interface'} />
                </SelectTrigger>
                <SelectContent>
                  {interfaces.map((iface) => (
                    <SelectItem key={`${iface.name}:${iface.address}`} value={`${iface.name}::${iface.address}`}>
                      {iface.name} — {iface.address} ({iface.cidr})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="gateway-host-ip">Host IP (gateway/DNS)</Label>
                <Input
                  id="gateway-host-ip"
                  value={hostIp}
                  onChange={(event) => setHostIp(event.target.value)}
                  className="font-mono tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gateway-subnet">Subnet (CIDR)</Label>
                <Input
                  id="gateway-subnet"
                  value={subnetCidr}
                  onChange={(event) => setSubnetCidr(event.target.value)}
                  className="font-mono tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gateway-pool-start">Pool start</Label>
                <Input
                  id="gateway-pool-start"
                  value={poolStart}
                  onChange={(event) => setPoolStart(event.target.value)}
                  className="font-mono tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gateway-pool-end">Pool end</Label>
                <Input
                  id="gateway-pool-end"
                  value={poolEnd}
                  onChange={(event) => setPoolEnd(event.target.value)}
                  className="font-mono tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gateway-lease">Lease time (วินาที)</Label>
                <Input
                  id="gateway-lease"
                  inputMode="numeric"
                  value={leaseTimeSeconds}
                  onChange={(event) => setLeaseTimeSeconds(event.target.value)}
                  className="font-mono tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gateway-upstream">Upstream DNS</Label>
                <Input
                  id="gateway-upstream"
                  value={upstreamDns}
                  onChange={(event) => setUpstreamDns(event.target.value)}
                  className="font-mono tabular-nums"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gateway-allowlist">Allowlist โดเมน (คั่นด้วย , หรือเว้นวรรค — ว่าง = บล็อกทั้งหมด)</Label>
              <Input
                id="gateway-allowlist"
                value={allowlistText}
                onChange={(event) => setAllowlistText(event.target.value)}
                placeholder="เช่น docs.school.ac.th, exam.school.ac.th"
              />
            </div>
            <Button type="button" disabled={busy || !isClosed || loading || interfaces.length === 0} onClick={() => void handleStart()}>
              <Play size={16} />
              {busy ? 'กำลังเริ่ม…' : 'เริ่ม gateway (ต้องมีสิทธิ์ Administrator/root)'}
            </Button>
          </div>
        )}

        {status?.lastError && <div className="text-sm text-destructive">ข้อผิดพลาดล่าสุด: {status.lastError}</div>}

        {status?.posture && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle size={16} className="text-amber-500" />
              Forwarding posture
            </div>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">IPv4 forwarding</div>
                <Badge variant={forwardingVariant(status.posture.ipv4Forwarding)}>
                  {forwardingLabel(status.posture.ipv4Forwarding)}
                </Badge>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">IPv6 forwarding</div>
                <Badge variant={forwardingVariant(status.posture.ipv6Forwarding)}>
                  {forwardingLabel(status.posture.ipv6Forwarding)}
                </Badge>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">ICS (SharedAccess)</div>
                <Badge variant={forwardingVariant(status.posture.icsEnabled)}>
                  {status.posture.icsEnabled === null ? '—' : forwardingLabel(status.posture.icsEnabled)}
                </Badge>
              </div>
            </div>
            {status.posture.changed.length > 0 && (
              <div className="text-xs text-muted-foreground">
                เปลี่ยนแล้ว: {status.posture.changed.join(' · ')}
              </div>
            )}
            {allWarnings.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-xs text-destructive">
                {allWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="space-y-2">
          <div className="text-sm font-medium">Leases (สูงสุด 256 รายการ)</div>
          {leases.length === 0 ? (
            <div className="text-xs text-muted-foreground">ยังไม่มีเครื่องนักเรียนขอ lease</div>
          ) : (
            <ScrollArea className="h-40 rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>MAC</TableHead>
                    <TableHead>IP</TableHead>
                    <TableHead>Hostname</TableHead>
                    <TableHead>หมดอายุ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leases.slice(0, 20).map((lease) => (
                    <TableRow key={lease.mac}>
                      <TableCell className="font-mono text-xs">{lease.mac}</TableCell>
                      <TableCell className="font-mono text-xs tabular-nums">{lease.ip}</TableCell>
                      <TableCell className="max-w-32 truncate text-xs">{lease.hostname ?? '—'}</TableCell>
                      <TableCell className="text-xs tabular-nums">{formatClock(lease.expiresAtMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">DNS ล่าสุด (500 รายการล่าสุด)</div>
          {dnsLog.length === 0 ? (
            <div className="text-xs text-muted-foreground">ยังไม่มี DNS query</div>
          ) : (
            <ScrollArea className="h-40 rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>เวลา</TableHead>
                    <TableHead>โดเมน</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>ผล</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dnsLog.slice(0, 20).map((entry, index) => (
                    <TableRow key={`${entry.atMs}:${entry.domain}:${index}`}>
                      <TableCell className="text-xs tabular-nums">{formatClock(entry.atMs)}</TableCell>
                      <TableCell className="max-w-40 truncate font-mono text-xs">{entry.domain}</TableCell>
                      <TableCell className="font-mono text-xs tabular-nums">{entry.clientIp}</TableCell>
                      <TableCell>
                        <Badge variant={entry.allowed ? 'secondary' : 'destructive'}>
                          {entry.action === 'forwarded'
                            ? 'อนุญาต'
                            : entry.action === 'blocked'
                              ? 'บล็อก'
                              : entry.action === 'servfail'
                                ? 'upstream ล้ม'
                                : 'ผิดรูปแบบ'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

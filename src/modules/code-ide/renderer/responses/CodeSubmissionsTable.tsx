import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, Download, Archive, RotateCcw, Eye, HardDrive } from 'lucide-react'
import type { CodeIdeSubmissionsResponse, CodeIdeSubmissionSummary, CodeIdeWorkspaceStateResponse } from '@shared/ipc-channels'
import StudentProjectInspectorModal from './StudentProjectInspectorModal'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'

/* ============================================================
 * Phase 10 (10.3) — ตารางสรุปผลคะแนน code-ide ฝั่งครู
 * รายชื่อนักเรียน + ป้ายหมวด/ภาษา + แถบ Test Cases + สถานะคิวตรวจ
 * + Re-grade All + Export CSV/Bundle + เปิดโฟลเดอร์ <studentId>
 * ============================================================ */

function StatusBadge({ status }: { status: CodeIdeSubmissionSummary['status'] }): React.JSX.Element {
  const label = status === 'graded' ? 'ตรวจแล้ว' : status === 'grading' ? 'กำลังตรวจ' : status === 'queued' ? 'รอคิว' : status === 'blocked' ? 'ถูกบล็อก' : 'ผิดพลาด'
  const variant = status === 'graded' ? 'default' : status === 'blocked' || status === 'error' ? 'destructive' : status === 'grading' ? 'secondary' : 'outline'
  return <Badge variant={variant}>{label}</Badge>
}

export default function CodeSubmissionsTable(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CodeIdeSubmissionsResponse | null>(null)
  const [workspace, setWorkspace] = useState<CodeIdeWorkspaceStateResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({})

  const refresh = useCallback(() => {
    setLoading(true)
    void window.ztExam
      .getCodeSubmissions()
      .then(setSnapshot)
      .catch((err: unknown) => setActionMsg(`โหลดข้อมูลไม่สำเร็จ: ${err instanceof Error ? err.message : 'unknown'}`))
      .finally(() => setLoading(false))
    void window.ztExam
      .getCodeWorkspaceState()
      .then(setWorkspace)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 8000)
    return () => clearInterval(timer)
  }, [refresh])

  async function setWorkspaceRoot(): Promise<void> {
    setActionMsg(null)
    const res = await window.ztExam.setCodeWorkspaceRoot()
    if (res.ok) {
      setActionMsg(`ตั้งโฟลเดอร์เก็บงานแล้ว: ${res.rootPath ?? ''} — ระบบสร้าง Subfolder <studentId> ให้อัตโนมัติ`)
      refresh()
    } else if (res.reason !== 'CANCELLED') {
      setActionMsg(`ตั้งโฟลเดอร์ไม่สำเร็จ: ${res.reason ?? 'unknown'}`)
    }
  }

  async function regradeAll(): Promise<void> {
    setActionMsg('กำลังตรวจใหม่ทั้งห้อง… (คิวขนานตามคอร์ CPU เครื่องแม่)')
    try {
      const res = await window.ztExam.codeRegradeAll()
      setActionMsg(res.ok ? `ตรวจใหม่เสร็จ: ${res.students ?? 0} คน / ตรวจสำเร็จ ${res.graded ?? 0} งาน` : `${res.reason ?? 'failed'}`)
    } catch (err) {
      setActionMsg(`ตรวจใหม่ไม่สำเร็จ: ${err instanceof Error ? err.message : 'unknown'}`)
    }
    refresh()
  }

  async function exportCsv(): Promise<void> {
    const res = await window.ztExam.exportCodeCsv()
    setActionMsg(res.ok ? `ส่งออก CSV แล้ว: ${res.rootPath ?? ''}` : res.reason === 'CANCELLED' ? null : `${res.reason ?? 'failed'}`)
  }

  async function exportBundle(): Promise<void> {
    setActionMsg('กำลังส่งออกโฟลเดอร์โปรเจกต์ทั้งห้อง…')
    const res = await window.ztExam.exportCodeBundle()
    setActionMsg(res.ok ? `ส่งออกแล้ว: ${res.rootPath ?? ''} (โครงโฟลเดอร์นักเรียนครบ + grading-report.json)` : res.reason === 'CANCELLED' ? null : `${res.reason ?? 'failed'}`)
  }

  async function openFolder(studentId: string): Promise<void> {
    const res = await window.ztExam.openCodeStudentFolder({ studentId })
    if (!res.ok) setActionMsg(`เปิดโฟลเดอร์ไม่สำเร็จ: ${res.reason ?? 'unknown'}`)
  }

  async function saveManual(studentId: string, maxPoints: number): Promise<void> {
    const raw = (manualInputs[studentId] ?? '').trim()
    try {
      const points = raw === '' ? null : Number(raw)
      if (points !== null && (!Number.isFinite(points) || points < 0 || points > maxPoints)) {
        setActionMsg(`คะแนนต้องอยู่ระหว่าง 0–${maxPoints}`)
        return
      }
      const res = await window.ztExam.codeManualGrade({ studentId, points })
      setActionMsg(res.ok ? `บันทึกคะแนน ${studentId} แล้ว (manual ชนะ auto)` : `${res.reason ?? 'failed'}`)
      refresh()
    } catch (err) {
      setActionMsg(`บันทึกไม่สำเร็จ: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  if (loading && snapshot === null) {
    return <p className="p-8 text-center text-sm text-muted-foreground">กำลังโหลดงาน code-ide…</p>
  }

  const subs = snapshot?.submissions ?? []
  const maxPoints = snapshot?.maxPoints ?? 0

  return (
    <div className="space-y-3">
      {/* แถบสถานะห้อง + workspace + queue */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 py-3 text-xs">
          <span className="font-semibold">
            {snapshot?.packageTitle ?? 'ยังไม่ผูก .ztcode เข้าห้อง'} {snapshot?.category ? `[${snapshot.category}]` : ''} {snapshot?.language ? `(${snapshot.language})` : ''}
          </span>
          <Badge variant="secondary" className="tabular-nums">คิวตรวจ: {snapshot?.queue.active ?? 0} รัน / {snapshot?.queue.pending ?? 0} รอ</Badge>
          <Badge variant={workspace?.workspaceOk ? 'default' : 'outline'}>
            {workspace?.rootPath ? `${workspace.rootPath}` : 'ยังไม่เลือกโฟลเดอร์เก็บงานครู'}
          </Badge>
          <span className="flex-1" />
          <Button type="button" variant="outline" size="sm" onClick={() => void setWorkspaceRoot()}>
            <HardDrive size={13} /> เลือกโฟลเดอร์เก็บงาน
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void regradeAll()}>
            <RotateCcw size={13} /> ตรวจใหม่ทั้งห้อง
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void exportCsv()}>
            <Download size={13} /> CSV
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void exportBundle()}>
            <Archive size={13} /> โฟลเดอร์ทั้งห้อง
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={refresh}>
            <RefreshCw size={13} /> รีเฟรช
          </Button>
        </CardContent>
      </Card>

      {actionMsg !== null && (
        <Card><CardContent className="px-3 py-2 text-[13px]">{actionMsg}</CardContent></Card>
      )}

      {snapshot !== null && snapshot.depsUnsupported.length > 0 && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="px-3 py-2 text-[13px]">
            Offline libs บางตัวใช้ตรวจ/รันไม่ได้: {snapshot.depsUnsupported.join('; ').slice(0, 400)} — อัปโหลดเป็น .zip/.jar ใหม่แล้วผูกห้องอีกครั้ง
          </CardContent>
        </Card>
      )}

      {snapshot !== null && !snapshot.ok && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="px-3 py-2 text-[13px]">
            {snapshot.reason === 'ROOM_NOT_OPEN' && 'ยังไม่เปิดห้องสอบ — เปิดห้องก่อนแล้วผูก .ztcode จากแท็บ Code IDE Builder (ปุ่ม “ผูกเข้าห้องสอบ”) '}
            {snapshot.reason === 'ROOM_PACKAGE_NOT_LOADED' && 'ห้องเปิดแล้วแต่ยังไม่ผูกข้อสอบ — ไปที่แท็บ Code IDE Builder แล้วกด “ผูกเข้าห้องสอบ”'}
          </CardContent>
        </Card>
      )}

      <Card className="overflow-x-auto">
        <Table className="min-w-[880px]">
          <TableHeader>
            <TableRow>
              <TableHead>นักเรียน</TableHead>
              <TableHead>ไฟล์</TableHead>
              <TableHead>Tests</TableHead>
              <TableHead>Auto</TableHead>
              <TableHead>Manual</TableHead>
              <TableHead>รวม / เต็ม</TableHead>
              <TableHead>สถานะ</TableHead>
              <TableHead>ตรวจ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {subs.map((s) => (
              <TableRow key={s.studentId}>
                <TableCell>
                  <div className="font-mono font-semibold">{s.studentId}</div>
                  {s.blockedReason && <div className="mt-0.5 max-w-[260px] truncate text-[11px] text-destructive" title={s.blockedReason}>{s.blockedReason}</div>}
                </TableCell>
                <TableCell className="font-mono tabular-nums">{s.fileCount}</TableCell>
                <TableCell className="whitespace-nowrap font-mono tabular-nums">
                  <Badge variant={s.totalCount > 0 && s.passedCount === s.totalCount ? 'default' : s.passedCount === 0 ? 'destructive' : 'outline'}>
                    {s.passedCount}/{s.totalCount}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono tabular-nums">{s.autoPoints}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Input
                      value={manualInputs[s.studentId] ?? (s.manualPoints !== null ? String(s.manualPoints) : '')}
                      onChange={(e) => setManualInputs((prev) => ({ ...prev, [s.studentId]: e.target.value }))}
                      placeholder="—"
                      className="w-16 font-mono tabular-nums"
                      aria-label={`คะแนน manual ${s.studentId}`}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => void saveManual(s.studentId, maxPoints)}>
                      บันทึก
                    </Button>
                  </div>
                </TableCell>
                <TableCell className="font-mono font-semibold tabular-nums text-primary">{s.totalPoints} / {s.maxPoints}</TableCell>
                <TableCell>
                  <StatusBadge status={s.status} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="outline" size="sm" onClick={() => setInspecting(s.studentId)} title="เปิด Mirror IDE Inspector">
                      <Eye size={12} /> ดูโค้ด
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => void openFolder(s.studentId)} title="เปิดโฟลเดอร์ <studentId> ใน File Explorer">
                      <FolderOpen size={12} />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {subs.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  ยังไม่มีงานที่ส่ง — นักเรียนกด “ส่งงาน” ใน IDE แล้วงานจะเข้าแถวตรวจอัตโนมัติที่นี่
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {inspecting !== null && (
        <StudentProjectInspectorModal
          studentId={inspecting}
          maxPoints={maxPoints}
          category={snapshot?.category ?? null}
          language={snapshot?.language ?? null}
          onClose={() => {
            setInspecting(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

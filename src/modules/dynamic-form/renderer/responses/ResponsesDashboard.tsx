import { useEffect, useMemo, useState } from 'react'
import { BarChart3, Rows3, UserSquare2, Download, PackagePlus, FolderOpen, RefreshCw, RotateCcw, Lock, EyeOff, Paperclip } from 'lucide-react'
import type {
  FormResponsesSnapshot,
  FormStudentResponsesView,
  FormItemAnswerView
} from '../../shared/form-responses-view'
import { isFormItemQuestion, INPUT_TYPE_LABELS } from '../../shared/form-schema'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { ScrollArea } from '@renderer/components/ui/scroll-area'

/* ============================================================
 * Phase 7 (7.3.1) — Responses Dashboard (สไตล์แท็บ Responses)
 * 3 มุมมอง:
 *  1. Summary — สรุปคะแนน + กราฟ + สถิติรายข้อ (ตอบผิด >70% เตือน)
 *  2. By Question — ตรวจรายข้อเร็ว (Blind Grading + Enter ไปคนถัดไป)
 *  3. Individual — ใบคำตอบรายบุคคล + สถานะความปลอดภัย
 * ============================================================ */

type HostApi = typeof window.ztExam

type TabId = 'summary' | 'by-question' | 'individual'

export default function ResponsesDashboard(): React.JSX.Element {
  const api = window.ztExam as HostApi
  const [snapshot, setSnapshot] = useState<FormResponsesSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [tab, setTab] = useState<TabId>('summary')
  const [regradeOpen, setRegradeOpen] = useState(false)
  const [passwordDialog, setPasswordDialog] = useState<{ mode: 'save' | 'load'; password: string } | null>(null)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      setSnapshot(await api.getFormResponses())
      const state = await api.getFormState()
      setNotice(
        state.formTitle === null
          ? 'ยังไม่มีฟอร์มถูกผูกกับห้อง — เปิด/บันทึกฟอร์มใน Builder แล้วกด Attach ข้อสอบ'
          : null
      )
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'โหลดข้อมูลผลสอบไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }

  const attachForm = async (): Promise<void> => {
    try {
      const res = await api.loadZtform({})
      if (res.ok && res.formPayloadJson !== undefined) {
        await api.attachRoomForm({ formPayloadJson: res.formPayloadJson })
        await refresh()
      } else if (res.message !== undefined) {
        setNotice(res.message)
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'เปิดฟอร์มไม่สำเร็จ')
    }
  }

  const regradeAll = async (): Promise<void> => {
    try {
      const res = await api.formRegradeAll({})
      if (res.ok) {
        setNotice(`ตรวจใหม่แล้ว ${res.students ?? 0} คน • ข้อที่เปลี่ยน ${res.changedItems ?? 0} รายการ (${(res.totalDeltaPoints ?? 0) > 0 ? '+' : ''}${res.totalDeltaPoints ?? 0} คะแนน)`)
        await refresh()
      } else {
        setNotice(`Re-grade ไม่สำเร็จ: ${res.reason ?? '?'}`)
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Re-grade ไม่สำเร็จ')
    }
  }

  const exportCsv = async (): Promise<void> => {
    try {
      const res = await api.exportFormCsv()
      const suffix = hasFileUpload ? ' — หมายเหตุ: คอลัมน์ file_upload เป็นชื่อไฟล์/สถานะเท่านั้น ไม่มีไบนารี (F-1 เก็บไฟล์จริงช่องทางอื่น)' : ''
      setNotice(res.ok && res.filePath !== undefined ? `บันทึก CSV แล้ว: ${res.filePath}${suffix}` : `Export CSV ไม่สำเร็จ: ${res.reason ?? '?'}`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Export CSV ไม่สำเร็จ')
    }
  }

  const saveZtresults = async (encrypted: boolean, password?: string): Promise<void> => {
    try {
      if (encrypted && password === undefined) {
        setPasswordDialog({ mode: 'save', password: '' })
        return
      }
      const res = await api.saveZtresults({ encrypted, ...(password !== undefined ? { password } : {}) })
      setNotice(res.ok && res.filePath !== undefined ? `บันทึกผลสอบแล้ว: ${res.filePath}` : `Save .ztresults ไม่สำเร็จ: ${res.reason ?? '?'}`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Save .ztresults ไม่สำเร็จ')
    }
  }

  const loadZtresults = async (password?: string): Promise<void> => {
    try {
      if (password !== undefined) {
        const retry = await api.loadZtresults({ password })
        if (retry.ok && retry.manifest !== undefined) {
          await refresh()
          setNotice(`เปิดไฟล์ผลสอบแล้ว: ${retry.manifest.formTitle} (${retry.manifest.studentCount} คน)`)
        } else {
          setNotice(retry.message ?? 'เปิดไฟล์ไม่สำเร็จ')
        }
        return
      }
      const res = await api.loadZtresults({})
      if (res.ok && res.manifest !== undefined) {
        await refresh()
        setNotice(`เปิดไฟล์ผลสอบแล้ว: ${res.manifest.formTitle} (${res.manifest.studentCount} คน) จากห้อง ${res.manifest.roomName}`)
      } else if (res.needPassword === true) {
        setPasswordDialog({ mode: 'load', password: '' })
      } else {
        setNotice(res.message ?? 'เปิดไฟล์ไม่สำเร็จ')
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'เปิดไฟล์ไม่สำเร็จ')
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const questions = useMemo(() => {
    if (snapshot === null) return []
    return snapshot.form.items.filter(isFormItemQuestion)
  }, [snapshot])
  const questionList = useMemo(
    () =>
      questions.map((q, idx) => ({
        itemId: q.itemId,
        prompt: q.prompt,
        index: idx + 1
      })),
    [questions]
  )
  const hasFileUpload = useMemo(
    () => questions.some((q) => q.inputType === 'file_upload'),
    [questions]
  )

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <Rows3 size={18} className="text-primary" />
            {snapshot?.formTitle ?? 'ผลสอบ Dynamic Form'}
          </h2>
          <p className="text-xs text-muted-foreground">
            ห้อง {snapshot?.roomName ?? '—'} • โหมด {snapshot === null ? '—' : snapshot.kind === 'archive' ? 'เปิดจากไฟล์ .ztresults' : 'ฐานข้อมูลเครื่องแม่'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={attachForm}>
            ผูกฟอร์ม (.ztform)
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setRegradeOpen(true)}>
            <RotateCcw size={12} /> Re-grade All
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={exportCsv}>
            <Download size={12} /> Export CSV
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => saveZtresults(false)}>
            <PackagePlus size={12} /> Save .ztresults
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => saveZtresults(true)}>
            <Lock size={12} /> Save (เข้ารหัส)
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => loadZtresults()}>
            <FolderOpen size={12} /> เปิด .ztresults
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={refresh}>
            <RefreshCw size={12} /> รีเฟรช
          </Button>
        </div>
      </header>

      {hasFileUpload && snapshot !== null && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent
            title="F-1: ท่อ LAN ยังไม่ส่งไบนารีไฟล์แนบ ตาราง/Export โชว์เฉพาะชื่อไฟล์/สถานะ ไฟล์จริงเก็บผ่านช่องทางอื่น — กันครูเข้าใจผิด"
            className="px-4 py-2 text-xs"
          >
            <b>ฟอร์มนี้มีข้อ file_upload — ไฟล์แนบยังไม่ส่งผ่านเครือข่าย (F-1)</b>
            <span className="mt-0.5 block text-muted-foreground">
              ตาราง/Export แสดงเฉพาะชื่อไฟล์/สถานะ ไม่มีไบนารี — เก็บไฟล์จริงผ่านช่องทางอื่นที่นัดกับนักเรียนไว้ อย่าตีความว่า “ไม่ส่ง = ทุจริต/ได้ 0 เพราะไฟล์หาย”
            </span>
          </CardContent>
        </Card>
      )}

      {notice !== null && notice.length > 0 && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="px-4 py-2 text-xs">{notice}</CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList>
          <TabsTrigger value="summary"><BarChart3 size={13} /> สรุปภาพรวม</TabsTrigger>
          <TabsTrigger value="by-question"><Rows3 size={13} /> ตรวจรายข้อ (เร็วที่สุด)</TabsTrigger>
          <TabsTrigger value="individual"><UserSquare2 size={13} /> ใบคำตอบรายบุคคล</TabsTrigger>
        </TabsList>
        <ScrollArea className="min-h-0 flex-1">
          {loading && snapshot === null ? (
            <div className="p-8 text-center text-sm text-muted-foreground">กำลังโหลดผลสอบ…</div>
          ) : snapshot === null ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              ยังไม่มีผลตอบ — ผูกฟอร์มกับห้อง หรือเปิดไฟล์ .ztresults ย้อนหลัง
            </div>
          ) : (
            <>
              <TabsContent value="summary"><SummaryTab snapshot={snapshot} /></TabsContent>
              <TabsContent value="by-question"><ByQuestionTab snapshot={snapshot} questionList={questionList} /></TabsContent>
              <TabsContent value="individual"><IndividualTab snapshot={snapshot} /></TabsContent>
            </>
          )}
        </ScrollArea>
      </Tabs>

      <Dialog open={regradeOpen} onOpenChange={setRegradeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>คำนวณคะแนนใหม่ทั้งห้อง</DialogTitle>
            <DialogDescription>คำตอบดิบไม่เปลี่ยน แต่คะแนนตรวจอัตโนมัติจะอัปเดตตามเฉลยล่าสุด ยืนยัน Re-grade All?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRegradeOpen(false)}>ยกเลิก</Button>
            <Button type="button" onClick={() => { setRegradeOpen(false); void regradeAll() }}>ตรวจใหม่ทั้งห้อง</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={passwordDialog !== null} onOpenChange={(o) => { if (!o) setPasswordDialog(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{passwordDialog?.mode === 'save' ? 'ตั้งรหัสผ่านของไฟล์ .ztresults' : 'รหัสผ่านไฟล์ .ztresults'}</DialogTitle>
            <DialogDescription>
              {passwordDialog?.mode === 'save' ? 'ใช้เปิดที่เครื่องอื่น' : 'ไฟล์ถูกเข้ารหัส — กรอกรหัสผ่านของครู'}
            </DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            value={passwordDialog?.password ?? ''}
            onChange={(e) => setPasswordDialog((p) => (p === null ? p : { ...p, password: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (passwordDialog?.password.length ?? 0) > 0) {
                const mode = passwordDialog?.mode
                const pw = passwordDialog?.password ?? ''
                setPasswordDialog(null)
                if (mode === 'save') void saveZtresults(true, pw)
                else void loadZtresults(pw)
              }
            }}
            aria-label="รหัสผ่านไฟล์ผลสอบ"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPasswordDialog(null)}>ยกเลิก</Button>
            <Button
              type="button"
              disabled={(passwordDialog?.password.length ?? 0) === 0}
              onClick={() => {
                const mode = passwordDialog?.mode
                const pw = passwordDialog?.password ?? ''
                setPasswordDialog(null)
                if (mode === 'save') void saveZtresults(true, pw)
                else void loadZtresults(pw)
              }}
            >
              ตกลง
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ---------- มุมมอง 1: สรุปภาพรวม + สถิติรายข้อ ---------- */

function SummaryTab({ snapshot }: { snapshot: FormResponsesSnapshot }): React.JSX.Element {
  const dist = snapshot.distribution
  const distMax = Math.max(1, ...dist.map((d) => d.count))
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {[
          { label: 'นักเรียน', value: String(snapshot.summary.studentCount) },
          { label: 'คะแนนเฉลี่ย (%)', value: snapshot.summary.mean.toFixed(1) },
          { label: 'คะแนนกลาง (%)', value: snapshot.summary.median.toFixed(1) },
          { label: 'สูงสุด (%)', value: snapshot.summary.max.toFixed(1) },
          { label: 'ต่ำสุด (%)', value: snapshot.summary.min.toFixed(1) },
          { label: 'รอตรวจอัตนัย', value: String(snapshot.summary.needsManualCount) }
        ].map((card) => (
          <Card key={card.label}>
            <CardContent className="p-3">
              <p className="text-[11px] text-muted-foreground">{card.label}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{card.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">การกระจายคะแนน (โดย %)</CardTitle></CardHeader>
        <CardContent>
          <div className="flex h-36 items-end gap-3">
            {dist.map((bucket) => (
              <div key={bucket.bucketLow} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-xs tabular-nums text-muted-foreground">{bucket.count > 0 ? bucket.count : ''}</span>
                <div
                  className="w-full rounded-t-md bg-primary"
                  style={{ height: `${Math.round((bucket.count / distMax) * 100)}%`, minHeight: bucket.count > 0 ? 4 : 2 }}
                />
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {bucket.bucketLow}–{bucket.bucketHigh}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">สถิติรายข้อ (Question Breakdown)</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>โจทย์</TableHead>
                  <TableHead>ชนิด</TableHead>
                  <TableHead>ตอบ</TableHead>
                  <TableHead>ถูกเต็ม</TableHead>
                  <TableHead>อัตราถูก</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.itemStats.map((stat) => {
                  const prompt = snapshot.form.items.find((i) => i.itemId === stat.itemId)
                  const label = prompt !== undefined && isFormItemQuestion(prompt) ? prompt.prompt : stat.itemId
                  const typeLabel =
                    stat.inputType in INPUT_TYPE_LABELS ? INPUT_TYPE_LABELS[stat.inputType as keyof typeof INPUT_TYPE_LABELS] : stat.inputType
                  return (
                    <TableRow key={stat.itemId}>
                      <TableCell className="tabular-nums">Q{stat.index}</TableCell>
                      <TableCell className="max-w-[280px] truncate">{label.length > 0 ? label : stat.itemId}</TableCell>
                      <TableCell className="text-muted-foreground">{typeLabel}</TableCell>
                      <TableCell className="tabular-nums">{stat.responsesCount}</TableCell>
                      <TableCell className="tabular-nums">{stat.correctCount}</TableCell>
                      <TableCell className="tabular-nums">
                        {Math.round(stat.correctRate * 100)}%
                        {stat.flaggedHard && <Badge variant="destructive" className="ml-2">ตอบผิดเกิน 70% — ตรวจโจทย์</Badge>}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {snapshot.regradeHistory.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">ประวัติการ Re-grade</CardTitle></CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            <ul className="space-y-1">
              {snapshot.regradeHistory.slice(0, 8).map((h) => (
                <li key={h.runAtMs}>
                  {new Date(h.runAtMs).toLocaleString('th-TH')} — {h.summaryJson}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/* ---------- มุมมอง 2: ตรวจรายข้อ (Blind Grading) ---------- */

function ByQuestionTab({
  snapshot,
  questionList
}: {
  snapshot: FormResponsesSnapshot
  questionList: Array<{ itemId: string; prompt: string; index: number }>
}): React.JSX.Element {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [blind, setBlind] = useState(false)
  const effective = selectedItemId ?? questionList[0]?.itemId ?? null

  const allPending = snapshot.students.some(
    (s) => s.items.some((i) => i.itemId === effective && i.status === 'needs-manual')
  )
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={effective ?? ''} onValueChange={(v) => setSelectedItemId(v)}>
          <SelectTrigger className="w-72 text-xs"><SelectValue placeholder="เลือกข้อ" /></SelectTrigger>
          <SelectContent>
            {questionList.map((q) => (
              <SelectItem key={q.itemId} value={q.itemId}>
                Q{q.index}: {q.prompt.length > 0 ? q.prompt.slice(0, 40) : q.itemId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant={blind ? 'default' : 'outline'}
          size="sm"
          onClick={() => setBlind(!blind)}
        >
          <EyeOff size={12} /> {blind ? 'Blind Grading เปิดอยู่' : 'Blind Grading'}
        </Button>
        {allPending && <Badge variant="outline">ข้อนี้มีคำตอบรอครูตรวจ</Badge>}
      </div>
      <div className="space-y-3">
        {snapshot.students.map((student) => {
          const view = student.items.find((i) => i.itemId === effective)
          if (view === undefined) return null
          return <GradingRow key={student.studentId} student={student} view={view} blind={blind} snapshot={snapshot} />
        })}
      </div>
    </div>
  )
}

function GradingRow({
  student,
  view,
  blind,
  snapshot
}: {
  student: FormStudentResponsesView
  view: FormItemAnswerView
  blind: boolean
  snapshot: FormResponsesSnapshot
}): React.JSX.Element {
  const api = window.ztExam
  const [points, setPoints] = useState<string>(
    view.manualPoints !== null ? String(view.manualPoints) : view.status === 'auto-graded' ? String(view.earnedPoints) : ''
  )
  const handIn = async (): Promise<void> => {
    const n = points.trim().length === 0 ? null : Number(points)
    if (n !== null && !Number.isFinite(n)) return
    await api.formManualGrade({ studentId: student.studentId, itemId: view.itemId, points: n })
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') void handIn()
  }
  const needManual = view.status === 'needs-manual'
  const formItem = snapshot.form.items.find((i) => i.itemId === view.itemId)
  const isFileUpload = formItem !== undefined && isFormItemQuestion(formItem) && formItem.inputType === 'file_upload'
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{blind ? 'ผู้สอบ ' + student.studentId.slice(0, 6) + '…' : student.studentName}</p>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              ส่งเมื่อ {student.submittedAtMs === null ? 'ยังไม่ส่ง' : new Date(student.submittedAtMs).toLocaleString('th-TH')} • ใช้เวลา {Math.round((view.journey?.timeSpentMs ?? 0) / 1000)} วินาที
            </p>
          </div>
          <StatusBadge status={view.status} earned={view.earnedPoints} max={view.maxPoints} />
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm">{view.displayValue.length > 0 ? view.displayValue : '(ไม่ตอบ)'}</p>
        {isFileUpload && (
          <p
            title="F-1: LAN ยังไม่ส่งไบนารีไฟล์แนบ — รายการนี้เป็น descriptor/ชื่อไฟล์เท่านั้น"
            className="mt-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px]"
          >
            ข้อนี้เป็น file_upload (F-1) — ยังไม่มีไบนารีผ่าน LAN{view.artifacts.length === 0 ? ' (ไม่มีไฟล์แนบมาถึง — เก็บไฟล์จริงช่องทางอื่น)' : ' (รายการด้านล่างเป็น descriptor/ลิงก์เท่านั้น)'}
          </p>
        )}
        {view.artifacts.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {view.artifacts.map((a) => (
              <Button
                key={a.artifactId}
                type="button"
                variant="outline"
                size="sm"
                title="F-1: เปิดได้เฉพาะ descriptor/ไฟล์ที่ครูนำเข้าช่องทางอื่นแล้ว — ไม่ใช่ไบนารีที่นักเรียนอัปโหลดผ่าน LAN"
                onClick={() => void window.ztExam.openFormArtifact({ studentId: student.studentId, itemId: view.itemId, artifactId: a.artifactId })}
              >
                <Paperclip size={10} /> {a.fileName} ({Math.round(a.sizeBytes / 1024)} KB)
              </Button>
            ))}
          </div>
        )}
        {needManual && view.keywordHits !== undefined && (
          <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
            พบ Keyword {view.keywordHits}/{view.keywordTotal} คำ: {view.keywordFound?.join(', ') ?? '—'}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <Input
            type="number"
            step="0.5"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`คะแนน (เต็ม ${view.maxPoints})`}
            className="w-32 text-sm tabular-nums"
            aria-label="คะแนนที่ให้"
          />
          <Button type="button" size="sm" onClick={handIn}>
            ให้คะแนน
          </Button>
          {(view.status === 'needs-manual' || view.status === 'invalid') && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void api.formManualGrade({ studentId: student.studentId, itemId: view.itemId, points: null })}>
              ล้างคะแนน
            </Button>
          )}
          <span className="text-[11px] text-muted-foreground">
            {snapshot.form.items.find((i) => i.itemId === view.itemId) && view.correctDisplay !== null ? `เฉลย: ${view.correctDisplay}` : ''}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function StatusBadge(props: { status: FormItemAnswerView['status']; earned: number; max: number }): React.JSX.Element {
  const label = props.status === 'auto-graded' ? 'ตรวจแล้ว' : props.status === 'needs-manual' ? 'รอตรวจ' : props.status === 'manual-graded' ? 'ครูตรวจแล้ว' : props.status
  const variant = props.status === 'auto-graded' || props.status === 'manual-graded' ? 'default' : props.status === 'needs-manual' ? 'outline' : 'destructive'
  return <Badge variant={variant} className="tabular-nums">{label} • {props.earned}/{props.max}</Badge>
}

/* ---------- มุมมอง 3: ใบคำตอบรายบุคคล ---------- */

function IndividualTab({ snapshot }: { snapshot: FormResponsesSnapshot }): React.JSX.Element {
  const [selectedStudent, setSelectedStudent] = useState<string | null>(null)
  const effective = selectedStudent ?? snapshot.students[0]?.studentId ?? null
  const student = snapshot.students.find((s) => s.studentId === effective)
  if (student === undefined) {
    return <div className="p-8 text-center text-sm text-muted-foreground">ยังไม่มีข้อมูลนักเรียน</div>
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={effective ?? ''} onValueChange={(v) => setSelectedStudent(v)}>
          <SelectTrigger className="w-64 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {snapshot.students.map((s) => (
              <SelectItem key={s.studentId} value={s.studentId}>
                {s.studentName} ({Math.round(s.totals.percent)}%)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 text-xs">
          <SecurityBadge status={student.security.status} />
          <span className="text-muted-foreground tabular-nums">คะแนนความน่าสงสัย {student.security.suspicionScore} • เหตุการณ์วิกฤต {student.security.criticalEvents}</span>
        </div>
        <div className="ml-auto text-xs tabular-nums">
          คะแนน <b>{student.totals.totalPoints}</b>/{student.totals.maxPoints} ({student.totals.percent.toFixed(1)}%) • รอตรวจ {student.totals.needsManualCount} ข้อ
        </div>
      </div>
      <div className="space-y-2">
        {student.items.map((view, idx) => (
          <Card key={view.itemId}>
            <CardContent className="pt-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">
                  Q{idx + 1}. {promptOf(snapshot, view.itemId, false)}
                </p>
                <StatusBadge status={view.status} earned={view.earnedPoints} max={view.maxPoints} />
              </div>
              <p className="mt-1 whitespace-pre-wrap">{view.displayValue.length > 0 ? view.displayValue : '(ไม่ตอบ)'}</p>
              {view.correctDisplay !== null && <p className="mt-1 text-[11px] text-primary">เฉลย: {view.correctDisplay}</p>}
              <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                ใช้เวลา {Math.round((view.journey?.timeSpentMs ?? 0) / 1000)} วิ {view.violations.length > 0 ? `• ผิดกฎ: ${view.violations.map((v) => v.code).join(', ')}` : ''}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

function promptOf(snapshot: FormResponsesSnapshot, itemId: string, short: boolean): string {
  const item = snapshot.form.items.find((i) => i.itemId === itemId)
  const text = item !== undefined && isFormItemQuestion(item) ? item.prompt : itemId
  const stat = snapshot.itemStats.find((s) => s.itemId === itemId)
  const prefix = stat !== undefined ? `Q${stat.index}` : ''
  const body = text.length > 0 ? text : itemId
  return short ? (prefix.length > 0 ? `${prefix} ${body.slice(0, 34)}` : body.slice(0, 34)) : body
}

function SecurityBadge({ status }: { status: FormStudentResponsesView['security']['status'] }): React.JSX.Element {
  const variant = status === 'CRITICAL' ? 'destructive' : status === 'WARNING' ? 'outline' : 'default'
  return <Badge variant={variant}>{status}</Badge>
}

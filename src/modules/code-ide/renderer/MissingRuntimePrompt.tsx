import { useCallback, useEffect, useState } from 'react'
import { FolderSearch, RefreshCcw, TriangleAlert, CircleCheck } from 'lucide-react'
import type { CodeIdeRuntimeStatus } from '../../../shared/ipc-channels'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'

/* Phase 9 (9.1) — MissingRuntimePrompt (ใช้ร่วมกันฝั่งครู + ฝั่งนักเรียน)
 * - ตรวจ runtime ของภาษาที่โจทย์ใช้จริง (ไม่ดาวน์โหลดแยก — ให้ผู้ใช้ติดตั้งเอง)
 * - ถ้าขาด: แบนเนอร์ + คำแนะนำติดตั้ง + ปุ่มตรวจสอบอีกครั้ง และเลือกโฟลเดอร์ที่ติดตั้งเอง
 * - ถ้าครบ: ไม่แสดงอะไร (หรือโชว์ข้อความพร้อมถ้า showWhenReady)
 */

interface Props {
  /** ภาษาของโจทย์ข้อนี้ (เช่น ['python'] / ['java']) — sql คืน [] = ไม่ต้องตรวจ */
  languages: string[]
  compact?: boolean | undefined
  showWhenReady?: boolean | undefined
  onStatusChange?: ((allReady: boolean) => void) | undefined
}

function hasIpc(): boolean {
  try {
    return typeof window !== 'undefined' && window.ztExam?.checkRuntimes !== undefined
  } catch {
    return false
  }
}

export default function MissingRuntimePrompt(props: Props): React.JSX.Element | null {
  const [statuses, setStatuses] = useState<CodeIdeRuntimeStatus[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const check = useCallback(async () => {
    if (!hasIpc()) {
      setStatuses([])
      return
    }
    setChecking(true)
    setMessage(null)
    try {
      const res = await window.ztExam.checkRuntimes({ languages: props.languages })
      setStatuses(res.runtimes)
      props.onStatusChange?.(res.runtimes.every((r) => r.found))
    } catch {
      setMessage('ตรวจ runtime ไม่สำเร็จ — ลองกดตรวจสอบอีกครั้ง')
    } finally {
      setChecking(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.languages.join(',')])

  useEffect(() => {
    void check()
  }, [check])

  async function browseFor(runtimeName: string): Promise<void> {
    if (!hasIpc()) return
    setBusy(runtimeName)
    setMessage(null)
    try {
      const picked = await window.ztExam.browseSdkPath({ title: `เลือกโฟลเดอร์ที่ติดตั้ง ${runtimeName} ไว้` })
      if (!picked.ok || picked.dirPath === undefined) return // กดยกเลิก — เงียบไว้
      const added = await window.ztExam.addSdkPath({ runtime: runtimeName, dirPath: picked.dirPath })
      if (added.ok) {
        setMessage(`ใช้ ${runtimeName} จาก ${picked.dirPath} ได้แล้ว (${added.version ?? ''})`)
        await check()
      } else {
        setMessage(`${added.reason ?? 'ลงทะเบียนโฟลเดอร์ไม่สำเร็จ'}`)
      }
    } catch (err) {
      setMessage(`เลือกโฟลเดอร์ไม่สำเร็จ: ${err instanceof Error ? err.message : 'IPC error'}`)
    } finally {
      setBusy(null)
    }
  }

  if (statuses === null) return null
  const missing = statuses.filter((r) => !r.found)
  if (missing.length === 0) {
    if (props.showWhenReady !== true || statuses.length === 0) return null
    return (
      <Card className="border-primary/40 bg-primary/5">
        <CardContent className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
          <CircleCheck size={13} className="text-primary" />
          Runtime พร้อม ({statuses.map((r) => r.name).join(', ')})
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="border-b px-3 py-1.5">
      <Card className={props.compact === true ? 'p-2' : 'p-3'}>
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-sm">
            <TriangleAlert size={13} /> ไม่พบ {missing.map((r) => r.name).join(', ')} ในเครื่องนี้
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void check()}
            disabled={checking}
            className="ml-auto"
          >
            <RefreshCcw size={12} /> {checking ? 'กำลังตรวจ…' : 'ตรวจสอบอีกครั้ง'}
          </Button>
        </div>
        <p className="mb-2 text-[11px] text-muted-foreground">
          แอปไม่ดาวน์โหลด runtime ให้เอง — ติดตั้งลงเครื่องด้วยตนเองก่อนกดรัน/ตรวจ (ติดตั้งเสร็จกดตรวจสอบอีกครั้งได้ทันที ไม่ต้องปิดแอป)
        </p>
        <div className="space-y-1.5">
          {missing.map((r) => (
            <div key={r.name} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-[12px]">
              <span className="font-mono font-semibold text-destructive">{r.name}</span>
              <span className="flex-1 text-muted-foreground">{r.hint}</span>
              {r.customPath !== undefined && (
                <span className="font-mono text-[10px] text-muted-foreground">เคยเลือก: {r.customPath}</span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void browseFor(r.name)}
                disabled={busy !== null}
              >
                <FolderSearch size={12} /> {busy === r.name ? 'กำลังตรวจ…' : 'เลือกโฟลเดอร์เอง'}
              </Button>
            </div>
          ))}
        </div>
        {message !== null && <p className="mt-1.5 text-[11px] text-muted-foreground">{message}</p>}
      </Card>
    </div>
  )
}

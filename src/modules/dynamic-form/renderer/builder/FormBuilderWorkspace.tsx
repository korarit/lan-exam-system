import { useEffect, useState } from 'react'
import {
  FilePlus2,
  KeyRound,
  Users,
  Timer,
  ArrowUpDown,
  Check,
  History
} from 'lucide-react'
import type { DynamicFormDefinition, FormAssetMap, FormItem } from '../../shared/form-schema'
import { useFormBuilderStore, collectFormIssues, listQuestions } from './form-builder-store'
import { QuestionCard } from './QuestionCard'
import FloatingBuilderToolbar from './FloatingBuilderToolbar'
import StudentFormPreviewModal from './StudentFormPreviewModal'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Separator } from '@renderer/components/ui/separator'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
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

/* ============================================================
 * Phase 6 (6.2) — หน้าจอสร้างฟอร์มข้อสอบแบบ Google Forms ของครู
 * ครบสมบูรณ์ทั้งตั้งค่าฟอร์ม, การ์ด, import, และการเชื่อมผ่าน IPC
 * ============================================================ */

export default function FormBuilderWorkspace(): React.JSX.Element {
  const form = useFormBuilderStore((s) => s.form)
  const assets = useFormBuilderStore((s) => s.assets)
  const expandedItemId = useFormBuilderStore((s) => s.expandedItemId)
  const setExpandedItem = useFormBuilderStore((s) => s.setExpandedItem)
  const updateItem = useFormBuilderStore((s) => s.updateItem)
  const removeItem = useFormBuilderStore((s) => s.removeItem)
  const duplicateItem = useFormBuilderStore((s) => s.duplicateItem)
  const moveItem = useFormBuilderStore((s) => s.moveItem)
  const addItems = useFormBuilderStore((s) => s.addItems)
  const loadFromPayload = useFormBuilderStore((s) => s.loadFromPayload)
  const putAsset = useFormBuilderStore((s) => s.putAsset)

  const [previewOpen, setPreviewOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [passwordModal, setPasswordModal] = useState<{ kind: 'load' | 'save'; password?: string } | null>(null)
  const [savedForms, setSavedForms] = useState<Array<{ formId: string; title: string; filePath: string; totalQuestions: number; totalPoints: number; encrypted: boolean }>>([])
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void window.ztExam
      .listSavedForms()
      .then((res) => setSavedForms(res.forms))
      .catch(() => setSavedForms([]))
  }, [])

  const questions = listQuestions(form.items)
  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0)

  async function handleSave(encrypted: boolean): Promise<void> {
    if (encrypted) {
      setPasswordModal({ kind: 'save' })
      return
    }
    await doSave(encrypted, undefined)
  }

  async function doSave(encrypted: boolean, password: string | undefined): Promise<void> {
    const issues = collectFormIssues(form)
    if (form.items.length === 0) {
      setNotice('ฟอร์มยังว่าง — ให้เพิ่มคำถามอย่างน้อย 1 ข้อก่อนบันทึก')
      return
    }
    if (issues.length > 0) {
      setNotice(`ยังบันทึกไม่ได้ • ${issues[0]}`)
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      const formPayloadJson = JSON.stringify({ form, assets })
      const res = await window.ztExam.saveZtform({ formPayloadJson, encrypted, ...(password !== undefined ? { password } : {}) })
      if (res.ok) {
        setNotice(`บันทึกสำเร็จ: ${res.filePath}`)
        void window.ztExam.listSavedForms().then((r) => setSavedForms(r.forms))
      } else {
        setNotice(
          res.reason === 'CANCELLED'
            ? 'ยกเลิกการบันทึก'
            : res.reason === 'PASSWORD_REQUIRED'
              ? 'ยังไม่ได้ใส่รหัสผ่าน'
              : res.reason === 'FORM_EMPTY'
                ? 'ฟอร์มยังไม่มีข้อ'
                : `บันทึกไม่สำเร็จ: ${res.reason ?? '?'}`
        )
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleLoad(password?: string): Promise<void> {
    setLoading(true)
    setNotice(null)
    try {
      const res = await window.ztExam.loadZtform(password !== undefined ? { password } : {})
      if (res.ok && res.formPayloadJson !== undefined && res.manifest !== undefined) {
        const parsed = JSON.parse(res.formPayloadJson) as { form: DynamicFormDefinition; assets: FormAssetMap }
        loadFromPayload(parsed.form, parsed.assets ?? {})
        setNotice(`เปิด "${res.manifest.title}" — ${res.manifest.totalQuestions} ข้อ / ${res.manifest.totalPoints} คะแนน`)
      } else if (res.needPassword === true) {
        setPasswordModal({ kind: 'load' })
        setNotice(res.message ?? 'ต้องใส่รหัสผ่านของไฟล์นี้')
      } else {
        setNotice(res.message ?? 'เปิดไฟล์ไม่สำเร็จ')
      }
    } catch (err) {
      setNotice(err instanceof Error ? `เปิดไฟล์ไม่สำเร็จ: ${err.message}` : 'เปิดไฟล์ไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }

  async function handleImportCsv(): Promise<void> {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv,.json,text/csv,application/json'
    let done = false
    const result = await new Promise<Array<FormItem>>((resolve) => {
      input.onchange = async () => {
        const file = input.files?.[0]
        if (file === undefined) {
          resolve([])
          return
        }
        try {
          const text = await file.text()
          const isJson = file.name.toLowerCase().endsWith('.json')
          const mod = isJson ? (await import('../../shared/csv-import')).importQuestionsFromJson : (await import('../../shared/csv-import')).importQuestionsFromCsv
          const imported = mod(text)
          if (imported.errors.length > 0) {
            setNotice(`นำเข้าบางส่วน (${imported.items.length} ข้อ) • ${imported.errors.slice(0, 2).join(' | ')}`)
          } else {
            setNotice(`นำเข้า ${imported.items.length} รายการสำเร็จ`)
          }
          resolve(imported.items)
        } catch (err) {
          setNotice(err instanceof Error ? `อ่านไฟล์ล้มเหลว: ${err.message}` : 'อ่านไฟล์ล้มเหลว')
          resolve([])
        } finally {
          done = true
        }
      }
      window.addEventListener(
        'click',
        () => {
          if (!done) setTimeout(() => resolve([]), 500)
        },
        { once: true }
      )
    })
    if (result.length > 0) addItems(result)
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <FilePlus2 size={18} className="text-primary" />
          <h2 className="font-semibold">โมดูล Dynamic Form — สร้างชุดข้อสอบสไตล์ Google Forms</h2>
          <Badge variant="secondary" className="ml-auto tabular-nums">
            {questions.length} ข้อ · {Math.round(totalPoints * 100) / 100} คะแนน · {Object.keys(assets).length} รูปภาพฝังในไฟล์
          </Badge>
        </CardContent>
      </Card>

      {savedForms.length > 0 && (
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <History size={13} /> ฟอร์มที่เคยเปิดบนเครื่องนี้ (ล่าสุด)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-48">
              <ul className="space-y-1.5">
                {savedForms.slice(0, 5).map((fmt) => (
                  <li
                    key={fmt.formId}
                    className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
                  >
                    <span className="truncate font-medium">{fmt.title}</span>
                    <Badge variant="outline">
                      {fmt.totalQuestions} ข้อ · {fmt.totalPoints} คะแนน {fmt.encrypted ? '· เข้ารหัส' : ''}
                    </Badge>
                    <code className="ml-auto hidden truncate font-mono text-[10px] text-muted-foreground sm:inline">{fmt.filePath}</code>
                  </li>
                ))}
              </ul>
            </ScrollArea>
            <p className="mt-2 text-[11px] text-muted-foreground">เปิดซ้ำจากปุ่ม "เปิดไฟล์ .ztform" ด้านขวา (ไฟล์เข้ารหัสต้องใช้รหัสผ่านที่ตั้งไว้)</p>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-4">
        <div className="min-w-0 flex-1 space-y-4">
          <Card>
            <CardContent className="space-y-2 pt-6">
              <Input
                value={form.title}
                maxLength={120}
                onChange={(e) => useFormBuilderStore.getState().setTitle(e.target.value)}
                className="text-lg font-semibold"
                placeholder="ชื่อชุดข้อสอบ"
                aria-label="ชื่อชุดข้อสอบ"
              />
              <textarea
                value={form.instructions}
                maxLength={4000}
                rows={2}
                onChange={(e) => useFormBuilderStore.getState().setInstructions(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-4 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="คำชี้แจงก่อนเริ่มทำ (ถ้ามี)"
                aria-label="คำชี้แจงก่อนเริ่มทำ"
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <SettingsField icon={<Timer size={13} />} label="เวลาสอบ (นาที)">
                  <Input
                    type="number"
                    min={1}
                    max={480}
                    value={form.settings.durationMinutes}
                    onChange={(e) => useFormBuilderStore.getState().patchSettings({ durationMinutes: Math.min(480, Math.max(1, Number(e.target.value) || 1)) })}
                    className="w-24 text-right font-mono tabular-nums"
                    aria-label="เวลาสอบนาที"
                  />
                </SettingsField>
                <SettingsField icon={<ArrowUpDown size={13} />} label="สลับลำดับข้อรายคน">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-pressed={form.settings.shuffleQuestionsPerStudent}
                    onClick={() => useFormBuilderStore.getState().patchSettings({ shuffleQuestionsPerStudent: !form.settings.shuffleQuestionsPerStudent })}
                  >
                    <Check size={16} className={form.settings.shuffleQuestionsPerStudent ? 'text-primary' : 'text-muted-foreground'} />
                  </Button>
                </SettingsField>
                <SettingsField icon={<Users size={13} />} label="การนำทาง">
                  <Select
                    value={form.settings.navigationPolicy}
                    onValueChange={(v) => useFormBuilderStore.getState().patchSettings({ navigationPolicy: v as 'strict-one-way' | 'allow-visited-review' })}
                  >
                    <SelectTrigger className="w-56 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="strict-one-way">ส่งข้อแล้วห้ามย้อนกลับ</SelectItem>
                      <SelectItem value="allow-visited-review">ย้อนกลับเฉพาะข้อที่เคยเปิดได้</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingsField>
                <SettingsField icon={<Check size={13} />} label="แสดงคะแนนปรนัยหลังส่ง">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-pressed={form.settings.showScoreImmediatelyAfterSubmit}
                    onClick={() => useFormBuilderStore.getState().patchSettings({ showScoreImmediatelyAfterSubmit: !form.settings.showScoreImmediatelyAfterSubmit })}
                  >
                    <Check size={16} className={form.settings.showScoreImmediatelyAfterSubmit ? 'text-primary' : 'text-muted-foreground'} />
                  </Button>
                </SettingsField>
              </div>
            </CardContent>
          </Card>

          {form.items.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="p-10 text-center text-sm text-muted-foreground">
                ยังไม่มีข้อ — กด "+ เพิ่มคำถาม / บล็อก" หรือนำเข้าจาก CSV / JSON
              </CardContent>
            </Card>
          )}

          {form.items.map((item, index) => (
            <QuestionCard
              key={item.itemId}
              item={item}
              index={index}
              expanded={expandedItemId === item.itemId}
              assets={assets}
              onToggleExpand={() => setExpandedItem(expandedItemId === item.itemId ? null : item.itemId)}
              onChange={(next) => updateItem(item.itemId, () => next)}
              onRemove={() => removeItem(item.itemId)}
              onDuplicate={() => duplicateItem(item.itemId)}
              onMove={(direction) => moveItem(item.itemId, direction)}
              onFirst={index === 0}
              onLast={index === form.items.length - 1}
              onAssetAdded={(assetId, mimeType, dataBase64) => putAsset(assetId, mimeType, dataBase64)}
            />
          ))}
        </div>

        <FloatingBuilderToolbar
          onPreview={() => setPreviewOpen(true)}
          onSave={handleSave}
          onLoad={(password) => handleLoad(password)}
          onImportCsv={handleImportCsv}
          saving={saving}
          loading={loading}
        />
      </div>

      {notice !== null && (
        <Card className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 shadow-lg">
          <CardContent className="px-4 py-2.5 text-sm">{notice}</CardContent>
        </Card>
      )}

      <StudentFormPreviewModal open={previewOpen} onOpenChange={setPreviewOpen} form={form} assets={assets} onClose={() => setPreviewOpen(false)} />

      <PasswordAskModal
        state={passwordModal}
        onSubmit={(password) => {
          const kind = passwordModal?.kind ?? 'save'
          setPasswordModal(null)
          if (kind === 'save') void doSave(true, password)
          else void handleLoad(password)
        }}
        onCancel={() => {
          setPasswordModal(null)
          setNotice(null)
        }}
      />
    </div>
  )
}

function SettingsField(props: { icon: React.ReactNode; label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      {props.icon}
      <Label className="text-xs">{props.label}</Label>
      <div className="ml-auto flex items-center">{props.children}</div>
    </div>
  )
}

function PasswordAskModal(props: {
  state: { kind: 'load' | 'save' } | null
  onSubmit(password: string): void
  onCancel(): void
}): React.JSX.Element | null {
  const [password, setPassword] = useState('')
  const valid = password.length > 0 && password.length <= 200
  if (props.state === null) return null
  const kind = props.state.kind
  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onCancel() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound size={18} className="text-primary" />
            {kind === 'load' ? 'รหัสผ่านของไฟล์ .ztform' : 'ตั้งรหัสผ่านเข้ารหัสไฟล์'}
          </DialogTitle>
          <DialogDescription>
            {kind === 'load'
              ? 'ไฟล์ถูกเข้ารหัสแบบ AES-256-GCM (PBKDF2) — ใส่รหัสผ่านที่ตั้งไว้ตอนบันทึก'
              : 'รหัสผ่านจะแปลงเป็นคีย์ด้วย PBKDF2 (100,000 รอบ) แล้วเข้ารหัสเนื้อหาทั้งหมด — ห้ามลืมรหัสผ่าน!'}
          </DialogDescription>
        </DialogHeader>
        <Separator />
        <Input
          type="password"
          autoFocus
          value={password}
          maxLength={200}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid) props.onSubmit(password)
          }}
          aria-label="รหัสผ่านไฟล์"
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onCancel}>
            ยกเลิก
          </Button>
          <Button
            type="button"
            disabled={!valid}
            onClick={() => props.onSubmit(password)}
          >
            ตกลง
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { X } from 'lucide-react'
import { CLI_INPUT_TYPES, typedInputsToStdin, type CliTypedInput, type CodeTestCase } from '../../shared/code-schema'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'

/* ฟอร์มตั้ง input/output ฝั่งครู สไตล์ LeetCode:
 * - เพิ่ม input ทีละตัว: ชื่อ (เช่น x, s) + type (string/int/float/bool) + ค่า
 * - พรีวิว stdin ที่จะส่งให้โปรแกรมนักเรียน + ช่องคำตอบที่คาดหวัง (expected)
 * - ถ้าไม่ใช้ฟอร์ม typed ก็พิมพ์ stdin ตรง ๆ ได้ (โจทย์เฉย ๆ ไม่มีตรวจก็ได้)
 */

interface Props {
  test: CodeTestCase
  index: number
  onChange: (next: CodeTestCase) => void
  onDelete: () => void
}

function newInput(n: number): CliTypedInput {
  return { name: `x${n}`, type: 'int', value: '' }
}

export default function TestCaseEditor(props: Props): React.JSX.Element {
  const { test, index, onChange, onDelete } = props
  const patch = (p: Partial<CodeTestCase>): void => onChange({ ...test, ...p } as CodeTestCase)

  return (
    <Card>
      <CardContent className="pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="font-mono text-[10px]">{test.kind} #{index + 1}</Badge>
          <Input
            value={test.title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="ชื่อ test เช่น บวกเลข 2 จำนวน"
            className="min-w-40 flex-1 text-xs"
            aria-label="ชื่อ test"
          />
          <Label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Input
              type="number" value={test.points} min={1}
              onChange={(e) => patch({ points: Math.max(1, Number(e.target.value) || 1) })}
              className="w-16 font-mono tabular-nums"
              aria-label="คะแนน"
            /> คะแนน
          </Label>
          <Select
            value={test.visibility}
            onValueChange={(v) => patch({ visibility: v as 'sample' | 'hidden' })}
          >
            <SelectTrigger className="w-64 text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="sample">sample (นักเรียนเห็น input/output)</SelectItem>
              <SelectItem value="hidden">hidden (ตรวจลับ)</SelectItem>
            </SelectContent>
          </Select>
          <Button type="button" variant="ghost" size="icon" onClick={onDelete} aria-label="ลบ test"><X size={14} /></Button>
        </div>

        {(test.kind === 'stdio' || test.kind === 'unit-harness') && (
        <div className="mt-2 space-y-2">
          {test.kind === 'unit-harness' && (
            <Label className="block text-[11px] text-muted-foreground">
              Harness target (เช่น tests/test_main.py::test_sum)
              <Input
                value={test.harnessTarget ?? ''}
                onChange={(e) => patch({ harnessTarget: e.target.value })}
                className="mt-0.5 font-mono text-xs"
              />
            </Label>
          )}

          {/* --- Typed inputs (LeetCode-style) --- */}
          <Card className="bg-muted/40">
            <CardContent className="pt-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[11px] font-medium">Inputs (กำหนดทีละตัว + บอก type)</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => patch({ inputs: [...(test.inputs ?? []), newInput((test.inputs ?? []).length + 1)] })}
                  className="ml-auto"
                >
                  + เพิ่ม input
                </Button>
              </div>
              {(test.inputs ?? []).length === 0 && (
                <p className="text-[11px] text-muted-foreground">ยังไม่มี input แบบระบุ type — กด “+ เพิ่ม input” หรือพิมพ์ stdin ตรง ๆ ด้านล่างก็ได้ (ตั้งโจทย์เฉย ๆ ไม่มีตรวจก็ได้)</p>
              )}
              {(test.inputs ?? []).map((inp, ii) => (
                <div key={ii} className="mb-1.5 grid grid-cols-[1fr_110px_1fr_auto] items-center gap-1.5">
                  <Input
                    value={inp.name}
                    onChange={(e) => patch({ inputs: (test.inputs ?? []).map((x, xi) => (xi === ii ? { ...x, name: e.target.value } : x)) })}
                    placeholder="ชื่อ เช่น x"
                    className="font-mono text-xs"
                    aria-label="ชื่อ input"
                  />
                  <Select
                    value={inp.type}
                    onValueChange={(v) => patch({ inputs: (test.inputs ?? []).map((x, xi) => (xi === ii ? { ...x, type: v as CliTypedInput['type'] } : x)) })}
                  >
                    <SelectTrigger className="font-mono text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CLI_INPUT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input
                    value={inp.value}
                    onChange={(e) => patch({ inputs: (test.inputs ?? []).map((x, xi) => (xi === ii ? { ...x, value: e.target.value } : x)) })}
                    placeholder={inp.type === 'string' ? 'ค่า เช่น hello' : inp.type === 'int' ? 'ค่า เช่น 5' : inp.type === 'float' ? 'ค่า เช่น 3.14' : 'true / false'}
                    className="font-mono text-xs"
                    aria-label="ค่า input"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => patch({ inputs: (test.inputs ?? []).filter((_, xi) => xi !== ii) })}
                    aria-label="ลบ input"
                  ><X size={13} /></Button>
                </div>
              ))}
              {(test.inputs ?? []).length > 0 && (
                <div className="mt-1 rounded-md bg-muted p-1.5 font-mono text-[11px]">
                  <span className="text-muted-foreground">stdin ที่จะส่งให้โปรแกรม (auto):</span>
                  <pre className="whitespace-pre-wrap text-primary">{typedInputsToStdin(test.inputs ?? []) || '(ยังไม่มีค่า)'}</pre>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => patch({ stdin: typedInputsToStdin(test.inputs ?? []) })}
                    className="mt-1"
                  >คัดลอกไปใส่ช่อง stdin ด้านล่าง</Button>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <Label className="block text-[11px] text-muted-foreground">
              stdin (ส่งให้โปรแกรมนักเรียน)
              <textarea
                value={test.stdin} rows={3}
                onChange={(e) => patch({ stdin: e.target.value })}
                placeholder={'เช่น\n5\n10'}
                className="mt-0.5 w-full rounded-md border border-input bg-background px-1.5 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </Label>
            <Label className="block text-[11px] text-muted-foreground">
              expected output (คำตอบที่ถือว่าผ่าน)
              <textarea
                value={test.expectedStdout} rows={3}
                onChange={(e) => patch({ expectedStdout: e.target.value })}
                placeholder="เช่น 15"
                className="mt-0.5 w-full rounded-md border border-primary/40 bg-background px-1.5 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </Label>
          </div>
          <p className="text-[10px] text-muted-foreground">ว่างได้ทั้งสองช่อง = ตั้งโจทย์เฉย ๆ ไม่ตรวจอัตโนมัติ · ใส่ expected ไว้ = ระบบช่วยตรวจให้ (ผ่านเมื่อ output ตรง)</p>
        </div>
        )}

        {test.kind === 'sql-query' && (
        <div className="mt-2 grid grid-cols-1 gap-2">
          <Label className="block text-[11px] text-muted-foreground">
            expected columns (คั่นด้วย ,)
            <Input
              value={test.expectedColumns.join(', ')}
              onChange={(e) => patch({ expectedColumns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              className="mt-0.5 font-mono text-xs"
            />
          </Label>
          <Label className="block text-[11px] text-muted-foreground">
            verificationQuery (ถ้าโจทย์เป็น INSERT/UPDATE/DELETE — ใช้ SELECT ตรวจ)
            <textarea value={test.verificationQuery ?? ''} rows={2} onChange={(e) => patch({ verificationQuery: e.target.value })} className="mt-0.5 w-full rounded-md border border-input bg-background px-1.5 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </Label>
        </div>
        )}

        {test.kind === 'http-api' && (
        <div className="mt-2 space-y-2">
          {test.requests.map((r, ri) => (
            <Card key={ri} className="bg-muted/40">
              <CardContent className="pt-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Select
                    value={r.method}
                    onValueChange={(v) => patch({
                      requests: test.requests.map((x, xi) => (xi === ri
                        ? { ...x, method: v as typeof x.method }
                        : x))
                    })}
                  >
                    <SelectTrigger className="w-28 font-mono text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input
                    value={r.path}
                    onChange={(e) => patch({
                      requests: test.requests.map((x, xi) => (xi === ri ? { ...x, path: e.target.value } : x))
                    })}
                    placeholder="/api/users?role=admin"
                    className="min-w-40 flex-1 font-mono text-xs"
                    aria-label="พาธ request"
                  />
                  <Label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Input
                      type="number" value={r.expectedStatus} min={100} max={599}
                      onChange={(e) => patch({
                        requests: test.requests.map((x, xi) => (xi === ri
                          ? { ...x, expectedStatus: Math.max(100, Math.min(599, Number(e.target.value) || 200)) }
                          : x))
                      })}
                      className="w-16 font-mono tabular-nums"
                      aria-label="สถานะที่คาดหวัง"
                    /> status
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => patch({ requests: test.requests.filter((_, xi) => xi !== ri) })}
                    aria-label="ลบ request"
                  ><X size={13} /></Button>
                </div>
                <div className="mt-1.5 grid grid-cols-1 gap-1.5 md:grid-cols-2">
                  <Label className="block text-[11px] text-muted-foreground">
                    bodyJson (ส่ง — เว้นว่างได้)
                    <textarea
                      value={r.bodyJson ?? ''} rows={2}
                      onChange={(e) => patch({
                        requests: test.requests.map((x, xi) => (xi === ri ? { ...x, bodyJson: e.target.value } : x))
                      })}
                      placeholder='{"name": "Ann"}'
                      className="mt-0.5 w-full rounded-md border border-input bg-background px-1.5 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </Label>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-muted-foreground">ตรวจ response:</span>
                      <Select
                        value={r.expectedBodyMatcher}
                        onValueChange={(v) => patch({
                          requests: test.requests.map((x, xi) => (xi === ri
                            ? { ...x, expectedBodyMatcher: v as typeof x.expectedBodyMatcher }
                            : x))
                        })}
                      >
                        <SelectTrigger className="w-36 font-mono text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="json-subset">json-subset</SelectItem>
                          <SelectItem value="exact-json">exact-json</SelectItem>
                          <SelectItem value="regex">regex</SelectItem>
                          <SelectItem value="custom-script">contains</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <textarea
                      value={r.expectedBody} rows={2}
                      onChange={(e) => patch({
                        requests: test.requests.map((x, xi) => (xi === ri ? { ...x, expectedBody: e.target.value } : x))
                      })}
                      placeholder='{"ok": true} / regex / ข้อความที่ต้องมี'
                      className="mt-1 w-full rounded-md border border-primary/40 bg-background px-1.5 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => patch({
              requests: [...test.requests, { method: 'GET' as const, path: '/api/users', expectedStatus: 200, expectedBodyMatcher: 'json-subset' as const, expectedBody: '{}' }]
            })}
          >
            + เพิ่ม request
          </Button>
          <Card className="bg-muted/40">
            <CardContent className="pt-3 text-[11px] text-muted-foreground">
              <Label className="mb-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={test.verifyDb !== undefined}
                  onChange={(e) => patch(e.target.checked
                    ? { verifyDb: { query: 'SELECT * FROM users;', expectedColumns: [], expectedRows: [], checkColumnOrder: true, checkRowOrder: true } }
                    : { verifyDb: undefined })}
                  className="h-3.5 w-3.5 accent-primary"
                />
                ตรวจสถานะ DB หลังยิง API (เช่น POST แล้ว SELECT ตรวจว่าแถวเข้าจริง)
              </Label>
              {test.verifyDb !== undefined && (
              <span className="block">
                <textarea
                  value={test.verifyDb.query} rows={2}
                  onChange={(e) => patch({ verifyDb: { ...test.verifyDb!, query: e.target.value } })}
                  placeholder="SELECT id, name FROM users ORDER BY id;"
                  className="mt-0.5 w-full rounded-md border border-input bg-background px-1.5 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Input
                  value={test.verifyDb.expectedColumns.join(', ')}
                  onChange={(e) => patch({
                    verifyDb: {
                      ...test.verifyDb!,
                      expectedColumns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                    }
                  })}
                  placeholder="expected columns คั่นด้วย , (เช่น id, name)"
                  className="mt-1 font-mono text-xs"
                />
                <span className="mt-1 block text-[10px] text-muted-foreground">
                  แถวที่คาดหวัง (JSON array เช่น [[1,&quot;Ann&quot;]]) — ตรวจแบบเดียวกับข้อ SQL
                </span>
                <textarea
                  value={JSON.stringify(test.verifyDb.expectedRows)}
                  rows={2}
                  onChange={(e) => {
                    try {
                      const parsed = JSON.parse(e.target.value) as unknown
                      if (Array.isArray(parsed)) patch({ verifyDb: { ...test.verifyDb!, expectedRows: parsed as Array<Array<string | number | null>> } })
                    } catch {
                      /* JSON ยังไม่ครบ — รอครูพิมพ์ต่อ */
                    }
                  }}
                  className="mt-0.5 w-full rounded-md border border-input bg-background px-1.5 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </span>
              )}
            </CardContent>
          </Card>
        </div>
        )}
        {test.kind === 'dom-assertion' && (
        <Label className="mt-2 block text-[11px] text-muted-foreground">
          assertionScript
          <textarea value={test.assertionScript} rows={2} onChange={(e) => patch({ assertionScript: e.target.value })} className="mt-0.5 w-full rounded-md border border-input bg-background px-1.5 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </Label>
        )}
      </CardContent>
    </Card>
  )
}

import type { FormQuestion, AnswerKey, FormChoice } from '../../shared/form-schema'
import { isFormItemQuestion } from '../../shared/form-schema'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Badge } from '@renderer/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'

/* ============================================================
 * Phase 6 (6.2.2) — โหมดตั้งเฉลย + เกณฑ์คะแนนรายข้อ (Answer Key Editor)
 * ตามชนิดเฉลย 7 แบบ: exact_choice / multi_choice / short_text_match /
 * numeric_formula / grid_match / manual_rubric / ungraded
 * ============================================================ */

export interface AnswerKeyEditorProps {
  item: FormQuestion
  onChange(answerKey: AnswerKey): void
}

export function AnswerKeyEditor(props: AnswerKeyEditorProps): React.JSX.Element {
  const { item, onChange } = props
  if (!isFormItemQuestion(item)) {
    return <p className="text-sm text-muted-foreground">บล็อกคั่น/สื่อประกอบ ไม่มีเฉลย</p>
  }
  return (
    <div className="space-y-3 border-l-2 border-primary/60 pl-4">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline">โหมดเฉลยคำตอบและคะแนน</Badge>
        <Button
          type="button"
          variant={item.answerKey.gradingType === 'ungraded' ? 'default' : 'outline'}
          size="sm"
          onClick={() => onChange({ gradingType: 'ungraded' })}
        >
          ไม่คิดคะแนน (แบบสำรวจ)
        </Button>
      </div>
      <KeyBody item={item} onChange={onChange} />
    </div>
  )
}

function KeyBody(props: { item: FormQuestion; onChange(k: AnswerKey): void }): React.JSX.Element | null {
  const { item, onChange } = props
  switch (item.inputType) {
    case 'mcq_single':
    case 'dropdown': {
      const key =
        item.answerKey.gradingType === 'exact_choice'
          ? item.answerKey
          : ({ gradingType: 'exact_choice', correctChoiceId: item.choices[0]?.choiceId ?? 'c1' } as AnswerKey)
      if (key.gradingType !== 'exact_choice') return null
      const withWeights = key.choiceWeights !== undefined
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">คลิกเลือกตัวเลือกที่ถูก</p>
          {item.choices.map((choice) => (
            <Label key={choice.choiceId} className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <input
                type="radio"
                checked={key.gradingType === 'exact_choice' && key.correctChoiceId === choice.choiceId}
                onChange={() =>
                  onChange({ gradingType: 'exact_choice', correctChoiceId: choice.choiceId, ...(key.choiceWeights !== undefined ? { choiceWeights: key.choiceWeights } : {}) })
                }
              />
              <span className="text-sm">{choice.text}</span>
              {withWeights && (
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(((key.choiceWeights?.[choice.choiceId] ?? 0) * 100) as number)}
                  onChange={(e) => {
                    const weights: Record<string, number> = { ...(key.choiceWeights ?? {}) }
                    const pct = Number(e.target.value)
                    weights[choice.choiceId] = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 0
                    onChange({ ...key, choiceWeights: weights })
                  }}
                  className="ml-auto w-16 text-right font-mono tabular-nums"
                  aria-label={`น้ำหนัก ${choice.text}`}
                />
              )}
            </Label>
          ))}
          <Label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={withWeights}
              onChange={(e) =>
                e.target.checked
                  ? onChange({
                      gradingType: 'exact_choice',
                      correctChoiceId: key.gradingType === 'exact_choice' ? key.correctChoiceId : (item.choices[0]?.choiceId ?? 'c1'),
                      choiceWeights: buildUniformWeights(item.choices)
                    })
                  : onChange({
                      gradingType: 'exact_choice',
                      correctChoiceId: key.gradingType === 'exact_choice' ? key.correctChoiceId : (item.choices[0]?.choiceId ?? 'c1')
                    })
              }
            />
            ให้น้ำหนักคะแนนต่างกันตามตัวเลือก (% ของคะแนนข้อนี้)
          </Label>
        </div>
      )
    }
    case 'checkbox_multi': {
      const key =
        item.answerKey.gradingType === 'multi_choice'
          ? item.answerKey
          : ({ gradingType: 'multi_choice', correctChoiceIds: [], scoringMode: 'all-or-nothing' as const, penaltyPerWrongRatio: 0.5 } as AnswerKey)
      if (key.gradingType !== 'multi_choice') return null
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">ติ๊กทุกช่องที่ถูก</p>
          {item.choices.map((choice) => (
            <Label key={choice.choiceId} className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <input
                type="checkbox"
                checked={key.correctChoiceIds.includes(choice.choiceId)}
                onChange={(e) =>
                  onChange({
                    ...key,
                    correctChoiceIds: e.target.checked
                      ? [...key.correctChoiceIds, choice.choiceId]
                      : key.correctChoiceIds.filter((id) => id !== choice.choiceId)
                  })
                }
              />
              <span className="text-sm">{choice.text}</span>
            </Label>
          ))}
          <Label className="flex items-center gap-2 text-xs text-muted-foreground">
            โหมดให้คะแนน:
            <Select
              value={key.scoringMode}
              onValueChange={(v) => onChange({ ...key, scoringMode: v as 'all-or-nothing' | 'partial-with-penalty' })}
            >
              <SelectTrigger className="w-64 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all-or-nothing">ถูกทุกข้อจึงได้คะแนน (All-or-Nothing)</SelectItem>
                <SelectItem value="partial-with-penalty">ตามสัดส่วน หักข้อผิด (Partial + Penalty)</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          {key.scoringMode === 'partial-with-penalty' && (
            <Label className="flex items-center gap-2 text-xs text-muted-foreground">
              หักต่อข้อผิด:
              <Input
                type="number"
                step={0.1}
                min={0}
                max={1}
                value={key.penaltyPerWrongRatio}
                onChange={(e) => onChange({ ...key, penaltyPerWrongRatio: Math.max(0, Math.min(1, Number(e.target.value) || 0)) })}
                className="w-20 text-right font-mono tabular-nums"
              />
              × สัดส่วนข้อผิด
            </Label>
          )}
        </div>
      )
    }
    case 'short_text': {
      const key =
        item.answerKey.gradingType === 'short_text_match'
          ? item.answerKey
          : ({ gradingType: 'short_text_match', acceptedAnswers: [''], caseSensitive: false, trimWhitespace: true, useRegex: false } as AnswerKey)
      if (key.gradingType !== 'short_text_match') return null
      return (
        <div className="space-y-2">
          <Label className="block text-xs text-muted-foreground">
            คำตอบที่ยอมรับได้ (บรรทัดละ 1 คำตอบ{key.useRegex ? ' — บรรทัดแรกใช้เป็น Regex' : ''}):
            <textarea
              rows={3}
              value={key.acceptedAnswers.join('\n')}
              onChange={(e) =>
                onChange({ ...key, acceptedAnswers: e.target.value.split('\n').filter((line, idx) => idx === 0 || line.length > 0) })
              }
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </Label>
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <Label className="flex items-center gap-1.5">
              <input type="checkbox" checked={key.trimWhitespace} onChange={(e) => onChange({ ...key, trimWhitespace: e.target.checked })} />
              ตัดช่องว่างหัวท้าย
            </Label>
            <Label className="flex items-center gap-1.5">
              <input type="checkbox" checked={key.caseSensitive} onChange={(e) => onChange({ ...key, caseSensitive: e.target.checked })} />
              เทียบพิจารณาตัวพิมพ์
            </Label>
            <Label className="flex items-center gap-1.5">
              <input type="checkbox" checked={key.useRegex} onChange={(e) => onChange({ ...key, useRegex: e.target.checked })} />
              ตรวจด้วย Regex
            </Label>
          </div>
        </div>
      )
    }
    case 'numeric_param': {
      const key =
        item.answerKey.gradingType === 'numeric_formula'
          ? item.answerKey
          : ({ gradingType: 'numeric_formula', formulaOrValue: '', tolerance: 0.01 } as AnswerKey)
      if (key.gradingType !== 'numeric_formula') return null
      const varNames = Object.keys(item.parameters ?? {})
      return (
        <div className="space-y-2">
          <Label className="block text-xs text-muted-foreground">
            สูตรเฉลย (ใช้ตัวเลขหรือตัวแปร {varNames.length > 0 ? varNames.map((v) => `{{${v}}}`).join(' ') : 'เช่น 25.5'}):
            <Input
              value={key.formulaOrValue}
              onChange={(e) => onChange({ ...key, formulaOrValue: e.target.value })}
              placeholder={varNames.length > 0 ? 'a * b + 10' : '25.5'}
              className="mt-1 font-mono"
            />
          </Label>
          {varNames.length === 0 && (
            <TestFormulaHint formulaOrValue={key.formulaOrValue} />
          )}
          <Label className="flex items-center gap-2 text-xs text-muted-foreground">
            ยอมรับคลาดเคลื่อน ±
            <Input
              type="number"
              min={0}
              step={0.001}
              value={key.tolerance}
              onChange={(e) => onChange({ ...key, tolerance: Math.max(0, Number(e.target.value) || 0) })}
              className="w-20 text-right font-mono tabular-nums"
            />
          </Label>
        </div>
      )
    }
    case 'mcq_grid':
    case 'checkbox_grid': {
      const key = item.answerKey.gradingType === 'grid_match' ? item.answerKey : null
      if (key === null) {
        return (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">ยังไม่ได้ตั้งเฉลยรายแถว</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                onChange({
                  gradingType: 'grid_match',
                  rowAnswerMap: {},
                  pointsPerRow: item.points / Math.max(1, item.rows.length)
                })
              }
            >
              เริ่มตั้งเฉลยรายแถว
            </Button>
          </div>
        )
      }
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">เลือกคำตอบของแต่ละแถว (คะแนนแบ่งเท่า ๆ กันจากคะแนนข้อนี้)</p>
          {item.rows.map((row) => (
            <div key={row.rowId} className="rounded-md border bg-muted/40 px-3 py-2">
              <div className="text-xs">{row.label}</div>
              {item.inputType === 'mcq_grid' ? (
                <Select
                  value={(key.rowAnswerMap[row.rowId] as string | undefined) ?? ''}
                  onValueChange={(v) =>
                    onChange({
                      ...key,
                      rowAnswerMap: { ...key.rowAnswerMap, [row.rowId]: v }
                    })
                  }
                >
                  <SelectTrigger className="mt-1 w-56 text-xs"><SelectValue placeholder="— เฉลยแถวนี้ —" /></SelectTrigger>
                  <SelectContent>
                    {item.columns.map((col) => (
                      <SelectItem key={col.columnId} value={col.columnId}>{col.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="mt-1 flex flex-wrap gap-2 text-xs">
                  {item.columns.map((col) => {
                    const expected = key.rowAnswerMap[row.rowId]
                    const expectedList = Array.isArray(expected) ? expected : undefined
                    const checked = expectedList?.includes(col.columnId) ?? false
                    return (
                      <Label key={col.columnId} className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const current = expectedList ?? []
                            const next = e.target.checked ? [...current, col.columnId] : current.filter((c) => c !== col.columnId)
                            onChange({ ...key, rowAnswerMap: { ...key.rowAnswerMap, [row.rowId]: next } })
                          }}
                        />
                        {col.label}
                      </Label>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )
    }
    case 'linear_scale': {
      const key = item.answerKey.gradingType === 'numeric_formula' ? item.answerKey : null
      const scaleValues: number[] = []
      for (let v = item.scaleMin; v <= item.scaleMax; v++) scaleValues.push(v)
      if (key === null) {
        return (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">เลือกคำตอบที่ถูก หรือตั้งเป็นข้อไม่คิดคะแนน</p>
            <div className="flex flex-wrap gap-1.5">
              {scaleValues.map((v) => (
                <Button
                  key={v}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onChange({ gradingType: 'numeric_formula', formulaOrValue: String(v), tolerance: 0 })}
                >
                  {v}
                </Button>
              ))}
            </div>
          </div>
        )
      }
      return <p className="text-xs text-primary">เฉลย: {key.formulaOrValue}</p>
    }
    case 'date_time': {
      const key = item.answerKey.gradingType === 'short_text_match' ? item.answerKey : null
      const inputType = item.mode === 'date' ? 'date' : item.mode === 'time' ? 'time' : 'datetime-local'
      const current = key?.acceptedAnswers[0]?.replace(' ', 'T') ?? ''
      return (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">เฉลย (ตรงตามค่าที่เปิดดู):</p>
          <Input
            type={inputType}
            value={current}
            onChange={(e) =>
              onChange({
                gradingType: 'short_text_match',
                acceptedAnswers: [e.target.value.replace('T', ' ')],
                caseSensitive: false,
                trimWhitespace: true,
                useRegex: false
              })
            }
            className="w-56 text-sm"
          />
        </div>
      )
    }
    case 'long_text':
    case 'code_snippet':
    case 'file_upload': {
      const key = item.answerKey.gradingType === 'manual_rubric' ? item.answerKey : null
      if (key === null) {
        return (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">ข้อนี้ใช้เกณฑ์คัดคะแนนของครู (ตรวจให้คะแนนเอง) หรือแจ้งคำตอบตั้งชื่อ</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange({ gradingType: 'manual_rubric' })}
            >
              ตั้งเกณฑ์ให้คะแนนของครู
            </Button>
          </div>
        )
      }
      return (
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-xs text-muted-foreground">
            คีย์เวิร์ดช่วยคัดความ (คั่นด้วย comma):
            <Input
              value={(key.expectedKeywords ?? []).join(', ')}
              onChange={(e) =>
                onChange({
                  ...key,
                  expectedKeywords: e.target.value.split(',').map((k) => k.trim()).filter((k) => k.length > 0).slice(0, 50)
                })
              }
              className="flex-1 text-xs"
            />
          </Label>
          {(key.rubricCriteria ?? []).map((c, idx) => (
            <div key={c.criterionId} className="flex items-center gap-2">
              <Input
                value={c.title}
                placeholder={`เกณฑ์ที่ ${idx + 1}`}
                onChange={(e) => {
                  const next = [...(key.rubricCriteria ?? [])]
                  next[idx] = { ...c, title: e.target.value }
                  onChange({ ...key, rubricCriteria: next })
                }}
                className="flex-1 text-xs"
              />
              <Input
                type="number"
                min={0.1}
                value={c.maxPoints}
                onChange={(e) => {
                  const next = [...(key.rubricCriteria ?? [])]
                  next[idx] = { ...c, maxPoints: Math.max(0.1, Number(e.target.value) || 0.1) }
                  onChange({ ...key, rubricCriteria: next })
                }}
                className="w-20 text-right font-mono tabular-nums"
                aria-label="คะแนนเต็มเกณฑ์"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange({ ...key, rubricCriteria: (key.rubricCriteria ?? []).filter((x) => x.criterionId !== c.criterionId) })}
                className="text-destructive"
              >
                ลบ
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange({
                ...key,
                rubricCriteria: [...(key.rubricCriteria ?? []), { criterionId: `rub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title: '', maxPoints: 1 }]
              })
            }
          >
            + เพิ่มเกณฑ์
          </Button>
          <Label className="block text-xs text-muted-foreground">
            แผ่นอ้างอิงเฉลยสำหรับครู:
            <textarea
              rows={2}
              value={key.teacherReferenceNote ?? ''}
              onChange={(e) => onChange({ ...key, teacherReferenceNote: e.target.value })}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </Label>
        </div>
      )
    }
  }
}

function buildUniformWeights(choices: FormChoice[]): Record<string, number> {
  const weights: Record<string, number> = {}
  const each = Math.round((100 / choices.length)) / 100
  for (const c of choices) weights[c.choiceId] = each
  return weights
}

function TestFormulaHint(props: { formulaOrValue: string }): React.JSX.Element | null {
  return props.formulaOrValue.length > 0 ? null : (
    <p className="text-[11px] text-muted-foreground">ตัวอย่างสูตร: "(a * b) / 2", "a ^ 2 + 10", "25.5"</p>
  )
}

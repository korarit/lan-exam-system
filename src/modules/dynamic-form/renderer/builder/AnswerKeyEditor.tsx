import type { FormQuestion, AnswerKey, FormChoice } from '../../shared/form-schema'
import { isFormItemQuestion } from '../../shared/form-schema'

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
    return <p className="text-sm text-slate-500">บล็อกคั่น/สื่อประกอบ ไม่มีเฉลย</p>
  }
  return (
    <div className="space-y-3 border-l-2 border-amber-500/60 pl-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-amber-300">🔑 โหมดเฉลยคำตอบและคะแนน</span>
        <button
          type="button"
          onClick={() => onChange({ gradingType: 'ungraded' })}
          className={`rounded-lg border px-2.5 py-1 text-xs transition ${
            item.answerKey.gradingType === 'ungraded'
              ? 'border-emerald-700/60 bg-emerald-950/60 text-emerald-300'
              : 'border-slate-700 text-slate-400 hover:bg-slate-800'
          }`}
        >
          ไม่คิดคะแนน (แบบสำรวจ)
        </button>
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
          <p className="text-xs text-slate-500">คลิกเลือกตัวเลือกที่ถูก</p>
          {item.choices.map((choice) => (
            <label key={choice.choiceId} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
              <input
                type="radio"
                checked={key.gradingType === 'exact_choice' && key.correctChoiceId === choice.choiceId}
                onChange={() =>
                  onChange({ gradingType: 'exact_choice', correctChoiceId: choice.choiceId, ...(key.choiceWeights !== undefined ? { choiceWeights: key.choiceWeights } : {}) })
                }
              />
              <span className="text-sm text-slate-200">{choice.text}</span>
              {withWeights && (
                <input
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
                  className="ml-auto w-16 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-right text-xs font-mono"
                />
              )}
            </label>
          ))}
          <label className="flex items-center gap-2 text-xs text-slate-400">
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
          </label>
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
          <p className="text-xs text-slate-500">ติ๊กทุกช่องที่ถูก</p>
          {item.choices.map((choice) => (
            <label key={choice.choiceId} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
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
              <span className="text-sm text-slate-200">{choice.text}</span>
            </label>
          ))}
          <label className="flex items-center gap-2 text-xs text-slate-400">
            โหมดให้คะแนน:
            <select
              value={key.scoringMode}
              onChange={(e) => onChange({ ...key, scoringMode: e.target.value as 'all-or-nothing' | 'partial-with-penalty' })}
              className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
            >
              <option value="all-or-nothing">ถูกทุกข้อจึงได้คะแนน (All-or-Nothing)</option>
              <option value="partial-with-penalty">ตามสัดส่วน หักข้อผิด (Partial + Penalty)</option>
            </select>
          </label>
          {key.scoringMode === 'partial-with-penalty' && (
            <label className="flex items-center gap-2 text-xs text-slate-400">
              หักต่อข้อผิด:
              <input
                type="number"
                step={0.1}
                min={0}
                max={1}
                value={key.penaltyPerWrongRatio}
                onChange={(e) => onChange({ ...key, penaltyPerWrongRatio: Math.max(0, Math.min(1, Number(e.target.value) || 0)) })}
                className="w-20 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-right font-mono"
              />
              × สัดส่วนข้อผิด
            </label>
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
          <label className="block text-xs text-slate-500">
            คำตอบที่ยอมรับได้ (บรรทัดละ 1 คำตอบ{key.useRegex ? ' — บรรทัดแรกใช้เป็น Regex' : ''}):
            <textarea
              rows={3}
              value={key.acceptedAnswers.join('\n')}
              onChange={(e) =>
                onChange({ ...key, acceptedAnswers: e.target.value.split('\n').filter((line, idx) => idx === 0 || line.length > 0) })
              }
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />
          </label>
          <div className="flex flex-wrap gap-4 text-xs text-slate-400">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={key.trimWhitespace} onChange={(e) => onChange({ ...key, trimWhitespace: e.target.checked })} />
              ตัดช่องว่างหัวท้าย
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={key.caseSensitive} onChange={(e) => onChange({ ...key, caseSensitive: e.target.checked })} />
              เทียบพิจารณาตัวพิมพ์
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={key.useRegex} onChange={(e) => onChange({ ...key, useRegex: e.target.checked })} />
              ตรวจด้วย Regex
            </label>
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
          <label className="block text-xs text-slate-500">
            สูตรเฉลย (ใช้ตัวเลขหรือตัวแปร {varNames.length > 0 ? varNames.map((v) => `{{${v}}}`).join(' ') : 'เช่น 25.5'}):
            <input
              value={key.formulaOrValue}
              onChange={(e) => onChange({ ...key, formulaOrValue: e.target.value })}
              placeholder={varNames.length > 0 ? 'a * b + 10' : '25.5'}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm"
            />
          </label>
          {varNames.length === 0 && (
            <TestFormulaHint formulaOrValue={key.formulaOrValue} />
          )}
          <label className="flex items-center gap-2 text-xs text-slate-400">
            ยอมรับคลาดเคลื่อน ±
            <input
              type="number"
              min={0}
              step={0.001}
              value={key.tolerance}
              onChange={(e) => onChange({ ...key, tolerance: Math.max(0, Number(e.target.value) || 0) })}
              className="w-20 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-right font-mono"
            />
          </label>
        </div>
      )
    }
    case 'mcq_grid':
    case 'checkbox_grid': {
      const key = item.answerKey.gradingType === 'grid_match' ? item.answerKey : null
      if (key === null) {
        return (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">ยังไม่ได้ตั้งเฉลยรายแถว</p>
            <button
              type="button"
              onClick={() =>
                onChange({
                  gradingType: 'grid_match',
                  rowAnswerMap: {},
                  pointsPerRow: item.points / Math.max(1, item.rows.length)
                })
              }
              className="rounded-lg border border-amber-700/60 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-950/40"
            >
              เริ่มตั้งเฉลยรายแถว
            </button>
          </div>
        )
      }
      return (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">เลือกคำตอบของแต่ละแถว (คะแนนแบ่งเท่า ๆ กันจากคะแนนข้อนี้)</p>
          {item.rows.map((row) => (
            <div key={row.rowId} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
              <div className="text-xs text-slate-300">{row.label}</div>
              {item.inputType === 'mcq_grid' ? (
                <select
                  value={(key.rowAnswerMap[row.rowId] as string | undefined) ?? ''}
                  onChange={(e) =>
                    onChange({
                      ...key,
                      rowAnswerMap: { ...key.rowAnswerMap, [row.rowId]: e.target.value }
                    })
                  }
                  className="mt-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                >
                  <option value="">— เฉลยแถวนี้ —</option>
                  {item.columns.map((col) => (
                    <option key={col.columnId} value={col.columnId}>
                      {col.label}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="mt-1 flex flex-wrap gap-2 text-xs">
                  {item.columns.map((col) => {
                    const expected = key.rowAnswerMap[row.rowId]
                    const expectedList = Array.isArray(expected) ? expected : undefined
                    const checked = expectedList?.includes(col.columnId) ?? false
                    return (
                      <label key={col.columnId} className="flex items-center gap-1">
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
                      </label>
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
            <p className="text-xs text-slate-500">เลือกคำตอบที่ถูก หรือตั้งเป็นข้อไม่คิดคะแนน</p>
            <div className="flex flex-wrap gap-1.5">
              {scaleValues.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => onChange({ gradingType: 'numeric_formula', formulaOrValue: String(v), tolerance: 0 })}
                  className="h-8 w-8 rounded-lg border border-slate-700 text-xs hover:border-sky-600"
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        )
      }
      return <p className="text-xs text-emerald-300">เฉลย: {key.formulaOrValue}</p>
    }
    case 'date_time': {
      const key = item.answerKey.gradingType === 'short_text_match' ? item.answerKey : null
      const inputType = item.mode === 'date' ? 'date' : item.mode === 'time' ? 'time' : 'datetime-local'
      const current = key?.acceptedAnswers[0]?.replace(' ', 'T') ?? ''
      return (
        <div className="space-y-1.5">
          <p className="text-xs text-slate-500">เฉลย (ตรงตามค่าที่เปิดดู):</p>
          <input
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
            className="w-56 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
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
            <p className="text-xs text-slate-500">ข้อนี้ใช้เกณฑ์คัดคะแนนของครู (ตรวจให้คะแนนเอง) หรือแจ้งคำตอบตั้งชื่อ</p>
            <button
              type="button"
              onClick={() => onChange({ gradingType: 'manual_rubric' })}
              className="rounded-lg border border-amber-700/60 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-950/40"
            >
              ตั้งเกณฑ์ให้คะแนนของครู
            </button>
          </div>
        )
      }
      return (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            คีย์เวิร์ดช่วยคัดความ (คั่นด้วย comma):
            <input
              value={(key.expectedKeywords ?? []).join(', ')}
              onChange={(e) =>
                onChange({
                  ...key,
                  expectedKeywords: e.target.value.split(',').map((k) => k.trim()).filter((k) => k.length > 0).slice(0, 50)
                })
              }
              className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
            />
          </label>
          {(key.rubricCriteria ?? []).map((c, idx) => (
            <div key={c.criterionId} className="flex items-center gap-2">
              <input
                value={c.title}
                placeholder={`เกณฑ์ที่ ${idx + 1}`}
                onChange={(e) => {
                  const next = [...(key.rubricCriteria ?? [])]
                  next[idx] = { ...c, title: e.target.value }
                  onChange({ ...key, rubricCriteria: next })
                }}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
              />
              <input
                type="number"
                min={0.1}
                value={c.maxPoints}
                onChange={(e) => {
                  const next = [...(key.rubricCriteria ?? [])]
                  next[idx] = { ...c, maxPoints: Math.max(0.1, Number(e.target.value) || 0.1) }
                  onChange({ ...key, rubricCriteria: next })
                }}
                className="w-20 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-right font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => onChange({ ...key, rubricCriteria: (key.rubricCriteria ?? []).filter((x) => x.criterionId !== c.criterionId) })}
                className="text-xs text-red-300 hover:text-red-200"
              >
                ลบ
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              onChange({
                ...key,
                rubricCriteria: [...(key.rubricCriteria ?? []), { criterionId: `rub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title: '', maxPoints: 1 }]
              })
            }
            className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            + เพิ่มเกณฑ์
          </button>
          <label className="block text-xs text-slate-400">
            แผ่นอ้างอิงเฉลยสำหรับครู:
            <textarea
              rows={2}
              value={key.teacherReferenceNote ?? ''}
              onChange={(e) => onChange({ ...key, teacherReferenceNote: e.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />
          </label>
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
    <p className="text-[11px] text-slate-600">ตัวอย่างสูตร: "(a * b) / 2", "a ^ 2 + 10", "25.5"</p>
  )
}

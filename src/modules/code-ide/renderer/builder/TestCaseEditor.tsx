import { CLI_INPUT_TYPES, typedInputsToStdin, type CliTypedInput, type CodeTestCase } from '../../shared/code-schema'

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
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{test.kind} #{index + 1}</span>
        <input
          value={test.title}
          onChange={(e) => patch({ title: e.target.value })}
          placeholder="ชื่อ test เช่น บวกเลข 2 จำนวน"
          className="min-w-40 flex-1 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs"
        />
        <label className="flex items-center gap-1 text-[11px] text-slate-400">
          <input
            type="number" value={test.points} min={1}
            onChange={(e) => patch({ points: Math.max(1, Number(e.target.value) || 1) })}
            className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-xs"
          /> คะแนน
        </label>
        <select
          value={test.visibility}
          onChange={(e) => patch({ visibility: e.target.value as 'sample' | 'hidden' })}
          className="rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-[11px]"
        >
          <option value="sample">sample (นักเรียนเห็น input/output)</option>
          <option value="hidden">hidden (ตรวจลับ)</option>
        </select>
        <button type="button" onClick={onDelete} className="rounded px-1.5 py-1 text-slate-500 hover:text-red-300">🗑</button>
      </div>

      {(test.kind === 'stdio' || test.kind === 'unit-harness') && (
        <div className="mt-2 space-y-2">
          {test.kind === 'unit-harness' && (
            <label className="block text-[11px] text-slate-400">
              Harness target (เช่น tests/test_main.py::test_sum)
              <input
                value={test.harnessTarget ?? ''}
                onChange={(e) => patch({ harnessTarget: e.target.value })}
                className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-xs"
              />
            </label>
          )}

          {/* --- Typed inputs (LeetCode-style) --- */}
          <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-medium text-slate-300">⌨️ Inputs (กำหนดทีละตัว + บอก type)</span>
              <button
                type="button"
                onClick={() => patch({ inputs: [...(test.inputs ?? []), newInput((test.inputs ?? []).length + 1)] })}
                className="ml-auto rounded border border-slate-700 px-2 py-0.5 text-[11px] text-sky-300 hover:border-sky-500"
              >
                + เพิ่ม input
              </button>
            </div>
            {(test.inputs ?? []).length === 0 && (
              <p className="text-[11px] text-slate-600">ยังไม่มี input แบบระบุ type — กด “+ เพิ่ม input” หรือพิมพ์ stdin ตรง ๆ ด้านล่างก็ได้ (ตั้งโจทย์เฉย ๆ ไม่มีตรวจก็ได้)</p>
            )}
            {(test.inputs ?? []).map((inp, ii) => (
              <div key={ii} className="mb-1.5 grid grid-cols-[1fr_110px_1fr_auto] items-center gap-1.5">
                <input
                  value={inp.name}
                  onChange={(e) => patch({ inputs: (test.inputs ?? []).map((x, xi) => (xi === ii ? { ...x, name: e.target.value } : x)) })}
                  placeholder="ชื่อ เช่น x"
                  className="rounded border border-slate-700 bg-slate-900 px-1.5 py-1 font-mono text-xs"
                />
                <select
                  value={inp.type}
                  onChange={(e) => patch({ inputs: (test.inputs ?? []).map((x, xi) => (xi === ii ? { ...x, type: e.target.value as CliTypedInput['type'] } : x)) })}
                  className="rounded border border-slate-700 bg-slate-900 px-1 py-1 font-mono text-xs"
                >
                  {CLI_INPUT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <input
                  value={inp.value}
                  onChange={(e) => patch({ inputs: (test.inputs ?? []).map((x, xi) => (xi === ii ? { ...x, value: e.target.value } : x)) })}
                  placeholder={inp.type === 'string' ? 'ค่า เช่น hello' : inp.type === 'int' ? 'ค่า เช่น 5' : inp.type === 'float' ? 'ค่า เช่น 3.14' : 'true / false'}
                  className="rounded border border-slate-700 bg-slate-900 px-1.5 py-1 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => patch({ inputs: (test.inputs ?? []).filter((_, xi) => xi !== ii) })}
                  className="text-slate-500 hover:text-red-300"
                >✕</button>
              </div>
            ))}
            {(test.inputs ?? []).length > 0 && (
              <div className="mt-1 rounded bg-slate-900 p-1.5 font-mono text-[11px]">
                <span className="text-slate-500">stdin ที่จะส่งให้โปรแกรม (auto):</span>
                <pre className="whitespace-pre-wrap text-emerald-300">{typedInputsToStdin(test.inputs ?? []) || '(ยังไม่มีค่า)'}</pre>
                <button
                  type="button"
                  onClick={() => patch({ stdin: typedInputsToStdin(test.inputs ?? []) })}
                  className="mt-1 rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700"
                >คัดลอกไปใส่ช่อง stdin ด้านล่าง</button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label className="block text-[11px] text-slate-400">
              stdin (ส่งให้โปรแกรมนักเรียน)
              <textarea
                value={test.stdin} rows={3}
                onChange={(e) => patch({ stdin: e.target.value })}
                placeholder={'เช่น\n5\n10'}
                className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-xs"
              />
            </label>
            <label className="block text-[11px] text-slate-400">
              expected output (คำตอบที่ถือว่าผ่าน)
              <textarea
                value={test.expectedStdout} rows={3}
                onChange={(e) => patch({ expectedStdout: e.target.value })}
                placeholder="เช่น 15"
                className="mt-0.5 w-full rounded border border-emerald-900/60 bg-slate-950 px-1.5 py-1 font-mono text-xs"
              />
            </label>
          </div>
          <p className="text-[10px] text-slate-600">ว่างได้ทั้งสองช่อง = ตั้งโจทย์เฉย ๆ ไม่ตรวจอัตโนมัติ · ใส่ expected ไว้ = ระบบช่วยตรวจให้ (ผ่านเมื่อ output ตรง)</p>
        </div>
      )}

      {test.kind === 'sql-query' && (
        <div className="mt-2 grid grid-cols-1 gap-2">
          <label className="block text-[11px] text-slate-400">
            expected columns (คั่นด้วย ,)
            <input
              value={test.expectedColumns.join(', ')}
              onChange={(e) => patch({ expectedColumns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-xs"
            />
          </label>
          <label className="block text-[11px] text-slate-400">
            verificationQuery (ถ้าโจทย์เป็น INSERT/UPDATE/DELETE — ใช้ SELECT ตรวจ)
            <textarea value={test.verificationQuery ?? ''} rows={2} onChange={(e) => patch({ verificationQuery: e.target.value })} className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-xs" />
          </label>
        </div>
      )}

      {test.kind === 'http-api' && (
        <p className="mt-2 text-[11px] text-slate-500">API requests แบบละเอียดแก้ไขใน Phase 10 grader — ตอนนี้เก็บ path/matcher พื้นฐาน ({test.requests.length} requests)</p>
      )}
      {test.kind === 'dom-assertion' && (
        <label className="mt-2 block text-[11px] text-slate-400">
          assertionScript
          <textarea value={test.assertionScript} rows={2} onChange={(e) => patch({ assertionScript: e.target.value })} className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-xs" />
        </label>
      )}
    </div>
  )
}

import { create } from 'zustand'
import { z } from 'zod'
import {
  FormItemSchema,
  type DynamicFormDefinition,
  type FormAssetMap,
  type FormItem,
  type FormQuestion,
  type FormSettings,
  type AnswerKey,
  AnswerKeySchema,
  FormChoiceSchema,
  GridRowSchema,
  GridColumnSchema
} from '../../shared/form-schema'

/* ============================================================
 * Phase 6 (6.2) — Zustand store ของหน้าสร้างฟอร์ม (Google-Forms style)
 * รวมคลัง Asset แบบ Content-Addressed (sha256 -> {mimeType, dataBase64})
 * ============================================================ */

const emptyForm: DynamicFormDefinition = {
  moduleId: 'dynamic-form',
  formId: z.uuid().parse(crypto.randomUUID()),
  title: 'ชุดข้อสอบใหม่',
  instructions: '',
  settings: {
    durationMinutes: 30,
    shuffleQuestionsPerStudent: false,
    navigationPolicy: 'strict-one-way',
    showScoreImmediatelyAfterSubmit: false
  },
  items: []
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function defaultKey(): AnswerKey {
  return { gradingType: 'ungraded' }
}

export function createDefaultFormItem(inputType: FormItem['inputType']): FormItem {
  const itemId = newId('it')
  const base = { itemId, prompt: '', points: 1, shuffleChoices: false, validation: { required: true } }
  switch (inputType) {
    case 'mcq_single':
    case 'checkbox_multi':
    case 'dropdown':
      return {
        ...base,
        inputType,
        choices: [1, 2, 3].map((n) => FormChoiceSchema.parse({ choiceId: `c${n}`, text: `ตัวเลือก ${n}` })),
        answerKey: defaultKey()
      } as FormItem
    case 'short_text':
    case 'long_text':
      return { ...base, inputType, answerKey: defaultKey() } as FormItem
    case 'numeric_param':
      return { ...base, inputType, unit: '', answerKey: defaultKey() } as FormItem
    case 'mcq_grid':
    case 'checkbox_grid':
      return {
        ...base,
        inputType,
        rows: [
          GridRowSchema.parse({ rowId: 'r1', label: 'แถว 1' }),
          GridRowSchema.parse({ rowId: 'r2', label: 'แถว 2' })
        ],
        columns: [
          GridColumnSchema.parse({ columnId: 'c1', label: 'หัวข้อ 1' }),
          GridColumnSchema.parse({ columnId: 'c2', label: 'หัวข้อ 2' })
        ],
        answerKey: defaultKey()
      } as FormItem
    case 'linear_scale':
      return {
        ...base,
        inputType,
        scaleMin: 1,
        scaleMax: 5,
        answerKey: defaultKey()
      } as FormItem
    case 'date_time':
      return { ...base, inputType, mode: 'date' as const, answerKey: defaultKey() } as FormItem
    case 'code_snippet':
      return {
        ...base,
        inputType,
        language: 'python' as const,
        starterCode: '',
        answerKey: defaultKey()
      } as FormItem
    case 'file_upload':
      return {
        ...base,
        inputType,
        acceptMultiple: false,
        answerKey: defaultKey()
      } as FormItem
    case 'section_header':
      return { inputType, itemId, title: 'ส่วนใหม่', description: '' }
    case 'media_stimulus':
      return { inputType, itemId, imageAssetId: 'PLACEHOLDER', caption: '' }
  }
}

interface FormBuilderState {
  form: DynamicFormDefinition
  assets: FormAssetMap
  expandedItemId: string | null
  setTitle(title: string): void
  setInstructions(instructions: string): void
  patchSettings(patch: Partial<FormSettings>): void
  addItem(inputType: FormItem['inputType']): void
  addItems(items: FormItem[]): void
  updateItem(itemId: string, updater: (item: FormItem) => FormItem): void
  removeItem(itemId: string): void
  duplicateItem(itemId: string): void
  moveItem(itemId: string, direction: 'up' | 'down'): void
  setExpandedItem(itemId: string | null): void
  putAsset(assetId: string, mimeType: string, dataBase64: string): void
  removeAsset(assetId: string): void
  loadFromPayload(form: DynamicFormDefinition, assets: FormAssetMap): void
  resetForm(): void
}

export const useFormBuilderStore = create<FormBuilderState>((set) => ({
  form: emptyForm,
  assets: {},
  expandedItemId: null,
  setTitle: (title) => set((s) => ({ form: { ...s.form, title } })),
  setInstructions: (instructions) => set((s) => ({ form: { ...s.form, instructions } })),
  patchSettings: (patch) => set((s) => ({ form: { ...s.form, settings: { ...s.form.settings, ...patch } } })),
  addItem: (inputType) =>
    set((s) => {
      const item = createDefaultFormItem(inputType)
      return {
        form: { ...s.form, items: [...s.form.items, item] },
        expandedItemId: item.itemId
      }
    }),
  addItems: (items) =>
    set((s) => ({
      form: { ...s.form, items: [...s.form.items, ...items].slice(0, 200) }
    })),
  updateItem: (itemId, updater) =>
    set((s) => ({
      form: {
        ...s.form,
        items: s.form.items.map((item) => (item.itemId === itemId ? updater(item) : item))
      }
    })),
  removeItem: (itemId) =>
    set((s) => ({
      form: { ...s.form, items: s.form.items.filter((item) => item.itemId !== itemId) }
    })),
  duplicateItem: (itemId) =>
    set((s) => {
      const idx = s.form.items.findIndex((i) => i.itemId === itemId)
      if (idx < 0) return s
      const items = [...s.form.items]
      const SourceSchema = FormItemSchema
      const original = items[idx]
      if (original === undefined) return s
      let copy: FormItem
      try {
        copy = SourceSchema.parse(cloneWithNewIds(stripToPlain(original))) as FormItem
      } catch {
        return s
      }
      items.splice(idx + 1, 0, copy)
      return { form: { ...s.form, items } }
    }),
  moveItem: (itemId, direction) =>
    set((s) => {
      const idx = s.form.items.findIndex((i) => i.itemId === itemId)
      const target = direction === 'up' ? idx - 1 : idx + 1
      if (idx < 0 || target < 0 || target >= s.form.items.length) return s
      const items = [...s.form.items]
      const tmp = items[idx]
      const other = items[target]
      if (tmp === undefined || other === undefined) return s
      items[idx] = other
      items[target] = tmp
      return { form: { ...s.form, items } }
    }),
  setExpandedItem: (expandedItemId) => set({ expandedItemId }),
  putAsset: (assetId, mimeType, dataBase64) =>
    set((s) => ({ assets: { ...s.assets, [assetId]: { mimeType, dataBase64 } } })),
  removeAsset: (assetId) =>
    set((s) => {
      const { [assetId]: _removed, ...rest } = s.assets
      return { assets: rest }
    }),
  loadFromPayload: (form, assets) =>
    set({ form, assets, expandedItemId: null }),
  resetForm: () => set({ form: { ...emptyForm, formId: z.uuid().parse(crypto.randomUUID()) }, assets: {}, expandedItemId: null })
}))

/** deep clone ที่เปลี่ยน id ภายใน (itemId/choiceId/rowId/columnId/criterionId) ให้ไม่ซ้ำ */
function cloneWithNewIds(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneWithNewIds)
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'itemId' || key === 'choiceId' || key === 'rowId' || key === 'columnId' || key === 'criterionId') && typeof v === 'string') {
      out[key] = `${v}-x${Math.random().toString(36).slice(2, 6)}`
    } else if (
      key === 'correctChoiceId' ||
      key === 'correctChoiceIds' ||
      key === 'rowAnswerMap' ||
      key === 'choiceWeights'
    ) {
      // สัญญาเฉลยอ้าง id เดิม — ตัวสำเนาให้กลับไปเป็น ungraded ให้ครูตั้งใหม่ปลอดภัยกว่า
      if (key === 'correctChoiceIds' && Array.isArray(v)) {
        out[key] = []
      } else if (key !== 'rowAnswerMap' && key !== 'choiceWeights') {
        out[key] = ''
      }
    } else {
      out[key] = cloneWithNewIds(v)
    }
  }
  if ('answerKey' in out) {
    out['answerKey'] = { gradingType: 'ungraded' }
  }
  return out
}

function stripToPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

/** ตรวจฟอร์มทั้งชุดทุกข้อด้วย Zod ก่อน save (คืนรายการจุดผิด) */
export function collectFormIssues(form: DynamicFormDefinition): string[] {
  const issues: string[] = []
  const idSet = new Set<string>()
  for (const item of form.items) {
    const checkItem = FormItemSchema.safeParse(item)
    if (!checkItem.success) {
      issues.push(`ข้อ ${item.itemId}: ${checkItem.error.issues[0]?.message ?? 'โครงไม่ถูกต้อง'}`)
      continue
    }
    if (idSet.has(item.itemId)) issues.push(`duplicate itemId: ${item.itemId}`)
    idSet.add(item.itemId)
    if (item.inputType !== 'section_header' && item.inputType !== 'media_stimulus') {
      const keyCheck = AnswerKeySchema.safeParse(item.answerKey)
      if (!keyCheck.success) {
        issues.push(`เฉลยของข้อ ${item.itemId} ไม่ถูกต้อง`)
      }
    }
  }
  return issues
}

/** helper รวม: ลิสต์ข้อสอบเท่านั้น */
export function listQuestions(items: FormItem[]): FormQuestion[] {
  return items.filter((i): i is FormQuestion => i.inputType !== 'section_header' && i.inputType !== 'media_stimulus')
}

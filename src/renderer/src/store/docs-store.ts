import { create } from 'zustand'
import type { DocsPanelState } from '@shared/ipc-channels'

/* Phase 5: สถานะแผงเอกสารที่ main push ผ่าน 'exam:docs-state' */

interface DocsState {
  docs: DocsPanelState | null
  setDocs: (state: DocsPanelState) => void
  reset: () => void
}

export const useDocsStore = create<DocsState>((set) => ({
  docs: null,
  setDocs: (docs) => set({ docs }),
  reset: () => set({ docs: null })
}))

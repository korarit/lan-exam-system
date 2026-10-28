import { create } from 'zustand'
import type { TriageOverviewEvent } from '@shared/ipc-channels'

export type TriageFilter = 'all' | 'critical' | 'warning' | 'disconnected' | 'normal'

export interface TriageUiState {
  overview: TriageOverviewEvent | null
  filter: TriageFilter
  search: string
  selectedStudentId: string | null
  muted: boolean
  setOverview: (overview: TriageOverviewEvent) => void
  setFilter: (filter: TriageFilter) => void
  setSearch: (search: string) => void
  setSelectedStudentId: (studentId: string | null) => void
  setMuted: (muted: boolean) => void
}

export const useTriageStore = create<TriageUiState>((set) => ({
  overview: null,
  filter: 'all',
  search: '',
  selectedStudentId: null,
  muted: false,
  setOverview: (overview) => set({ overview }),
  setFilter: (filter) => set({ filter }),
  setSearch: (search) => set({ search }),
  setSelectedStudentId: (selectedStudentId) => set({ selectedStudentId }),
  setMuted: (muted) => set({ muted })
}))

/** จับคู่การ์ดกับตัวกรองด่วย (ตามปุ่มสรุปด้านบนของ dashboard) */
export function matchesTriageFilter(
  student: { triageLevel: string; disconnected: boolean },
  filter: TriageFilter
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'critical':
      return student.triageLevel === 'critical'
    case 'warning':
      return student.triageLevel === 'warning' && !student.disconnected
    case 'disconnected':
      return student.disconnected && student.triageLevel !== 'critical'
    case 'normal':
      return student.triageLevel === 'normal' && !student.disconnected
    default:
      return true
  }
}

export function timeAgo(fromMs: number | null, nowMs: number): string {
  if (fromMs === null) return ''
  const seconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  if (seconds < 60) return `${seconds} วินาทีที่แล้ว`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} นาทีที่แล้ว`
  return `${Math.floor(minutes / 60)} ชั่วโมงที่แล้ว`
}

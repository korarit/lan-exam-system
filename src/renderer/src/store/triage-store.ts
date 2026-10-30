import { create } from 'zustand'
import type { TriageOverviewEvent } from '@shared/ipc-channels'

export type TriageFilter = 'all' | 'critical' | 'warning' | 'disconnected' | 'normal'

/** ระดับ severity ที่ยอมให้ขึ้น toast แจ้งเตือน (กัน alert fatigue) */
export type TriageToastSeverity = 'critical' | 'all'

export interface TriageUiState {
  overview: TriageOverviewEvent | null
  filter: TriageFilter
  search: string
  selectedStudentId: string | null
  muted: boolean
  /** TRI-06: เกท toast/เสียง alert — muted=true คือเงียบทั้งหมด */
  toastSeverity: TriageToastSeverity
  setOverview: (overview: TriageOverviewEvent) => void
  setFilter: (filter: TriageFilter) => void
  setSearch: (search: string) => void
  setSelectedStudentId: (studentId: string | null) => void
  setMuted: (muted: boolean) => void
  setToastSeverity: (level: TriageToastSeverity) => void
}

export const useTriageStore = create<TriageUiState>((set) => ({
  overview: null,
  filter: 'all',
  search: '',
  selectedStudentId: null,
  muted: false,
  toastSeverity: 'critical',
  setOverview: (overview) => set({ overview }),
  setFilter: (filter) => set({ filter }),
  setSearch: (search) => set({ search }),
  setSelectedStudentId: (selectedStudentId) => set({ selectedStudentId }),
  setMuted: (muted) => set({ muted }),
  setToastSeverity: (toastSeverity) => set({ toastSeverity })
}))

/**
 * TRI-06: เกทกลางสำหรับ toast/เสียง alert ฝั่งครู
 * - muted=true → เงียบทั้งหมด (ไม่ toast + ไม่ beep)
 * - toastSeverity='critical' → ผ่านเฉพาะ critical เท่านั้น
 */
export function shouldAlertToast(
  severity: 'info' | 'warning' | 'critical',
  opts: { muted: boolean; toastSeverity: TriageToastSeverity }
): boolean {
  if (opts.muted) return false
  if (opts.toastSeverity === 'critical' && severity !== 'critical') return false
  return true
}

/** TRI-06: เสียง beep สั้นผ่าน WebAudio — เคารพ muted เสมอ (muted=true คือไม่ดัง) */
export function playCriticalBeep(muted: boolean): void {
  if (muted) return
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.value = 0.08
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.25)
    osc.onended = (): void => {
      void ctx.close().catch(() => undefined)
    }
  } catch {
    /* ไม่มี audio device ก็ข้ามไป — toast ยังทำงานปกติ */
  }
}

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

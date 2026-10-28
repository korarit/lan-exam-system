import { create } from 'zustand'
import type {
  HostScreenLiveSegmentEvent,
  HostScreenSegmentDataEvent,
  HostScreenSegmentsEvent,
  HostScreenThumbnailEvent
} from '@shared/ipc-channels'
import type { RingSegmentMeta } from '@shared/screen-protocol'

/* ============================================================
 * Phase 3c: สถานะหน้าจอของ Dashboard ฝั่งครู
 * - thumbnails: เฟรมล่าสุดต่อ `${studentId}:${displayIndex}` (RAM เท่านั้น)
 * - segments: รายการเซกเมนต์ 5 นาทีล่าสุดที่เครื่องนักเรียนส่งรายงาน
 *   (+ เซกเมนต์ใหม่ที่สตรีมสดผ่าน UDP ระหว่างโหมดดู — DVR timeline)
 * - segmentData: เนื้อหา .webm ที่ดึงมาแล้ว (blob URL สร้างที่ component)
 * ============================================================ */

export interface SegmentDataEntry {
  segmentId: string
  displayId: string
  mimeType: string
  dataBase64: string
  fetchedAtMs: number
}

interface HostScreenState {
  thumbnails: Record<string, HostScreenThumbnailEvent>
  segmentsByStudent: Record<string, Record<string, RingSegmentMeta[]>>
  segmentData: Record<string, SegmentDataEntry>
  ingestThumbnail: (event: HostScreenThumbnailEvent) => void
  ingestSegments: (event: HostScreenSegmentsEvent) => void
  ingestSegmentData: (event: HostScreenSegmentDataEvent) => void
  /** เซกเมนต์สดจาก UDP stream — ต่อท้าย timeline + เก็บข้อมูลลง cache เล่นได้ทันที */
  ingestLiveSegment: (event: HostScreenLiveSegmentEvent) => void
  clearStudent: (studentId: string) => void
  clearAll: () => void
}

const MAX_CACHED_SEGMENTS = 40

export const useHostScreenStore = create<HostScreenState>((set) => ({
  thumbnails: {},
  segmentsByStudent: {},
  segmentData: {},
  ingestThumbnail: (event) =>
    set((state) => ({
      thumbnails: { ...state.thumbnails, [`${event.studentId}:${event.displayIndex}`]: event }
    })),
  ingestSegments: (event) =>
    set((state) => {
      const perStudent = { ...(state.segmentsByStudent[event.studentId] ?? {}) }
      perStudent[event.displayId] = event.segments
      return { segmentsByStudent: { ...state.segmentsByStudent, [event.studentId]: perStudent } }
    }),
  ingestSegmentData: (event) =>
    set((state) => {
      const entries = Object.values(state.segmentData)
      entries.push({
        segmentId: event.segmentId,
        displayId: event.displayId,
        mimeType: event.mimeType,
        dataBase64: event.dataBase64,
        fetchedAtMs: Date.now()
      })
      entries.sort((a, b) => b.fetchedAtMs - a.fetchedAtMs)
      const trimmed = entries.slice(0, MAX_CACHED_SEGMENTS)
      const next: Record<string, SegmentDataEntry> = {}
      for (const entry of trimmed) next[entry.segmentId] = entry
      return { segmentData: next }
    }),
  clearStudent: (studentId) =>
    set((state) => {
      const thumbnails: Record<string, HostScreenThumbnailEvent> = {}
      for (const [key, value] of Object.entries(state.thumbnails)) {
        if (!key.startsWith(`${studentId}:`)) thumbnails[key] = value
      }
      const segmentsByStudent = { ...state.segmentsByStudent }
      delete segmentsByStudent[studentId]
      return { thumbnails, segmentsByStudent }
    }),
  ingestLiveSegment: (event) =>
    set((state) => {
      const meta: RingSegmentMeta = {
        segmentId: event.segmentId,
        displayId: event.displayId,
        seqNo: event.seqNo,
        startTimeMs: event.startTimeMs,
        endTimeMs: event.endTimeMs,
        byteLength: 0
      }
      const perStudent = { ...(state.segmentsByStudent[event.studentId] ?? {}) }
      const existing = perStudent[event.displayId] ?? []
      if (!existing.some((segment) => segment.segmentId === event.segmentId)) {
        perStudent[event.displayId] = [...existing, meta].sort((a, b) => a.startTimeMs - b.startTimeMs)
      }
      // เก็บข้อมูลเซกเมนต์ลง cache (กลไกเดียวกับ ingestSegmentData)
      const entries = Object.values(state.segmentData)
      if (!state.segmentData[event.segmentId]) {
        entries.push({
          segmentId: event.segmentId,
          displayId: event.displayId,
          mimeType: event.mimeType,
          dataBase64: event.dataBase64,
          fetchedAtMs: Date.now()
        })
      }
      entries.sort((a, b) => b.fetchedAtMs - a.fetchedAtMs)
      const trimmed = entries.slice(0, MAX_CACHED_SEGMENTS)
      const segmentData: Record<string, SegmentDataEntry> = {}
      for (const entry of trimmed) segmentData[entry.segmentId] = entry
      return { segmentsByStudent: { ...state.segmentsByStudent, [event.studentId]: perStudent }, segmentData }
    }),
  clearAll: () => set({ thumbnails: {}, segmentsByStudent: {}, segmentData: {} })
}))

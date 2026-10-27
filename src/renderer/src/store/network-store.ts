import { create } from 'zustand'
import type { HostRoomInfo } from '@shared/ipc-channels'
import type { DiscoveredRoom, HostStudentStatus, StudentConnectionStatus } from '@shared/protocol-schema'

export interface HostNetworkState {
  room: HostRoomInfo | null
  students: HostStudentStatus[]
  setRoom: (room: HostRoomInfo | null) => void
  setStudents: (students: HostStudentStatus[]) => void
}

export const useHostNetworkStore = create<HostNetworkState>((set) => ({
  room: null,
  students: [],
  setRoom: (room) => set({ room }),
  setStudents: (students) => set({ students })
}))

export interface StudentNetworkState {
  rooms: DiscoveredRoom[]
  connection: StudentConnectionStatus
  joinError: string | null
  setRooms: (rooms: DiscoveredRoom[]) => void
  setConnection: (connection: StudentConnectionStatus) => void
  setJoinError: (error: string | null) => void
}

export const useStudentNetworkStore = create<StudentNetworkState>((set) => ({
  rooms: [],
  connection: { state: 'idle' },
  joinError: null,
  setRooms: (rooms) => set({ rooms }),
  setConnection: (connection) => set({ connection }),
  setJoinError: (joinError) => set({ joinError })
}))

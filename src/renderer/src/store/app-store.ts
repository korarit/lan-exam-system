import { create } from 'zustand'
import type { AppRole } from '@shared/types/role'

export type ConnectionState = 'offline' | 'connecting' | 'connected'

export interface Notification {
  severity: 'info' | 'warning' | 'critical'
  message: string
}

interface AppState {
  role: AppRole
  connectionState: ConnectionState
  activeNotification: Notification | null
  setRole: (role: AppRole) => void
  setConnectionState: (state: ConnectionState) => void
  notify: (notification: Notification) => void
  clearNotification: () => void
}

export const useAppStore = create<AppState>((set) => ({
  role: 'unselected',
  connectionState: 'offline',
  activeNotification: null,
  setRole: (role) => set({ role }),
  setConnectionState: (connectionState) => set({ connectionState }),
  notify: (activeNotification) => set({ activeNotification }),
  clearNotification: () => set({ activeNotification: null })
}))

import { GraduationCap, Wifi, WifiOff, Loader2 } from 'lucide-react'
import StudentPanel from './StudentPanel'
import { useAppStore } from '../store/app-store'
import type { ConnectionState } from '../store/app-store'
import { Badge } from '@renderer/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@renderer/components/ui/tooltip'
import { ThemeToggle } from '@renderer/components/theme-toggle'

const CONNECTION_META: Record<
  ConnectionState,
  { variant: 'default' | 'secondary' | 'destructive'; label: string; hint: string }
> = {
  connected: { variant: 'default', label: 'เชื่อมต่อแล้ว', hint: 'เชื่อมต่อห้องสอบสำเร็จ พร้อมทำข้อสอบ' },
  connecting: { variant: 'secondary', label: 'กำลังเชื่อมต่อ', hint: 'กำลังค้นหาห้องสอบในวง LAN กรุณารอสักครู่' },
  offline: { variant: 'destructive', label: 'ออฟไลน์', hint: 'ยังไม่ได้เชื่อมต่อ ตรวจสอบเครือข่าย LAN' }
}

function ConnectionBadge({ state }: { state: ConnectionState }): React.JSX.Element {
  const meta = CONNECTION_META[state]
  const Icon =
    state === 'connected' ? Wifi : state === 'connecting' ? Loader2 : WifiOff
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant={meta.variant}>
            <Icon className={state === 'connecting' ? 'animate-spin' : undefined} />
            {meta.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{meta.hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export default function StudentShell(): React.JSX.Element {
  const connectionState = useAppStore((s) => s.connectionState)

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="border-b border-border bg-card px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <GraduationCap className="text-primary" size={24} />
            <div>
              <h1 className="font-semibold leading-tight">นักเรียน — เข้าห้องสอบ</h1>
              <p className="text-xs text-muted-foreground">Room Browser + PIN verification</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ConnectionBadge state={connectionState} />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="container mx-auto w-full max-w-6xl flex-1 overflow-y-auto p-6">
        <StudentPanel />
      </main>
    </div>
  )
}

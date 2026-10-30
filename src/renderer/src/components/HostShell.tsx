import { useState } from 'react'
import {
  MonitorCog,
  ClipboardList,
  PenTool,
  Rows3,
  Code2,
  Wifi,
  WifiOff,
  Loader2
} from 'lucide-react'
import HostPanel from './HostPanel'
import FormBuilderWorkspace from '@modules/dynamic-form/renderer/builder/FormBuilderWorkspace'
import ResponsesDashboard from '@modules/dynamic-form/renderer/responses/ResponsesDashboard'
import CodeExamBuilder from '@modules/code-ide/renderer/builder/CodeExamBuilder'
import CodeSubmissionsTable from '@modules/code-ide/renderer/responses/CodeSubmissionsTable'
import { useAppStore } from '../store/app-store'
import type { ConnectionState } from '../store/app-store'
import { Badge } from '@renderer/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@renderer/components/ui/tooltip'
import { ThemeToggle } from '@renderer/components/theme-toggle'

type HostTab = 'room' | 'form-builder' | 'form-responses' | 'code-builder' | 'code-responses'

const CONNECTION_META: Record<
  ConnectionState,
  { variant: 'default' | 'secondary' | 'destructive'; label: string; hint: string }
> = {
  connected: { variant: 'default', label: 'เชื่อมต่อแล้ว', hint: 'เชื่อมต่อเซิร์ฟเวอร์สำเร็จ พร้อมใช้งาน' },
  connecting: { variant: 'secondary', label: 'กำลังเชื่อมต่อ', hint: 'กำลังพยายามเชื่อมต่อ กรุณารอสักครู่' },
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

export default function HostShell(): React.JSX.Element {
  const connectionState = useAppStore((s) => s.connectionState)
  const [tab, setTab] = useState<HostTab>('room')

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="border-b border-border bg-card px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <MonitorCog className="text-primary" size={24} />
            <div>
              <h1 className="font-semibold leading-tight">เครื่องแม่ — ผู้คุมสอบ</h1>
              <p className="text-xs text-muted-foreground">
                เปิดห้อง + UDP beacon + TLS 1.3 server
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ConnectionBadge state={connectionState} />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as HostTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="border-b border-border px-6 py-2">
          <TabsList>
            <TabsTrigger value="room">
              <ClipboardList />
              ห้องสอบ &amp; ผู้คุม
            </TabsTrigger>
            <TabsTrigger value="form-builder">
              <PenTool />
              Dynamic Form Builder
            </TabsTrigger>
            <TabsTrigger value="form-responses">
              <Rows3 />
              ผลตอบฟอร์ม (ตรวจ/ส่งออก)
            </TabsTrigger>
            <TabsTrigger value="code-builder">
              <Code2 />
              Code IDE Builder (.ztcode)
            </TabsTrigger>
            <TabsTrigger value="code-responses">
              <Rows3 />
              ผลตรวจ Code (Grader)
            </TabsTrigger>
          </TabsList>
        </div>
        <main className="container mx-auto w-full max-w-6xl flex-1 overflow-y-auto p-6">
          <TabsContent value="room">
            <HostPanel />
          </TabsContent>
          <TabsContent value="form-builder">
            <FormBuilderWorkspace />
          </TabsContent>
          <TabsContent value="form-responses">
            <ResponsesDashboard />
          </TabsContent>
          <TabsContent value="code-builder">
            <CodeExamBuilder />
          </TabsContent>
          <TabsContent value="code-responses">
            <CodeSubmissionsTable />
          </TabsContent>
        </main>
      </Tabs>
    </div>
  )
}

import { MonitorCog, Activity } from 'lucide-react'
import HostPanel from './HostPanel'
import { useAppStore } from '../store/app-store'

export default function HostShell(): React.JSX.Element {
  const connectionState = useAppStore((s) => s.connectionState)

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <MonitorCog className="text-emerald-400" size={24} />
          <div>
            <h1 className="font-semibold">เครื่องแม่ — ผู้คุมสอบ</h1>
            <p className="text-xs text-slate-500">เปิดห้อง + UDP beacon + TLS 1.3 server</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-400">
          <Activity size={14} className="text-emerald-400" />
          {connectionState}
        </div>
      </header>
      <main className="flex-1 overflow-y-auto p-6">
        <HostPanel />
      </main>
    </div>
  )
}

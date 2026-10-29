import { useState } from 'react'
import { MonitorCog, Activity, ClipboardList, PenTool, Rows3, Code2 } from 'lucide-react'
import HostPanel from './HostPanel'
import FormBuilderWorkspace from '@modules/dynamic-form/renderer/builder/FormBuilderWorkspace'
import ResponsesDashboard from '@modules/dynamic-form/renderer/responses/ResponsesDashboard'
import CodeExamBuilder from '@modules/code-ide/renderer/builder/CodeExamBuilder'
import CodeSubmissionsTable from '@modules/code-ide/renderer/responses/CodeSubmissionsTable'
import { useAppStore } from '../store/app-store'

type HostTab = 'room' | 'form-builder' | 'form-responses' | 'code-builder' | 'code-responses'

export default function HostShell(): React.JSX.Element {
  const connectionState = useAppStore((s) => s.connectionState)
  const [tab, setTab] = useState<HostTab>('room')

  const tabs: Array<{ id: HostTab; label: string; icon: React.ReactNode }> = [
    { id: 'room', label: 'ห้องสอบ & ผู้คุม', icon: <ClipboardList size={14} /> },
    { id: 'form-builder', label: 'Dynamic Form Builder', icon: <PenTool size={14} /> },
    { id: 'form-responses', label: 'ผลตอบฟอร์ม (ตรวจ/ส่งออก)', icon: <Rows3 size={14} /> },
    { id: 'code-builder', label: 'Code IDE Builder (.ztcode)', icon: <Code2 size={14} /> },
    { id: 'code-responses', label: 'ผลตรวจ Code (Grader)', icon: <Rows3 size={14} /> }
  ]

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
      <nav className="flex gap-1 border-b border-slate-800 px-6">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-t-lg px-4 py-2 text-sm transition ${
              tab === t.id ? 'border-b-2 border-emerald-500 font-semibold text-emerald-300' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
      <main className="flex-1 overflow-y-auto p-6">
        {tab === 'room' ? (
          <HostPanel />
        ) : tab === 'form-builder' ? (
          <FormBuilderWorkspace />
        ) : tab === 'form-responses' ? (
          <ResponsesDashboard />
        ) : tab === 'code-builder' ? (
          <CodeExamBuilder />
        ) : (
          <CodeSubmissionsTable />
        )}
      </main>
    </div>
  )
}

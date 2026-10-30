import { GraduationCap, Wifi, WifiOff, Loader2 } from 'lucide-react'
import StudentPanel from './StudentPanel'
import { useAppStore } from '../store/app-store'

export default function StudentShell(): React.JSX.Element {
  const connectionState = useAppStore((s) => s.connectionState)

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <GraduationCap className="text-sky-400" size={24} />
          <div>
            <h1 className="font-semibold">นักเรียน — เข้าห้องสอบ</h1>
            <p className="text-xs text-slate-500">Room Browser + PIN verification</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-400">
          {connectionState === 'connected' ? (
            <Wifi size={14} className="text-emerald-400" />
          ) : connectionState === 'connecting' ? (
            <Loader2 size={14} className="animate-spin text-sky-400" />
          ) : (
            <WifiOff size={14} className="text-amber-400" />
          )}
          {connectionState}
        </div>
      </header>
      <main className="flex-1 overflow-y-auto">
        <StudentPanel />
      </main>
    </div>
  )
}

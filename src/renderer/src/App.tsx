import { useEffect } from 'react'
import { useAppStore } from './store/app-store'
import RoleSelector from './components/RoleSelector'
import HostShell from './components/HostShell'
import StudentShell from './components/StudentShell'

export default function App(): React.JSX.Element {
  const role = useAppStore((s) => s.role)
  const setRole = useAppStore((s) => s.setRole)
  const activeNotification = useAppStore((s) => s.activeNotification)
  const clearNotification = useAppStore((s) => s.clearNotification)

  useEffect(() => {
    // ดึงสถานะเริ่มต้นจาก Main (รวมบทบาทที่ตั้งผ่าน --role CLI flag)
    void window.ztExam
      .getAppInfo()
      .then((info) => setRole(info.role))
      .catch(() => setRole('unselected'))
    // subscribe push event + cleanup กัน memory leak
    return window.ztExam.onRoleChanged((event) => setRole(event.role))
  }, [setRole])

  return (
    <div className="h-full">
      {role === 'host' ? <HostShell /> : role === 'student' ? <StudentShell /> : <RoleSelector />}
      {activeNotification && (
        <div
          role="status"
          className={`fixed bottom-4 right-4 z-50 rounded-xl border px-4 py-3 text-sm shadow-lg ${
            activeNotification.severity === 'critical'
              ? 'border-red-500/40 bg-red-950/80 text-red-200'
              : activeNotification.severity === 'warning'
                ? 'border-amber-500/40 bg-amber-950/80 text-amber-200'
                : 'border-slate-700 bg-slate-900/90 text-slate-200'
          }`}
        >
          {activeNotification.message}
          <button
            type="button"
            onClick={clearNotification}
            className="ml-3 text-xs text-slate-400 hover:text-slate-200"
          >
            ปิด
          </button>
        </div>
      )}
    </div>
  )
}

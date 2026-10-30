import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from './store/app-store'
import RoleSelector from './components/RoleSelector'
import HostShell from './components/HostShell'
import StudentShell from './components/StudentShell'
import { ThemeProvider } from './components/theme-provider'
import { Toaster } from './components/ui/sonner'

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

  useEffect(() => {
    if (!activeNotification) return
    const { severity, message } = activeNotification
    if (severity === 'critical') {
      toast.error(message)
    } else if (severity === 'warning') {
      toast.warning(message)
    } else {
      toast.info(message)
    }
    clearNotification()
  }, [activeNotification, clearNotification])

  return (
    <ThemeProvider>
      <div className="h-full bg-background text-foreground">
        {role === 'host' ? <HostShell /> : role === 'student' ? <StudentShell /> : <RoleSelector />}
        <Toaster />
      </div>
    </ThemeProvider>
  )
}

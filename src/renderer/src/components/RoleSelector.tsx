import { MonitorCog, GraduationCap, ShieldCheck } from 'lucide-react'
import { useAppStore } from '../store/app-store'

export default function RoleSelector(): React.JSX.Element {
  const setRole = useAppStore((s) => s.setRole)
  const notify = useAppStore((s) => s.notify)

  async function select(role: 'host' | 'student'): Promise<void> {
    try {
      const res = await window.ztExam.selectRole({ role })
      if (res.ok) {
        setRole(role)
        notify({
          severity: 'info',
          message:
            role === 'host'
              ? 'กำลังเตรียมฐานข้อมูลของเครื่องแม่…'
              : 'พร้อมเข้าห้องสอบ'
        })
      }
    } catch (err) {
      notify({
        severity: 'critical',
        message: err instanceof Error ? err.message : 'เลือกบทบาทไม่สำเร็จ'
      })
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-10 px-8">
      <div className="text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-1.5 text-sm text-emerald-300">
          <ShieldCheck size={16} />
          Zero-Trust LAN Exam
        </div>
        <h1 className="text-3xl font-bold">เปิดแอปในฐานะใด?</h1>
        <p className="mt-2 text-sm text-slate-400">
          เลือกบทบาทของเครื่องนี้ (สามารถตั้งค่าล่วงหน้าด้วย flag
          <code className="mx-1 rounded bg-slate-800 px-1.5 py-0.5 text-xs">--role=host|student</code>
          ได้)
        </p>
      </div>

      <div className="grid w-full max-w-3xl grid-cols-1 gap-6 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => void select('host')}
          className="group rounded-2xl border border-slate-700 bg-slate-900 p-8 text-left transition hover:border-emerald-500/60 hover:bg-slate-800/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          <MonitorCog className="mb-4 text-emerald-400" size={40} />
          <div className="text-lg font-semibold">เครื่องแม่</div>
          <div className="text-sm text-slate-400">ผู้คุมสอบ / อาจารย์</div>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            สร้างห้องสอบ ควบคุมเวลา รับคำตอบ และเป็นแหล่งความจริงของ Audit Log
          </p>
        </button>

        <button
          type="button"
          onClick={() => void select('student')}
          className="group rounded-2xl border border-slate-700 bg-slate-900 p-8 text-left transition hover:border-sky-500/60 hover:bg-slate-800/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          <GraduationCap className="mb-4 text-sky-400" size={40} />
          <div className="text-lg font-semibold">เครื่องนักเรียน</div>
          <div className="text-sm text-slate-400">เข้าห้องสอบ</div>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            ค้นหาห้องสอบในวง LAN กรอก PIN และทำข้อสอบภายใต้โหมด Kiosk
          </p>
        </button>
      </div>
    </div>
  )
}

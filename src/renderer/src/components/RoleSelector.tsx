import { MonitorCog, GraduationCap, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '../store/app-store'
import { Button } from '@renderer/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'

export default function RoleSelector(): React.JSX.Element {
  const setRole = useAppStore((s) => s.setRole)

  async function select(role: 'host' | 'student'): Promise<void> {
    try {
      const res = await window.ztExam.selectRole({ role })
      if (res.ok) {
        setRole(role)
        toast.info(
          role === 'host' ? 'กำลังเตรียมฐานข้อมูลของเครื่องแม่…' : 'พร้อมเข้าห้องสอบ'
        )
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'เลือกบทบาทไม่สำเร็จ')
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-3xl">
        <div className="text-center">
          <Badge variant="secondary" className="mb-3">
            <ShieldCheck />
            Zero-Trust LAN Exam
          </Badge>
          <h1 className="text-3xl font-bold tracking-tight">เปิดแอปในฐานะใด?</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            เลือกบทบาทของเครื่องนี้ (สามารถตั้งค่าล่วงหน้าด้วย flag
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              --role=host|student
            </code>
            ได้)
          </p>
        </div>

        <div className="mt-8 grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
          <Card className="flex flex-col">
            <CardHeader>
              <MonitorCog className="mb-2 text-primary" size={32} />
              <CardTitle className="text-lg">เครื่องแม่</CardTitle>
              <CardDescription>ผู้คุมสอบ / อาจารย์</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col">
              <p className="flex-1 text-sm leading-relaxed text-muted-foreground">
                สร้างห้องสอบ ควบคุมเวลา รับคำตอบ และเป็นแหล่งความจริงของ Audit Log
              </p>
              <Button
                type="button"
                className="mt-6 w-full"
                onClick={() => void select('host')}
              >
                ใช้เป็นเครื่องแม่
              </Button>
            </CardContent>
          </Card>

          <Card className="flex flex-col">
            <CardHeader>
              <GraduationCap className="mb-2 text-primary" size={32} />
              <CardTitle className="text-lg">เครื่องนักเรียน</CardTitle>
              <CardDescription>เข้าห้องสอบ</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col">
              <p className="flex-1 text-sm leading-relaxed text-muted-foreground">
                ค้นหาห้องสอบในวง LAN กรอก PIN และทำข้อสอบภายใต้โหมด Kiosk
              </p>
              <Button
                type="button"
                className="mt-6 w-full"
                onClick={() => void select('student')}
              >
                ใช้เป็นเครื่องนักเรียน
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

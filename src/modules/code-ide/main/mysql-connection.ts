import net from 'node:net'
import { MYSQL_DEFAULT_HOST, MYSQL_DEFAULT_PORT } from '../shared/code-schema'

/* Phase 9 (9.4.4) — MySQL/MariaDB connection preflight
 * เช็คว่า host:port (default localhost:3303) ต่อติดไหม ก่อนรัน query ของนักเรียน
 * เป็นแค่ TCP reachability (ยังไม่ login) — login จริงใช้ mysql driver ใน sql-runner
 */

export interface MysqlReachability {
  ok: boolean
  host: string
  port: number
  latencyMs: number
  message: string
}

export function checkMysqlPortReachable(
  host: string = MYSQL_DEFAULT_HOST,
  port: number = MYSQL_DEFAULT_PORT,
  timeoutMs = 3000
): Promise<MysqlReachability> {
  const targetHost = host.trim() === '' ? MYSQL_DEFAULT_HOST : host.trim()
  const targetPort = Number.isFinite(port) ? port : MYSQL_DEFAULT_PORT
  const started = Date.now()
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let done = false
    function finish(ok: boolean, message: string): void {
      if (done) return
      done = true
      socket.destroy()
      resolve({ ok, host: targetHost, port: targetPort, latencyMs: Date.now() - started, message })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      finish(true, `✅ เชื่อมต่อ ${targetHost}:${targetPort} สำเร็จ (${Date.now() - started} ms)`)
    })
    socket.once('timeout', () => {
      finish(false, `⛔ ต่อ ${targetHost}:${targetPort} ไม่ติดใน ${timeoutMs} ms — ตรวจว่า MySQL รันอยู่และ firewall เปิด port ${targetPort} ไหม`)
    })
    socket.once('error', (err: Error) => {
      finish(false, `⛔ ต่อ ${targetHost}:${targetPort} ไม่ติด: ${err.message} — ตรวจว่า MySQL รันอยู่, host/port/user ถูกไหม`)
    })
    socket.connect(targetPort, targetHost)
  })
}

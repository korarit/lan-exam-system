import {
  deriveDeviceId,
  type EnrolledDeviceStatus,
  type EnrolledDeviceView
} from '@shared/device-roster-schema'
import type { HostDatabase } from '../storage/db'

/* ============================================================
 * TOFU device enrollment (auto-accept ตอน join)
 *
 * - client ส่ง deviceId + publicKeyHex มาใน attestation response
 * - ครั้งแรกที่เห็น: บันทึกเป็น active แล้วผูกกับ studentId
 * - ครั้งถัดไป: ต้องเป็น deviceId/key/studentId เดิม (ไม่งั้น conflict)
 * - ครู block/remove ได้จาก dashboard
 *
 * ข้อจำกัด: auto-accept ไม่ได้พิสูจน์ว่าเป็น client จริง — มันกัน
 * การ copy key ข้ามเครื่อง, การสลับ device, และทำให้ครูเห็น/ตัด device ได้
 * ถ้าต้องการ strict ต้องใช้ signed roster (ซึ่งมาก่อนตารางนี้เสมอ)
 * ============================================================ */

export interface DeviceEnrollmentObserveInput {
  deviceId: string
  publicKeyHex: string
  studentId: string
  hardwareBound?: boolean
}

export type DeviceObserveResult =
  | { ok: true; status: 'enrolled' | 'known'; publicKeyHex: string }
  | { ok: false; reason: 'invalid-key' | 'device-id-mismatch' | 'student-conflict' | 'blocked' }

interface EnrolledDeviceRow {
  device_id: string
  public_key: string
  student_id: string
  label: string | null
  status: EnrolledDeviceStatus
  hardware_bound: number
  first_seen_ms: number
  last_seen_ms: number
  seen_count: number
}

function toView(row: EnrolledDeviceRow): EnrolledDeviceView {
  return {
    deviceId: row.device_id,
    publicKey: row.public_key,
    studentId: row.student_id,
    label: row.label,
    status: row.status,
    hardwareBound: row.hardware_bound !== 0,
    firstSeenAtMs: row.first_seen_ms,
    lastSeenAtMs: row.last_seen_ms,
    seenCount: row.seen_count
  }
}

export interface DeviceEnrollmentOptions {
  now?: () => number
}

export class DeviceEnrollmentService {
  private readonly now: () => number

  constructor(
    private readonly db: HostDatabase,
    options: DeviceEnrollmentOptions = {}
  ) {
    this.now = options.now ?? Date.now
  }

  /** บันทึก/อัปเดต device ที่เพิ่ง join — auto-accept ครั้งแรก, ตรวจ conflict ครั้งถัดไป */
  observe(input: DeviceEnrollmentObserveInput): DeviceObserveResult {
    const deviceId = input.deviceId.trim().toLowerCase()
    const publicKey = input.publicKeyHex.trim().toLowerCase()
    const studentId = input.studentId.trim()
    if (
      !/^[0-9a-f]{32}$/.test(deviceId) ||
      !/^[0-9a-f]{64}$/.test(publicKey) ||
      studentId === ''
    ) {
      return { ok: false, reason: 'invalid-key' }
    }
    if (deriveDeviceId(publicKey) !== deviceId) {
      return { ok: false, reason: 'device-id-mismatch' }
    }

    const existing = this.db.db
      .prepare(
        `SELECT device_id, public_key, student_id, label, status, hardware_bound,
                first_seen_ms, last_seen_ms, seen_count
         FROM enrolled_devices WHERE device_id = ?`
      )
      .get(deviceId) as EnrolledDeviceRow | undefined

    const now = this.now()
    if (existing) {
      if (existing.status === 'blocked') return { ok: false, reason: 'blocked' }
      if (existing.student_id !== studentId) return { ok: false, reason: 'student-conflict' }
      this.db.db
        .prepare(
          `UPDATE enrolled_devices
           SET last_seen_ms = ?, seen_count = seen_count + 1,
               hardware_bound = MAX(hardware_bound, ?)
           WHERE device_id = ?`
        )
        .run(now, input.hardwareBound === true ? 1 : 0, deviceId)
      return { ok: true, status: 'known', publicKeyHex: existing.public_key }
    }

    this.db.db
      .prepare(
        `INSERT INTO enrolled_devices
         (device_id, public_key, student_id, label, status, hardware_bound,
          first_seen_ms, last_seen_ms, seen_count)
         VALUES (?, ?, ?, NULL, 'active', ?, ?, ?, 1)`
      )
      .run(deviceId, publicKey, studentId, input.hardwareBound === true ? 1 : 0, now, now)
    return { ok: true, status: 'enrolled', publicKeyHex: publicKey }
  }

  /** public key ของ device ที่ยัง active (ใช้ตรวจ native signature) */
  lookupPublicKey(deviceId: string): string | null {
    const row = this.db.db
      .prepare(`SELECT public_key FROM enrolled_devices WHERE device_id = ? AND status = 'active'`)
      .get(deviceId.trim().toLowerCase()) as { public_key: string } | undefined
    return row?.public_key ?? null
  }

  /** studentId ที่ผูกกับ device (คืนแม้ blocked เพื่อให้ตรวจ mismatch ได้) */
  studentIdFor(deviceId: string): string | null {
    const row = this.db.db
      .prepare(`SELECT student_id FROM enrolled_devices WHERE device_id = ?`)
      .get(deviceId.trim().toLowerCase()) as { student_id: string } | undefined
    return row?.student_id ?? null
  }

  hasDevice(deviceId: string): boolean {
    const row = this.db.db
      .prepare(`SELECT 1 AS present FROM enrolled_devices WHERE device_id = ?`)
      .get(deviceId.trim().toLowerCase()) as { present: number } | undefined
    return row !== undefined
  }

  list(): EnrolledDeviceView[] {
    const rows = this.db.db
      .prepare(
        `SELECT device_id, public_key, student_id, label, status, hardware_bound,
                first_seen_ms, last_seen_ms, seen_count
         FROM enrolled_devices
         ORDER BY last_seen_ms DESC`
      )
      .all() as EnrolledDeviceRow[]
    return rows.map(toView)
  }

  setStatus(deviceId: string, status: EnrolledDeviceStatus): boolean {
    const result = this.db.db
      .prepare(`UPDATE enrolled_devices SET status = ? WHERE device_id = ?`)
      .run(status, deviceId.trim().toLowerCase())
    return result.changes > 0
  }

  remove(deviceId: string): boolean {
    const result = this.db.db
      .prepare(`DELETE FROM enrolled_devices WHERE device_id = ?`)
      .run(deviceId.trim().toLowerCase())
    return result.changes > 0
  }

  count(): number {
    const row = this.db.db
      .prepare(`SELECT COUNT(*) AS total FROM enrolled_devices`)
      .get() as { total: number }
    return row.total
  }
}

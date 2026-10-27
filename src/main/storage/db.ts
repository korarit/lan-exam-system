import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { applyMigrations, MIGRATIONS } from './migrations'

export interface HostDatabaseOptions {
  /** พาธไฟล์ .sqlite (ปกติ = app.getPath('userData')/zt-exam-host.sqlite) */
  filePath: string
}

/**
 * ฐานข้อมูล SQLite ฝั่งเครื่องแม่ (Host-authoritative)
 * - WAL mode สำหรับเขียนพร้อมกันจากหลายนักเรียน
 * - foreign_keys ON เสมอ
 */
export class HostDatabase {
  readonly db: Database.Database

  constructor(options: HostDatabaseOptions) {
    fs.mkdirSync(path.dirname(options.filePath), { recursive: true })
    this.db = new Database(options.filePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    applyMigrations(this.db)
  }

  get migrationVersion(): number {
    const row = this.db.pragma('user_version', { simple: true }) as number
    return row
  }

  get appliedMigrations(): number {
    return MIGRATIONS.length
  }

  close(): void {
    this.db.close()
  }
}

export function getDefaultDatabasePath(userDataPath: string): string {
  return path.join(userDataPath, 'zt-exam-host.sqlite')
}

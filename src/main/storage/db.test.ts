import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HostDatabase, getDefaultDatabasePath } from './db'
import {
  encryptAes256Gcm,
  generateAesKey,
  decryptAes256Gcm,
  computeHmac,
  sha256Hex
} from '../crypto/primitives'

const tempDirs: string[] = []

function makeTempDb(): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-exam-test-'))
  tempDirs.push(dir)
  return { dir, filePath: getDefaultDatabasePath(dir) }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function insertSession(db: HostDatabase): string {
  db.db
    .prepare(
      `INSERT INTO exam_sessions (id, room_name, mode, enforcement, status, crypto_salt, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run('sess-1', 'ห้อง 401', 'closed', 'report-only', 'lobby', 'salt-abc', Date.now())
  return 'sess-1'
}

describe('HostDatabase', () => {
  it('creates the database file with WAL and applies all migrations', () => {
    const { dir, filePath } = makeTempDb()
    const db = new HostDatabase({ filePath })
    expect(fs.existsSync(getDefaultDatabasePath(dir))).toBe(true)
    expect(db.migrationVersion).toBe(db.appliedMigrations)
    expect(db.db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.close()
  })

  it('skips already-applied migrations when reopening', () => {
    const { filePath } = makeTempDb()
    const first = new HostDatabase({ filePath })
    first.close()
    const second = new HostDatabase({ filePath })
    expect(second.migrationVersion).toBe(second.appliedMigrations)
    second.close()
  })

  it('stores an encrypted submission and decrypts it back correctly', () => {
    const db = new HostDatabase({ filePath: makeTempDb().filePath })
    const sessionId = insertSession(db)

    db.db
      .prepare(
        `INSERT INTO students (student_id, session_id, display_name, seed, status, suspicion_score, joined_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('std-01', sessionId, 'ด.ญ. สมใจ', 'seed-xyz', 'joined', 0, Date.now())

    // เขียนคำตอบแบบเข้ารหัส (field-level AES-256-GCM) + HMAC กันแก้ไข
    const answer = Buffer.from(JSON.stringify({ choice: 3 }), 'utf8')
    const key = generateAesKey()
    const encrypted = encryptAes256Gcm(answer, key)
    const hmac = computeHmac(key, encrypted.ciphertext).toString('base64')

    db.db
      .prepare(
        `INSERT INTO submissions (session_id, student_id, question_id, seq_no, ciphertext, iv, tag, hmac, received_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        'std-01',
        'q-12',
        1,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        hmac,
        Date.now()
      )

    const row = db.db
      .prepare(
        `SELECT ciphertext, iv, tag, hmac FROM submissions
         WHERE session_id = ? AND student_id = ? AND question_id = ? AND seq_no = 1`
      )
      .get(sessionId, 'std-01', 'q-12') as {
      ciphertext: string
      iv: string
      tag: string
      hmac: string
    }

    const hmacOk = computeHmac(key, row.ciphertext)
    expect(hmacOk.toString('base64')).toBe(row.hmac)
    const decrypted = decryptAes256Gcm(
      { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag },
      key
    )
    expect(JSON.parse(decrypted.toString('utf8'))).toEqual({ choice: 3 })
    db.close()
  })

  it('appends audit log entries as a valid hash chain', () => {
    const db = new HostDatabase({ filePath: makeTempDb().filePath })
    const sessionId = insertSession(db)

    const insert = db.db.prepare(
      `INSERT INTO audit_logs (session_id, student_id, timestamp_ms, event_type, severity, payload_json, prev_hash, entry_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )

    let prevHash = sha256Hex('genesis')
    const now = Date.now()
    const events: Array<{ type: string; payload: string }> = [
      { type: 'app-launched', payload: '{"ok":true}' },
      { type: 'kiosk-focus-lost', payload: '{"window":"other"}' },
      { type: 'process-blacklisted', payload: '{"exe":"remote.exe"}' }
    ]
    events.forEach((ev, i) => {
      const entryHash = sha256Hex(prevHash + ev.type + ev.payload)
      insert.run(sessionId, 'std-01', now + i, ev.type, 'warning', ev.payload, prevHash, entryHash)
      prevHash = entryHash
    })

    const rows = db.db
      .prepare(`SELECT * FROM audit_logs WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as Array<{
      event_type: string
      payload_json: string
      prev_hash: string
      entry_hash: string
    }>
    expect(rows).toHaveLength(3)

    // ตรวจ chain ย้อนหลัง: แก้แถวใดแถวหนึ่งจะตรวจพบทันที
    let hash = sha256Hex('genesis')
    for (const row of rows) {
      const expected = sha256Hex(hash + row.event_type + row.payload_json)
      expect(row.prev_hash).toBe(hash)
      expect(row.entry_hash).toBe(expected)
      hash = row.entry_hash
    }
    db.close()
  })

  it('enforces foreign keys between students and exam_sessions', () => {
    const db = new HostDatabase({ filePath: makeTempDb().filePath })
    expect(() =>
      db.db
        .prepare(
          `INSERT INTO students (student_id, session_id, display_name, seed, status, suspicion_score, joined_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('std-x', 'missing-session', 'x', 's', 'joined', 0, Date.now())
    ).toThrow(/FOREIGN KEY/)
    db.close()
  })
})

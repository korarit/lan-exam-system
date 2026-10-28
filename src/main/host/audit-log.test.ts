import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HostDatabase, getDefaultDatabasePath } from '../storage/db'
import { sha256Hex } from '../crypto/primitives'
import { AuditLogger, canonicalJsonString, deriveAuditKey } from './audit-log'
import { GENESIS_PREV_HASH } from '@shared/triage'

const tempDirs: string[] = []

function makeFixture(): { db: HostDatabase; logger: AuditLogger; roomId: string; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-exam-audit-'))
  tempDirs.push(dir)
  const db = new HostDatabase({ filePath: getDefaultDatabasePath(dir) })
  const roomId = '11111111-1111-4111-8111-111111111111'
  const seed = 'a'.repeat(64)
  db.db
    .prepare(
      `INSERT INTO exam_sessions (id, room_name, mode, enforcement, status, crypto_salt, created_at_ms)
       VALUES (?, ?, 'closed', 'report-only', 'running', ?, ?)`
    )
    .run(roomId, 'ห้อง 402', seed, Date.now())
  const logger = new AuditLogger(db, (id) => deriveAuditKey(seed, id))
  return {
    db,
    logger,
    roomId,
    dispose: () => {
      db.close()
    }
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function sampleEvidence(index: number): Record<string, unknown> {
  return { pid: String(8000 + index), processName: 'discord.exe', path: `C:\\app\\run${index}.exe` }
}

describe('canonicalJsonString', () => {
  it('is deterministic regardless of key insertion order and nested depth', () => {
    const a = { b: 1, a: { z: [1, 2], y: 'x' } }
    const b = { a: { y: 'x', z: [1, 2] }, b: 1 }
    expect(canonicalJsonString(a)).toBe(canonicalJsonString(b))
    expect(canonicalJsonString(a)).toBe('{"a":{"y":"x","z":[1,2]},"b":1}')
  })
})

describe('AuditLogger hash chain', () => {
  it('writes a genesis block with the planned formula and empty prevHash', () => {
    const { logger, roomId, dispose } = makeFixture()
    const now = 1_700_000_000_000
    const genesis = logger.appendGenesis(roomId, { policyVersion: 1, mode: 'closed' }, now)
    expect(genesis.seqNo).toBe(0)
    expect(genesis.prevHash).toBe(GENESIS_PREV_HASH)
    expect(genesis.eventCode).toBe('ROOM_CREATED')
    expect(genesis.entryHash).toBe(
      sha256Hex(`ZTEXAM_AUDIT_V1|0|${roomId}|${now}|ROOM_CREATED|{"mode":"closed","policyVersion":1}`)
    )
    dispose()
  })

  it('appends entries linked by prevHash and passes verifyAuditChain', () => {
    const { logger, roomId, dispose } = makeFixture()
    logger.appendGenesis(roomId, { v: 1 }, 1_700_000_000_000)
    for (let index = 0; index < 100; index += 1) {
      const entry = logger.append(roomId, {
        studentId: `std-${String(index % 5).padStart(2, '0')}`,
        eventCode: 'BLACKLISTED_PROCESS_DETECTED',
        category: 'ai-assistant',
        severity: 'critical',
        scoreDelta: 45,
        summaryText: `เปิดโปรแกรมต้องห้าม #${index}`,
        evidence: sampleEvidence(index)
      })
      expect(entry.seqNo).toBe(index + 1)
    }
    const verification = logger.verifyAuditChain(roomId)
    expect(verification).toEqual({ valid: true, totalEntries: 101 })
    dispose()
  })

  it('detects a single-character tamper of evidenceJson with the exact firstTamperedSeqNo', () => {
    const { db, logger, roomId, dispose } = makeFixture()
    logger.appendGenesis(roomId, { v: 1 }, 1_700_000_000_000)
    for (let index = 0; index < 10; index += 1) {
      logger.append(roomId, {
        studentId: 'std-01',
        eventCode: 'FORBIDDEN_DNS_QUERY_DETECTED',
        category: 'network-tunnel',
        severity: 'critical',
        scoreDelta: 45,
        summaryText: 'โดเมนต้องห้าม',
        evidence: { domain: `example-${index}.com` }
      })
    }
    expect(logger.verifyAuditChain(roomId).valid).toBe(true)

    // แก้ไข evidenceJson (payload_json) ของ seq 4 แม้แต่ 1 ตัวอักษร (seq 4 ↔ example-3.com)
    db.db
      .prepare(`UPDATE audit_logs SET payload_json = replace(payload_json, 'example-3', 'example-X') WHERE seq_no = 4`)
      .run()
    const verification = logger.verifyAuditChain(roomId)
    expect(verification.valid).toBe(false)
    expect(verification.firstTamperedSeqNo).toBe(4)
    expect(verification.reason).toContain('HASH_MISMATCH')
    dispose()
  })

  it('detects a tampered server timestamp and a forged hostHmac', () => {
    const { db, logger, roomId, dispose } = makeFixture()
    logger.appendGenesis(roomId, { v: 1 }, 1_700_000_000_000)
    logger.append(roomId, {
      studentId: 'std-01',
      eventCode: 'WINDOW_BLUR_BRIEF',
      category: 'stealth-overlay',
      severity: 'warning',
      scoreDelta: 5,
      summaryText: 'เสียโฟกัสชั่วขณะ',
      evidence: { idleMs: '1200' }
    })

    db.db.prepare(`UPDATE audit_logs SET timestamp_ms = timestamp_ms + 1 WHERE seq_no = 1`).run()
    expect(logger.verifyAuditChain(roomId)).toMatchObject({ valid: false, firstTamperedSeqNo: 1 })
    db.db.prepare(`UPDATE audit_logs SET timestamp_ms = timestamp_ms - 1 WHERE seq_no = 1`).run()
    expect(logger.verifyAuditChain(roomId).valid).toBe(true)

    db.db.prepare(`UPDATE audit_logs SET host_hmac = host_hmac || 'ff' WHERE seq_no = 1`).run()
    const hmacCheck = logger.verifyAuditChain(roomId)
    expect(hmacCheck.valid).toBe(false)
    expect(hmacCheck.firstTamperedSeqNo).toBe(1)
    dispose()
  })

  it('detects a deleted row (seq gap) at the position after the gap', () => {
    const { db, logger, roomId, dispose } = makeFixture()
    logger.appendGenesis(roomId, { v: 1 }, 1_700_000_000_000)
    for (let index = 0; index < 5; index += 1) {
      logger.append(roomId, {
        studentId: 'std-01',
        eventCode: 'KIOSK_ESCAPE_ATTEMPT',
        category: 'stealth-overlay',
        severity: 'critical',
        scoreDelta: 25,
        summaryText: 'พยายามหลบหนี Kiosk',
        evidence: { attempt: String(index) }
      })
    }
    db.db.prepare(`DELETE FROM audit_logs WHERE seq_no = 2`).run()
    const verification = logger.verifyAuditChain(roomId)
    expect(verification.valid).toBe(false)
    expect(verification.firstTamperedSeqNo).toBe(3)
    expect(verification.reason).toContain('SEQ_GAP')
    dispose()
  })

  it('rejects rows appended with the wrong room audit key', () => {
    const { db, logger, roomId, dispose } = makeFixture()
    logger.appendGenesis(roomId, { v: 1 }, 1_700_000_000_000)
    const rogue = new AuditLogger(db, () => Buffer.alloc(32, 7))
    rogue.append(roomId, {
      studentId: 'std-02',
      eventCode: 'VM_ENVIRONMENT_DETECTED',
      category: 'memory-debugger',
      severity: 'warning',
      scoreDelta: 0,
      summaryText: 'VM',
      evidence: {}
    })
    const verification = logger.verifyAuditChain(roomId)
    expect(verification.valid).toBe(false)
    expect(verification.firstTamperedSeqNo).toBe(1)
    dispose()
  })

  it('lists entries per student in descending order for the timeline', () => {
    const { logger, roomId, dispose } = makeFixture()
    logger.appendGenesis(roomId, { v: 1 }, 1_700_000_000_000)
    logger.append(roomId, {
      studentId: 'std-01',
      eventCode: 'WINDOW_BLUR_BRIEF',
      category: 'stealth-overlay',
      severity: 'warning',
      scoreDelta: 5,
      summaryText: 'a',
      evidence: {}
    })
    logger.append(roomId, {
      studentId: 'std-02',
      eventCode: 'WINDOW_BLUR_BRIEF',
      category: 'stealth-overlay',
      severity: 'warning',
      scoreDelta: 5,
      summaryText: 'b',
      evidence: {}
    })
    const forStudent = logger.listEntries(roomId, { studentId: 'std-01' })
    expect(forStudent).toHaveLength(1)
    expect(forStudent[0]!.summaryText).toBe('a')
    expect(forStudent[0]!.studentId).toBe('std-01')
    dispose()
  })
})

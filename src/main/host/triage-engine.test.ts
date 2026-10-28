import { describe, it, expect } from 'vitest'
import type { DetectionEvent } from '@shared/policy-schema'
import type { AuditEntryView } from '@shared/triage'
import {
  TriageEngine,
  buildEventSummary,
  compareTriagePriority,
  resolveTriageLevel
} from './triage-engine'

let eventCounter = 0

function makeEvent(overrides: Partial<DetectionEvent> = {}): DetectionEvent {
  eventCounter += 1
  return {
    eventId: `evt-${eventCounter}`,
    code: 'BLACKLISTED_PROCESS_DETECTED',
    severity: 'critical',
    score: 45,
    detectorId: 'process-inspector',
    detail: { pid: '8812', processName: 'discord.exe' },
    occurredAtMs: 0,
    ...overrides
  }
}

function makeEntry(overrides: Partial<AuditEntryView> = {}): AuditEntryView {
  return {
    seqNo: 0,
    roomId: 'room',
    studentId: 'std-01',
    serverTimestampMs: 0,
    clientTimestampMs: null,
    eventCode: 'BLACKLISTED_PROCESS_DETECTED',
    category: 'ai-assistant',
    severity: 'critical',
    scoreDelta: 45,
    summaryText: 'เปิดโปรแกรมต้องห้าม',
    evidence: { pid: '8812', processName: 'discord.exe' },
    prevHash: '0'.repeat(64),
    entryHash: '1'.repeat(64),
    hostHmac: '',
    ...overrides
  }
}

describe('EventCorrelator (รวมเหตุการณ์ซ้ำ)', () => {
  it('merges a repeated identical event (same pid) without adding score again', () => {
    const engine = new TriageEngine({ now: () => 10_000 })
    const first = engine.ingest('std-01', makeEvent(), 1)
    expect(first.isNew).toBe(true)
    expect(first.scoreDeltaApplied).toBe(45)

    const second = engine.ingest('std-01', makeEvent({ occurredAtMs: 12_000 }), 2)
    expect(second.isNew).toBe(false)
    expect(second.scoreDeltaApplied).toBe(0)
    expect(second.alert.occurrenceCount).toBe(2)

    const view = engine.getStudentState('std-01')!
    expect(view.activeSuspicionScore).toBe(45)
    expect(view.unacknowledgedCriticalCount).toBe(1)
    expect(view.alerts).toHaveLength(1)
  })

  it('treats a new pid (process reopened) as a fresh violation with new score', () => {
    const engine = new TriageEngine({ now: () => 10_000 })
    engine.ingest('std-01', makeEvent(), 1)
    const reopened = engine.ingest(
      'std-01',
      makeEvent({ detail: { pid: '9999', processName: 'discord.exe' } }),
      2
    )
    expect(reopened.isNew).toBe(true)
    expect(reopened.scoreDeltaApplied).toBe(45)

    const view = engine.getStudentState('std-01')!
    expect(view.activeSuspicionScore).toBe(90)
    expect(view.alerts).toHaveLength(2)
  })

  it('starts a new alert when the same evidence returns after the correlation window', () => {
    let now = 10_000
    const engine = new TriageEngine({ now: () => now, correlationWindowMs: 30_000 })
    engine.ingest('std-01', makeEvent(), 1)
    now = 45_000
    const later = engine.ingest('std-01', makeEvent(), 2)
    expect(later.isNew).toBe(true)
    expect(engine.getStudentState('std-01')!.activeSuspicionScore).toBe(90)
  })

  it('keeps evidence of different students separate', () => {
    const engine = new TriageEngine({ now: () => 10_000 })
    engine.ingest('std-01', makeEvent(), 1)
    engine.ingest('std-02', makeEvent(), 2)
    expect(engine.getStudentState('std-01')!.alerts).toHaveLength(1)
    expect(engine.getStudentState('std-02')!.alerts).toHaveLength(1)
  })
})

describe('สถานะ Triage 3 ระดับ', () => {
  it('classifies critical / warning / normal per the thresholds', () => {
    expect(resolveTriageLevel(0, 0, 0)).toBe('normal')
    expect(resolveTriageLevel(10, 0, 0)).toBe('normal')
    expect(resolveTriageLevel(15, 0, 0)).toBe('warning')
    expect(resolveTriageLevel(39, 0, 0)).toBe('warning')
    expect(resolveTriageLevel(39, 0, 1)).toBe('warning') // unack warning → เฝ้าระวัง (แดงเฉพาะ unack critical)
    expect(resolveTriageLevel(5, 1, 0)).toBe('critical') // มี unack critical = แดงทันที
  })

  it('goes red on any unacknowledged critical event even with a low score', () => {
    const engine = new TriageEngine({ now: () => 10_000 })
    engine.ingest(
      'std-01',
      makeEvent({ code: 'KIOSK_ESCAPE_ATTEMPT', severity: 'critical', score: 25 }),
      1
    )
    expect(engine.getStudentState('std-01')!.triageLevel).toBe('critical')
  })

  it('clearing acknowledged alerts drops the level but confirmed violations stay pinned', () => {
    const engine = new TriageEngine({ now: () => 10_000 })
    engine.ingest('std-01', makeEvent(), 1)
    engine.ingest(
      'std-01',
      makeEvent({ code: 'WINDOW_BLUR_BRIEF', severity: 'warning', score: 5, detail: { idleMs: '900' } }),
      2
    )
    expect(engine.getStudentState('std-01')!.triageLevel).toBe('critical')

    // ตักเตือนแล้ว → คะแนนค้างถูกถอดออก ไฟกระพริบดับ
    expect(engine.acknowledgeAlerts('std-01', 'cleared')).toBe(2)
    const cleared = engine.getStudentState('std-01')!
    expect(cleared.triageLevel).toBe('normal')
    expect(cleared.activeSuspicionScore).toBe(0)
    expect(cleared.alerts.every((alert) => alert.status === 'cleared')).toBe(true)

    // เหตุการณ์ใหม่ + ยืนยันทุจริต → คะแนนยังอยู่ (ปักหมุดหลักฐาน)
    engine.ingest(
      'std-01',
      makeEvent({ detail: { pid: '1234', processName: 'cheatengine.exe' } }),
      3
    )
    engine.acknowledgeAlerts('std-01', 'confirmed')
    const confirmed = engine.getStudentState('std-01')!
    expect(confirmed.activeSuspicionScore).toBe(45)
    expect(confirmed.triageLevel).toBe('critical')
    expect(confirmed.unacknowledgedCriticalCount).toBe(0)
  })
})

describe('Priority Queue Ordering (จำลอง 20 คน)', () => {
  it('always puts CRITICAL first, then disconnected, warning, normal', () => {
    const engine = new TriageEngine({ now: () => 10_000 })
    let seq = 0
    // 20 คน: คะแนนและสถานะต่างกัน
    for (let index = 0; index < 20; index += 1) {
      const studentId = `std-${String(index).padStart(2, '0')}`
      if (index % 4 === 0) {
        // เขียว
        continue
      }
      if (index % 4 === 1) {
        // เหลือง คะแนนต่างกัน
        engine.ingest(
          studentId,
          makeEvent({
            code: 'WINDOW_BLUR_BRIEF',
            severity: 'warning',
            score: 5 + index,
            detail: { idleMs: String(index) }
          }),
          (seq += 1)
        )
      } else if (index % 4 === 2) {
        // แดง unack
        engine.ingest(studentId, makeEvent({ detail: { pid: String(index) } }), (seq += 1))
      } else {
        // แดงแต่รับทราบแล้ว (คะแนนค้าง 0) — ควรอยู่ล่างกลุ่ม unack
        engine.ingest(studentId, makeEvent({ detail: { pid: String(index) } }), (seq += 1))
        engine.acknowledgeAlerts(studentId, 'cleared')
      }
    }
    // คนหลุดการเชื่อมต่อ
    engine.setDisconnected('std-05', true)
    engine.setDisconnected('std-06', true)

    const sorted = engine.getSortedStudents()
    expect(sorted).toHaveLength(15)
    const levels = sorted.map((view) =>
      view.triageLevel === 'critical' ? 'critical' : view.disconnected ? 'disconnected' : view.triageLevel
    )
    const firstWarningIndex = levels.indexOf('warning')
    const firstNormalIndex = levels.lastIndexOf('normal')
    // กลุ่มแดง (unack + confirmed) อยู่บนสุด → ตามด้วยหลุดการเชื่อมต่อ → เหลือง → เขียว
    expect(levels.slice(0, firstWarningIndex).every((level) => level === 'critical' || level === 'disconnected')).toBe(true)
    expect(levels.slice(firstWarningIndex, firstNormalIndex + 1).every((level) => level !== 'critical')).toBe(true)

    // ในกลุ่มแดง unack มากสุดขึ้นก่อน และทุกคน unack=0 ต้องอยู่หลังคน unack>0
    const criticalGroup = sorted.filter((view) => view.triageLevel === 'critical')
    const unackCounts = criticalGroup.map((view) => view.unacknowledgedCriticalCount)
    const firstZero = unackCounts.lastIndexOf(0)
    if (firstZero !== -1) {
      expect(unackCounts.slice(0, firstZero).every((count) => count > 0)).toBe(true)
    }
  })

  it('sorts normal students by student id', () => {
    const engine = new TriageEngine({ now: () => 10_000 })
    for (const id of ['std-03', 'std-01', 'std-02']) {
      engine.ingest(
        id,
        makeEvent({ code: 'WINDOW_BLUR_BRIEF', severity: 'warning', score: 1, detail: {} }),
        1
      )
      engine.acknowledgeAlerts(id, 'cleared')
    }
    const sorted = engine.getSortedStudents()
    expect(sorted.map((view) => view.studentId)).toEqual(['std-01', 'std-02', 'std-03'])
  })

  it('orders ties deterministically via compareTriagePriority (equal ids impossible, score desc)', () => {
    const a = makeView('a', 70, 1, false)
    const b = makeView('b', 90, 1, false)
    expect(compareTriagePriority(a, b)).toBeGreaterThan(0)
    expect(compareTriagePriority(b, a)).toBeLessThan(0)
    expect(compareTriagePriority(a, a)).toBe(0)
  })
})

describe('rebuildFromEntries (เล่นซ้ำ chain)', () => {
  it('restores scores and clears acknowledged alerts in order', () => {
    const engine = new TriageEngine({ now: () => 10_000 })
    engine.rebuildFromEntries([
      makeEntry({ seqNo: 0, eventCode: 'ROOM_CREATED', studentId: 'HOST', category: 'lifecycle', severity: 'normal', scoreDelta: 0 }),
      makeEntry({ seqNo: 1, studentId: 'std-01' }),
      makeEntry({ seqNo: 2, studentId: 'std-01', evidence: { pid: '9999' } }),
      makeEntry({
        seqNo: 3,
        eventCode: 'PROCTOR_ACKNOWLEDGED_ALERT',
        studentId: 'HOST',
        category: 'proctor',
        severity: 'normal',
        scoreDelta: 0,
        summaryText: 'ตรวจแล้ว',
        evidence: { targetStudentId: 'std-01' }
      })
    ])
    const view = engine.getStudentState('std-01')!
    expect(view.activeSuspicionScore).toBe(0)
    expect(view.triageLevel).toBe('normal')
    expect(view.alerts.every((alert) => alert.status === 'cleared')).toBe(true)
  })
})

describe('buildEventSummary', () => {
  it('writes human-readable Thai summaries for known codes', () => {
    expect(
      buildEventSummary(
        makeEvent({
          code: 'DISGUISED_PROCESS_DETECTED',
          detail: { displayName: 'Cheat Engine.exe', actualName: 'wordpad.exe' }
        })
      )
    ).toContain('เปลี่ยนชื่อไฟล์แอบรัน: Cheat Engine.exe (ในชื่อ wordpad.exe)')
    expect(
      buildEventSummary(makeEvent({ code: 'FORBIDDEN_DNS_QUERY_DETECTED', detail: { domain: 'api.openai.com' } }))
    ).toContain('api.openai.com')
    expect(
      buildEventSummary(
        makeEvent({
          code: 'WINDOW_BLUR_PROLONGED',
          severity: 'warning',
          detail: { durationMs: '4200' }
        })
      )
    ).toContain('เสียโฟกัส 4.2 วินาที')
  })
})

function makeView(
  studentId: string,
  score: number,
  unackCritical: number,
  disconnected: boolean
): Parameters<typeof compareTriagePriority>[0] {
  return {
    studentId,
    activeSuspicionScore: score,
    unacknowledgedCriticalCount: unackCritical,
    unacknowledgedWarningCount: 0,
    triageLevel: resolveTriageLevel(score, unackCritical, 0),
    disconnected,
    frozen: false,
    lastEventAtMs: null,
    latestSummary: null,
    alerts: []
  }
}

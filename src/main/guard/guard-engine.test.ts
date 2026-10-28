import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  buildDefaultPolicy,
  DetectionPolicyBodySchema,
  SignedDetectionPolicySchema,
  DetectionEventSchema,
  DetectionEventCatalog,
  type DetectionEvent
} from '@shared/policy-schema'
import { signPolicy, verifySignedPolicy, canonicalPolicyBytes } from './policy-signing'
import { GuardEventPayloadSchema, PolicyUpdatePayloadSchema, NetMsgType } from '@shared/protocol-schema'
import { GuardEngine } from './guard-engine'

describe('SignedDetectionPolicy schema + signing', () => {
  it('buildDefaultPolicy ผ่าน schema ทุกโหมด', () => {
    for (const mode of ['closed', 'in-app-docs', 'external-tools'] as const) {
      expect(DetectionPolicyBodySchema.safeParse(buildDefaultPolicy(mode)).success).toBe(true)
    }
  })

  it('โหมด closed ต้องมีกฎ unauthorized-browser / โหมดอื่นไม่มี', () => {
    const closed = buildDefaultPolicy('closed')
    const docs = buildDefaultPolicy('in-app-docs')
    expect(closed.rules.some((r) => r.category === 'unauthorized-browser')).toBe(true)
    expect(docs.rules.some((r) => r.category === 'unauthorized-browser')).toBe(false)
  })

  it('เซ็นแล้วตรวจด้วยคีย์เดียวกันผ่าน / คีย์อื่นไม่ผ่าน', () => {
    const body = buildDefaultPolicy('closed')
    const keyA = randomBytes(32)
    const keyB = randomBytes(32)
    const signed = signPolicy(body, keyA)
    expect(SignedDetectionPolicySchema.safeParse(signed).success).toBe(true)
    expect(verifySignedPolicy(signed, keyA)).toBe(true)
    expect(verifySignedPolicy(signed, keyB)).toBe(false)
  })

  it('แก้ body หลังเซ็น (ลด rule ออก) ต้องตรวจไม่ผ่าน', () => {
    const body = buildDefaultPolicy('closed')
    const key = randomBytes(32)
    const signed = signPolicy(body, key)
    const tampered = {
      ...signed,
      body: { ...signed.body, rules: signed.body.rules.slice(1) }
    }
    expect(verifySignedPolicy(tampered, key)).toBe(false)
  })

  it('canonical bytes เป็น deterministic (เซ็นซ้ำได้ผลเดิม)', () => {
    const body = buildDefaultPolicy('external-tools')
    expect(canonicalPolicyBytes(body).equals(canonicalPolicyBytes(body))).toBe(true)
  })
})

describe('protocol payloads (GUARD_EVENT / POLICY_UPDATE)', () => {
  it('GuardEventPayloadSchema รับ event ที่ถูกต้อง', () => {
    const event = {
      eventId: 'E-1',
      code: 'FORBIDDEN_DNS_QUERY_DETECTED',
      severity: 'critical',
      score: 45,
      detectorId: 'network-inspector',
      detail: { domain: 'api.openai.com' },
      occurredAtMs: 1_000
    }
    const parsed = GuardEventPayloadSchema.safeParse({ events: [event] })
    expect(parsed.success).toBe(true)
    expect(NetMsgType.guardEvent).toBe('GUARD_EVENT')
    expect(NetMsgType.policyUpdate).toBe('POLICY_UPDATE')
  })

  it('event code ที่ไม่อยู่ในแคตตาล็อกถูกปฏิเสธ', () => {
    const parsed = DetectionEventSchema.safeParse({
      eventId: 'E-2',
      code: 'NOT_A_REAL_CODE',
      severity: 'critical',
      score: 1,
      detectorId: 'x',
      detail: {},
      occurredAtMs: 1
    })
    expect(parsed.success).toBe(false)
  })

  it('PolicyUpdatePayloadSchema รับ signed policy', () => {
    const signed = signPolicy(buildDefaultPolicy('closed'), randomBytes(32))
    expect(PolicyUpdatePayloadSchema.safeParse({ policy: signed }).success).toBe(true)
  })
})

describe('GuardEngine.applyPolicy', () => {
  function makeEngine(events: DetectionEvent[]): GuardEngine {
    return new GuardEngine({
      sendToHost: () => {},
      getExamBounds: () => null,
      getHostIp: () => null,
      getLocalProxyPort: () => 0,
      now: () => 1_000_000
    })
    // events วัดผ่าน sendToHost (GUARD_EVENT) ไม่ใช่ emit ตรง — เก็บไว้ตรวจด้วย
    void events
  }

  it('นโยบายลายเซ็นถูกต้อง → รับใช้ (และเริ่ม scheduler)', () => {
    const engine = makeEngine([])
    const key = randomBytes(32)
    const signed = signPolicy(buildDefaultPolicy('closed'), key)
    expect(engine.applyPolicy(signed, key, true)).toBe(true)
    expect(engine.currentPolicy?.policyId).toBe('default-closed')
    engine.stop()
  })

  it('ลายเซ็นปลอม → ปฏิเสธและไม่เริ่มตรวจจับ', () => {
    const engine = makeEngine([])
    const key = randomBytes(32)
    const signed = signPolicy(buildDefaultPolicy('closed'), key)
    const forged = randomBytes(32)
    expect(engine.applyPolicy(signed, forged, true)).toBe(false)
    expect(engine.currentPolicy).toBeNull()
    engine.stop()
  })

  it('แก้ body หลังเซ็น → ปฏิเสธ', () => {
    const engine = makeEngine([])
    const key = randomBytes(32)
    const signed = signPolicy(buildDefaultPolicy('closed'), key)
    signed.body.rules = [] // พยายามล้าง blacklist ระหว่างทาง
    expect(engine.applyPolicy(signed, key, true)).toBe(false)
    engine.stop()
  })
})

describe('DetectionEventCatalog ครบตามแผน Phase 3a', () => {
  it('รหัสเหตุการณ์สำคัญมีครบและคะแนนตรงตาราง', () => {
    expect(DetectionEventCatalog.CAPTURE_EVADING_WINDOW_DETECTED.score).toBe(80)
    expect(DetectionEventCatalog.DISGUISED_PROCESS_DETECTED.score).toBe(70)
    expect(DetectionEventCatalog.BLACKLISTED_PROCESS_DETECTED.score).toBe(45)
    expect(DetectionEventCatalog.FORBIDDEN_DNS_QUERY_DETECTED.score).toBe(45)
    expect(DetectionEventCatalog.EXTERNAL_CLIPBOARD_INJECTION.score).toBe(40)
    expect(DetectionEventCatalog.ABNORMAL_TYPING_PATTERN.severity).toBe('warning')
    expect(DetectionEventCatalog.WINDOW_BLUR_BRIEF.score).toBe(5)
  })
})

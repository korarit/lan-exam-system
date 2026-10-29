import { describe, expect, it } from 'vitest'
import {
  diffDnsCache,
  diffNetworkInterfaces,
  matchForbiddenDomain,
  isLoopback,
  NetworkInspector
} from './network-inspector'
import type { DetectionEvent, DetectionPolicyBody } from '@shared/policy-schema'
import { buildDefaultPolicy, DetectionPolicyBodySchema } from '@shared/policy-schema'

const policy: DetectionPolicyBody = DetectionPolicyBodySchema.parse(buildDefaultPolicy('closed'))

describe('diffDnsCache — OS DNS Resolver Cache Diffing', () => {
  const baseline = new Set(['example.com', 'microsoft.com', 'steamcontent.com'])

  it('โดเมน AI โผล่ใหม่ระหว่างสอบ → FORBIDDEN_DNS_QUERY_DETECTED ทันที', () => {
    const events = diffDnsCache(baseline, [
      'example.com',
      'api.openai.com',
      'claude.ai'
    ], policy)
    const codes = events.map((e) => e.code)
    expect(codes).toContain('FORBIDDEN_DNS_QUERY_DETECTED')
    const domains = events.map((e) => e.detail.domain)
    expect(domains).toContain('api.openai.com')
    expect(domains).toContain('claude.ai')
  })

  it('โดเมนใหม่ที่ไม่อนุมัติ (default-deny) → UNAUTHORIZED_DOMAIN_DETECTED', () => {
    const events = diffDnsCache(baseline, ['cdn.example.net'], policy)
    expect(events).toHaveLength(1)
    expect(events[0]!.code).toBe('UNAUTHORIZED_DOMAIN_DETECTED')
    expect(events[0]!.detail.domain).toBe('cdn.example.net')
    expect(events[0]!.detail.enforcement).toBe('warn')
  })

  it('อยู่ใน allowedDomains (รวม subdomain ลูก) → ไม่ฟ้อง', () => {
    const events = diffDnsCache(baseline, ['docs.exam.local', 'cdn.docs.exam.local', 'ab.chatgpt.com'], {
      ...policy,
      allowedDomains: ['docs.exam.local']
    })
    const domains = events.map((e) => e.detail.domain)
    expect(domains).not.toContain('docs.exam.local')
    expect(domains).not.toContain('cdn.docs.exam.local')
    // โดเมนต้องห้ามยังฟ้องด้วยรหัสเดิม (ชนะ default-deny)
    expect(domains).toContain('ab.chatgpt.com')
  })

  it('subdomain ของโดเมนต้องห้ามก็ติด (chat.openai.com)', () => {
    const events = diffDnsCache(baseline, ['chatgpt.com', 'ab.chatgpt.com'], policy)
    expect(events.filter((e) => e.detail.domain === 'ab.chatgpt.com')).toHaveLength(1)
  })

  it('อยู่ใน allowedDomains → ไม่ฟ้อง', () => {
    const events = diffDnsCache(baseline, ['docs.exam.local'], {
      ...policy,
      forbiddenDomains: ['docs.exam.local'],
      allowedDomains: ['docs.exam.local']
    })
    expect(events).toHaveLength(0)
  })
})

describe('matchForbiddenDomain', () => {
  it('ตรงเป๊ะ / subdomain / ไม่ตรง', () => {
    expect(matchForbiddenDomain('api.openai.com', ['api.openai.com'], [])).toBe('api.openai.com')
    expect(matchForbiddenDomain('a.b.api.openai.com', ['api.openai.com'], [])).toBe('api.openai.com')
    expect(matchForbiddenDomain('notopenai.com', ['api.openai.com'], [])).toBeNull()
    expect(matchForbiddenDomain('evil-api.openai.com.evil.net', ['api.openai.com'], [])).toBeNull()
  })
})

describe('diffNetworkInterfaces — VPN/Tunnel ใหม่', () => {
  it('interface WireGuard ใหม่ต้องถูกตรวจพบ', () => {
    const baseline = new Set(['ethernet', 'wifi'])
    const found = diffNetworkInterfaces(baseline, ['Ethernet', 'Wi-Fi', 'WireGuard Tunnel', 'Loopback Pseudo'])
    expect(found).toEqual(['WireGuard Tunnel'])
  })

  it('interface เดิมที่อยู่แล้วตั้งแต่ก่อนเริ่มสอบไม่ถูกฟ้อง', () => {
    const baseline = new Set(['ethernet', 'vethernet (default switch)'])
    const found = diffNetworkInterfaces(baseline, ['Ethernet', 'vEthernet (Default Switch)'])
    expect(found).toEqual([])
  })
})

describe('isLoopback', () => {
  it('ที่อยู่วนกลับ/ยังไม่ระบุ ไม่ถือเป็นการออกนอก', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('0.0.0.0')).toBe(true)
    expect(isLoopback('192.168.1.50')).toBe(false)
  })
})

describe('NetworkInspector.scanOnce — mode-aware socket check', () => {
  function makeInspector(
    mode: 'closed' | 'in-app-docs' | 'external-tools',
    sockets: Array<{ pid: number; processName: string; peerAddress: string; peerPort: number; state: string }>,
    getHostIp: () => string | null
  ): { inspector: NetworkInspector; events: DetectionEvent[] } {
    const events: DetectionEvent[] = []
    const inspector = new NetworkInspector({
      getPolicy: () => ({ ...policy, examMode: mode }),
      getHostIp,
      getLocalProxyPort: () => 0,
      emit: (e) => events.push(e),
      listDnsCache: async () => [],
      listSockets: async () =>
        sockets.map((s) => ({
          ...s,
          protocol: 'TCP',
          localAddress: '192.168.1.10',
          localPort: 51_000
        })),
      now: () => 1_000_000
    })
    inspector.start() // baseline ว่าง → DNS diff ข้าม (ยังไม่มี baseline)
    return { inspector, events }
  }

  it('Mode closed: ต่อออกนอกโดยไม่ผ่านเครื่องแม่ → DIRECT_SOCKET_PROXY_BYPASS', async () => {
    const { inspector, events } = makeInspector(
      'closed',
      [
        { pid: 10, processName: 'python.exe', peerAddress: '104.18.7.9', peerPort: 443, state: 'ESTABLISHED' },
        { pid: 11, processName: 'electron.exe', peerAddress: '192.168.1.1', peerPort: 33445, state: 'ESTABLISHED' }
      ],
      () => '192.168.1.1' // การต่อไปเครื่องแม่ยกเว้นเสมอ
    )
    const produced = await inspector.scanOnce()
    expect(produced).toHaveLength(1)
    expect(produced[0]!.detail.processName).toBe('python.exe')
    expect(events).toHaveLength(1)
  })

  it('Mode closed: การต่อไปที่เครื่องแม่ (hostIp) ต้องไม่ถูกฟ้อง', async () => {
    const { inspector } = makeInspector(
      'closed',
      [{ pid: 11, processName: 'electron.exe', peerAddress: '192.168.1.1', peerPort: 33445, state: 'ESTABLISHED' }],
      () => '192.168.1.1'
    )
    const produced = await inspector.scanOnce()
    expect(produced).toHaveLength(0)
  })

  it('Mode external-tools: ต่อตรงเข้า 443 ข้างนอก (ไม่ผ่าน local proxy) → ฟ้อง', async () => {
    const { inspector } = makeInspector(
      'external-tools',
      [{ pid: 20, processName: 'code.exe', peerAddress: '140.82.112.3', peerPort: 443, state: 'ESTABLISHED' }],
      () => null
    )
    const produced = await inspector.scanOnce()
    expect(produced.some((e) => e.code === 'DIRECT_SOCKET_PROXY_BYPASS')).toBe(true)
  })
})

describe('NetworkInspector + code-ide sandbox (Phase 9.5)', () => {
  function makeSandboxInspector(
    sockets: Array<{ pid: number; processName: string; peerAddress: string; peerPort: number; state: string }>,
    authorizedPids: number[]
  ): { inspector: NetworkInspector; events: DetectionEvent[] } {
    const events: DetectionEvent[] = []
    const inspector = new NetworkInspector({
      getPolicy: () => ({ ...policy, examMode: 'closed' as const }),
      getHostIp: () => null,
      getLocalProxyPort: () => 0,
      isAuthorizedPid: (pid) => authorizedPids.includes(pid),
      emit: (e) => events.push(e),
      listDnsCache: async () => [],
      listSockets: async () =>
        sockets.map((s) => ({
          ...s,
          protocol: 'TCP',
          localAddress: '192.168.1.10',
          localPort: 51_000
        })),
      now: () => 1_000_000
    })
    inspector.start()
    return { inspector, events }
  }

  it('โปรเซสลูกของ sandbox ยิงเน็ตออกนอก → STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL (ไม่ใช่รหัส generic)', async () => {
    const { inspector, events } = makeSandboxInspector(
      [{ pid: 777, processName: 'python.exe', peerAddress: '104.18.7.9', peerPort: 443, state: 'ESTABLISHED' }],
      [777]
    )
    const produced = await inspector.scanOnce()
    expect(produced).toHaveLength(1)
    expect(produced[0]!.code).toBe('STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL')
    expect(produced[0]!.severity).toBe('critical')
    expect(produced[0]!.detail.pid).toBe('777')
    expect(events).toHaveLength(1)
  })

  it('โปรเซสอื่น (ไม่ใช่ลูก sandbox) ยังฟ้องรหัสเดิม DIRECT_SOCKET_PROXY_BYPASS', async () => {
    const { inspector } = makeSandboxInspector(
      [{ pid: 10, processName: 'curl.exe', peerAddress: '104.18.7.9', peerPort: 443, state: 'ESTABLISHED' }],
      [777]
    )
    const produced = await inspector.scanOnce()
    expect(produced.some((e) => e.code === 'DIRECT_SOCKET_PROXY_BYPASS')).toBe(true)
    expect(produced.some((e) => e.code === 'STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL')).toBe(false)
  })

  it('โปรเซสลูกของ sandbox ที่คุยแค่ loopback → ไม่ฟ้อง', async () => {
    const { inspector } = makeSandboxInspector(
      [{ pid: 777, processName: 'node.exe', peerAddress: '127.0.0.1', peerPort: 49152, state: 'ESTABLISHED' }],
      [777]
    )
    const produced = await inspector.scanOnce()
    expect(produced).toHaveLength(0)
  })
})

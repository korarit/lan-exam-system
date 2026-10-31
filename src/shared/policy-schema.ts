import { z } from 'zod'

/* ============================================================
 * Deep Cheat Detection Policy (Phase 3a)
 * - กติกาตรวจจับทั้งหมดส่งจากเครื่องแม่แบบ "เซ็นลายเซ็น" ตอนเข้าห้อง
 *   (แนบ HMAC ที่คำนวณจาก session key — ตรวจที่ฝั่งนักเรียนก่อนใช้)
 * - ห้ามฝัง blacklist ตายตัวใน repo — โค้ดเก็บเฉพาะ matcher engine
 * ============================================================ */

export const DetectionCategorySchema = z.enum([
  'ai-assistant', // ChatGPT app, Claude, Copilot, Cursor, Windsurf, Ollama, LM Studio
  'stealth-overlay', // Cluely, Interview Coder, Overwolf, transparent overlays
  'remote-control', // AnyDesk, TeamViewer, RustDesk, Parsec, Chrome Remote Desktop
  'screen-recorder', // OBS, ShareX, Bandicam, Discord, Zoom, Teams
  'memory-debugger', // Cheat Engine, x64dbg, WinDbg, IDA, Ghidra, Frida
  'network-tunnel', // ngrok, cloudflared, tailscale, wireguard, openvpn, clash
  'automation-macro', // AutoHotkey, AutoIt, TinyTask, Power Automate
  'unauthorized-browser', // Chrome, Edge, Firefox, ... (เมื่อห้ามเปิดเบราว์เซอร์นอก)
  'app-tamper', // ไฟล์แอปถูกแก้ / manifest ผิด / โปรแกรมที่ลายเซ็นไม่ผ่าน (Phase 4)
  'kiosk-escape' // กดปุ่มลัดระดับระบบ (Alt+Tab, Win key, Alt+F4) — ดักโดย native hook (Phase 4)
])
export type DetectionCategory = z.infer<typeof DetectionCategorySchema>

export const ProcessSignatureRuleSchema = z
  .object({
    ruleId: z.string().min(1).max(80),
    category: DetectionCategorySchema,
    severity: z.enum(['warning', 'critical']),
    scoreWeight: z.number().int().positive(),
    matchers: z
      .object({
        exeNames: z.array(z.string().min(1).max(120)).max(64).optional(),
        originalFilenames: z.array(z.string().min(1).max(120)).max(64).optional(),
        productNames: z.array(z.string().min(1).max(120)).max(64).optional(),
        bundleIds: z.array(z.string().min(1).max(160)).max(64).optional(),
        cmdSubstrings: z.array(z.string().min(1).max(160)).max(64).optional(),
        windowTitles: z.array(z.string().min(1).max(160)).max(64).optional(),
        localPorts: z.array(z.number().int().min(1).max(65535)).max(64).optional(),
        sha256Hashes: z.array(z.string().length(64)).max(64).optional()
      })
      .strict()
  })
  .strict()
export type ProcessSignatureRule = z.infer<typeof ProcessSignatureRuleSchema>

export const PolicySchedulerConfigSchema = z
  .object({
    minPollIntervalMs: z.number().int().min(200).max(60_000),
    maxPollIntervalMs: z.number().int().min(200).max(120_000)
  })
  .strict()
export type PolicySchedulerConfig = z.infer<typeof PolicySchedulerConfigSchema>

/**
 * โปรเซสที่ครูอนุมัติให้รันได้ (ต่อห้อง) — ตรวจก่อนเทียบ blacklist
 * - exeNames: ชื่อไฟล์ตรง (ตัวพิมพ์เล็ก/ใหญ่ไม่สำคัญ)
 * - pathPrefixes: path ขึ้นต้นด้วยค่าที่ระบุ (ใช้ '/' หรือ '\' ก็ได้ — normalize ก่อนเทียบ)
 * - sha256Hashes: hash ของไฟล์ที่ยอมรับ (ใช้เมื่อ path เปลี่ยนไม่ได้)
 */
export const ProcessAllowlistEntrySchema = z
  .object({
    exeNames: z.array(z.string().min(1).max(120)).max(64).optional(),
    pathPrefixes: z.array(z.string().min(1).max(400)).max(64).optional(),
    sha256Hashes: z.array(z.string().length(64)).max(64).optional()
  })
  .strict()
export type ProcessAllowlistEntry = z.infer<typeof ProcessAllowlistEntrySchema>

/** โดเมนต้องห้ามเริ่มต้น (ฝั่งเครื่องแม่ — UI แสดง badge เตือนเมื่อรายการที่ record ชนกัน) */
export const DEFAULT_FORBIDDEN_DOMAINS = [
  'api.openai.com',
  'chatgpt.com',
  'claude.ai',
  'api.anthropic.com',
  'api.deepseek.com',
  'generativelanguage.googleapis.com',
  'gemini.google.com',
  'copilot.microsoft.com',
  'www.bing.com',
  'duckduckgo.com',
  'perplexity.ai',
  'grok.com',
  'ollama.com'
]

/** พฤติกรรมเมื่อเว็บของนักเรียนพยายามเข้าโดเมนที่ไม่อนุมัติ (Phase 3a-plus) */
export const DomainEnforcementSchema = z.enum(['warn', 'block'])
export type DomainEnforcement = z.infer<typeof DomainEnforcementSchema>

/** โครงนโยบายตรวจจับทั้งหมด (เครื่องแม่ส่งให้นักเรียนตอน join / ระหว่างสอบได้) */
export const DetectionPolicyBodySchema = z
  .object({
    policyId: z.string().min(1).max(80),
    version: z.number().int().nonnegative(),
    /** เวลาออกนโยบายตามนาฬิกาเครื่องแม่ (ผู้รับใช้เป็นข้อมูล ไม่ตัดสิน) */
    issuedAtMs: z.number().int().nonnegative(),
    /** หมดอายุ (0 = ไม่มีวันหมดอายุ) */
    expiresAtMs: z.number().int().nonnegative(),
    examMode: z.enum(['closed', 'in-app-docs', 'external-tools']),
    scheduler: PolicySchedulerConfigSchema,
    rules: z.array(ProcessSignatureRuleSchema).max(512),
    /** โดเมนต้องห้าม (ตรวจกับ OS DNS cache) เช่น api.openai.com */
    forbiddenDomains: z.array(z.string().min(3).max(200)).max(512),
    /** โดเมนยอมรับได้ (ไม่ฟ้อง) เช่น แพ็กเกจเอกสารของห้องสอบ */
    allowedDomains: z.array(z.string().min(3).max(200)).max(512),
    /** รายการโปรเซสที่ครูอนุมัติ (ยกเว้นจาก blacklist/heuristic) */
    processAllowlist: z.array(ProcessAllowlistEntrySchema).max(256).default([]),
    /** พฤติกรรมเมื่อเว็บของนักเรียนพยายามเข้าโดเมนที่ไม่อนุมัติ (default: warn) */
    domainEnforcement: DomainEnforcementSchema.default('warn')
  })
  .strict()
export type DetectionPolicyBody = z.infer<typeof DetectionPolicyBodySchema>

/** นโยบายพร้อมลายเซ็น (HMAC-SHA256 ครอบ canonical body — ใช้ session key ต่อห้อง) */
export const SignedDetectionPolicySchema = z
  .object({
    body: DetectionPolicyBodySchema,
    /** HMAC-SHA256 ของ canonical body (base64) — ตรวจก่อนใช้นโยบายเสมอ */
    signature: z.string().min(40).max(120)
  })
  .strict()
export type SignedDetectionPolicy = z.infer<typeof SignedDetectionPolicySchema>

/* ============================================================
 * Detection Event (หลักฐานที่เครื่องนักเรียนส่งกลับเครื่องแม่)
 * ============================================================ */

export const DetectionSeveritySchema = z.enum(['warning', 'critical'])
export type DetectionSeverity = z.infer<typeof DetectionSeveritySchema>

/**
 * แคตตาล็อกเหตุการณ์ตามแผน Phase 3a — score เป็นค่าตั้งต้น
 * (นโยบายจริงจากเครื่องแม่ถ่วงน้ำหนักทับได้ใน Phase 3b)
 */
export const DetectionEventCatalog = {
  CAPTURE_EVADING_WINDOW_DETECTED: { category: 'stealth-overlay', severity: 'critical', score: 80 },
  FOREIGN_MODULE_INJECTED: { category: 'memory-debugger', severity: 'critical', score: 80 },
  DEBUGGER_ATTACHED: { category: 'memory-debugger', severity: 'critical', score: 80 },
  DISGUISED_PROCESS_DETECTED: { category: 'memory-debugger', severity: 'critical', score: 70 },
  UNLISTED_PROCESS_DETECTED: { category: 'automation-macro', severity: 'warning', score: 20 },
  SYNTHETIC_INPUT_INJECTED: { category: 'automation-macro', severity: 'critical', score: 60 },
  BLACKLISTED_PROCESS_DETECTED: { category: 'ai-assistant', severity: 'critical', score: 45 },
  FORBIDDEN_DNS_QUERY_DETECTED: { category: 'network-tunnel', severity: 'critical', score: 45 },
  DIRECT_SOCKET_PROXY_BYPASS: { category: 'network-tunnel', severity: 'critical', score: 40 },
  EXTERNAL_CLIPBOARD_INJECTION: { category: 'automation-macro', severity: 'critical', score: 40 },
  TOPMOST_OVERLAY_WINDOW_DETECTED: { category: 'stealth-overlay', severity: 'critical', score: 40 },
  LARGE_TOPMOST_WINDOW_DETECTED: { category: 'stealth-overlay', severity: 'warning', score: 15 },
  KIOSK_ESCAPE_ATTEMPT: { category: 'stealth-overlay', severity: 'critical', score: 25 },
  UNAUTHORIZED_DOMAIN_DETECTED: { category: 'network-tunnel', severity: 'critical', score: 25 },
  WINDOW_BLUR_PROLONGED: { category: 'stealth-overlay', severity: 'warning', score: 20 },
  ABNORMAL_TYPING_PATTERN: { category: 'automation-macro', severity: 'warning', score: 15 },
  DISPLAY_CONFIG_CHANGED: { category: 'stealth-overlay', severity: 'warning', score: 15 },
  WINDOW_BLUR_BRIEF: { category: 'stealth-overlay', severity: 'warning', score: 5 },
  GUARD_THREAD_STALLED: { category: 'memory-debugger', severity: 'critical', score: 30 },
  /** detector ทำงานไม่ได้ต่อเนื่อง (คำสั่ง OS ล้ม/ถูกจำกัด) — แยกจาก "ตรวจแล้วไม่พบ" */
  GUARD_PROBE_FAILED: { category: 'memory-debugger', severity: 'warning', score: 20 },
  NETWORK_TUNNEL_OR_PROXY_TAMPER: { category: 'network-tunnel', severity: 'critical', score: 40 },
  SUSPICIOUS_COMPUTE_SPIKE: { category: 'ai-assistant', severity: 'warning', score: 10 },
  PID_BURST_ANOMALY: { category: 'automation-macro', severity: 'warning', score: 10 },
  VM_ENVIRONMENT_DETECTED: { category: 'memory-debugger', severity: 'warning', score: 15 },
  REMOTE_SESSION_SUSPECTED: { category: 'remote-control', severity: 'warning', score: 15 },
  /* ---------- Phase 4: Attestation & Native Guard ---------- */
  ATTESTATION_VERIFICATION_FAILED: { category: 'app-tamper', severity: 'critical', score: 80 },
  BLOCKED_SYSTEM_SHORTCUT: { category: 'kiosk-escape', severity: 'warning', score: 15 },
  /* ---------- Phase 5: Mode 2 docs viewer & Mode 3 external tools ---------- */
  /* ---------- Phase 9: code-ide sandbox (โปรเซสลูกที่อนุญาตยิงออกนอก loopback) ---------- */
  STUDENT_CODE_UNAUTHORIZED_NETWORK_CALL: { category: 'network-tunnel', severity: 'critical', score: 60 },
  UNAUTHORIZED_DOCS_URL_ATTEMPT: { category: 'network-tunnel', severity: 'critical', score: 40 },
  PROXY_DOMAIN_VIOLATION: { category: 'network-tunnel', severity: 'critical', score: 40 },
  /* R5: นักเรียนกดปิดแผงเอกสารเอง — event ระดับ warning ให้ครูเห็นใน triage */
  DOCS_PANEL_TOGGLED: { category: 'stealth-overlay', severity: 'warning', score: 5 },
  DIRECT_IP_PROXY_ATTEMPT: { category: 'network-tunnel', severity: 'critical', score: 40 },
  VSCODE_PROFILE_TAMPERED: { category: 'app-tamper', severity: 'critical', score: 50 },
  UNAUTHORIZED_IDE_DETECTED: { category: 'ai-assistant', severity: 'critical', score: 50 }
} as const satisfies Record<string, { category: DetectionCategory; severity: DetectionSeverity; score: number }>

export type DetectionEventCode = keyof typeof DetectionEventCatalog

export const DetectionEventCodeSchema = z.enum(
  Object.keys(DetectionEventCatalog) as [DetectionEventCode, ...DetectionEventCode[]]
)
export type DetectionEventCodeValue = z.infer<typeof DetectionEventCodeSchema>

export const DetectionEventSchema = z
  .object({
    eventId: z.string().min(1).max(64),
    code: DetectionEventCodeSchema,
    severity: DetectionSeveritySchema,
    score: z.number().int().nonnegative(),
    /** id ของ detector ที่ตรวจพบ (เช่น process-inspector) */
    detectorId: z.string().min(1).max(60),
    /** หลักฐานประกอบ เช่น processName, domain, windowTitle (ตัดให้สั้น) */
    detail: z.record(z.string(), z.string().max(400)),
    occurredAtMs: z.number().int().nonnegative()
  })
  .strict()
export type DetectionEvent = z.infer<typeof DetectionEventSchema>

export const MAX_EVENTS_PER_REPORT = 20

/* ============================================================
 * Default policy (ฝั่งเครื่องแม่ — ใช้ก่อนมี UI ตั้งค่าละเอียด)
 * เจตนา: เป็นเพียงจุดเริ่ม รายการจริงควรมาจากการตั้งค่าของครู
 * ============================================================ */

function rule(
  ruleId: string,
  category: DetectionCategory,
  severity: 'warning' | 'critical',
  scoreWeight: number,
  matchers: z.infer<typeof ProcessSignatureRuleSchema>['matchers']
): ProcessSignatureRule {
  const parsed = ProcessSignatureRuleSchema.parse({ ruleId, category, severity, scoreWeight, matchers })
  return parsed
}

export function buildDefaultPolicy(examMode: 'closed' | 'in-app-docs' | 'external-tools'): DetectionPolicyBody {
  const forbiddenDomains = DEFAULT_FORBIDDEN_DOMAINS
  const rules: ProcessSignatureRule[] = [
    rule('local-ai-runtime', 'ai-assistant', 'critical', 45, {
      exeNames: [
        'ollama.exe',
        'ollama_llama_server.exe',
        'ollama app.exe',
        'llama-server.exe',
        'llama-cli.exe',
        'llama.exe',
        'lm-studio.exe',
        'jan.exe',
        'koboldcpp.exe',
        'gpt4all.exe',
        'vllm.exe',
        'litellm.exe'
      ],
      productNames: ['Ollama', 'LM Studio', 'GPT4All', 'Jan'],
      cmdSubstrings: ['llama-server', 'ollama serve', 'litellm', 'vllm serve']
    }),
    rule('ai-chat-apps', 'ai-assistant', 'critical', 45, {
      exeNames: ['chatgpt.exe', 'claude.exe', 'cursor.exe', 'windsurf.exe', 'copilot.exe'],
      productNames: ['ChatGPT', 'Claude', 'Cursor', 'Windsurf'],
      bundleIds: ['com.openai.chat', 'com.anthropic.claudefordesktop']
    }),
    rule('remote-control-tools', 'remote-control', 'critical', 45, {
      exeNames: [
        'anydesk.exe',
        'teamviewer.exe',
        'rustdesk.exe',
        'parsec.exe',
        'sunshine.exe',
        'remotedesktop.exe',
        'vnc.exe',
        'ultraviewer.exe'
      ],
      productNames: ['AnyDesk', 'TeamViewer', 'RustDesk', 'Parsec', 'UltraViewer']
    }),
    rule('stealth-overlay-cheat', 'stealth-overlay', 'critical', 80, {
      productNames: ['Cluely', 'Interview Coder'],
      exeNames: ['cluely.exe', 'interview-coder.exe']
    }),
    rule('memory-debuggers', 'memory-debugger', 'critical', 45, {
      exeNames: [
        'cheatengine-x86_64.exe',
        'cheatengine-i386.exe',
        'cheat engine.exe',
        'x64dbg.exe',
        'x32dbg.exe',
        'windbg.exe',
        'ida.exe',
        'ida64.exe',
        'ghidra.exe',
        'frida.exe',
        'processhacker.exe',
        'systeminformer.exe'
      ],
      originalFilenames: ['Cheat Engine.exe', 'x64dbg.exe', 'frida.exe', 'ProcessHacker.exe'],
      productNames: ['Cheat Engine', 'Frida', 'Process Hacker', 'System Informer']
    }),
    rule('network-tunnels', 'network-tunnel', 'critical', 45, {
      exeNames: [
        'ngrok.exe',
        'cloudflared.exe',
        'tailscaled.exe',
        'wireguard.exe',
        'openvpn.exe',
        'proxifier.exe',
        'v2ray.exe',
        'v2rayn.exe',
        'clash.exe',
        'clash-verge.exe',
        'mihomo.exe'
      ],
      productNames: ['WireGuard', 'OpenVPN', 'Proxifier', 'Cloudflare WARP']
    }),
    rule('automation-macro', 'automation-macro', 'critical', 45, {
      exeNames: ['autohotkey.exe', 'autohotkey64.exe', 'autoit.exe', 'tinytask.exe', 'mspentools.exe'],
      productNames: ['AutoHotkey', 'AutoIt', 'TinyTask']
    }),
    rule('screen-recorders', 'screen-recorder', 'warning', 20, {
      exeNames: ['obs64.exe', 'sharex.exe', 'bandicam.exe', 'camstudio.exe'],
      productNames: ['Open Broadcaster Software', 'ShareX', 'Bandicam']
    })
  ]
  if (examMode === 'closed') {
    rules.push(
      rule('unauthorized-browser-closed', 'unauthorized-browser', 'critical', 45, {
        exeNames: [
          'chrome.exe',
          'msedge.exe',
          'brave.exe',
          'firefox.exe',
          'opera.exe',
          'arc.exe',
          'vivaldi.exe',
          'chromium.exe'
        ]
      })
    )
  }
  return DetectionPolicyBodySchema.parse({
    policyId: `default-${examMode}`,
    version: 1,
    issuedAtMs: 0, // เครื่องแม่เติมเวลาจริงตอนส่ง
    expiresAtMs: 0,
    examMode,
    scheduler: { minPollIntervalMs: 1_800, maxPollIntervalMs: 4_700 },
    rules,
    forbiddenDomains,
    allowedDomains: [],
    processAllowlist: []
  })
}

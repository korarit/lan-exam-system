// Screenshot + tour-video harness: serves out/renderer, mocks window.ztExam.
// Run: node scripts/screenshots/shot.mjs
// window.__emit[channel] = array of subscribed callbacks -> harness drives events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'out', 'renderer');
const OUT = path.join(ROOT, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serve(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath.slice(1));
      if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) {
          fs.readFile(path.join(DIST, 'index.html'), (e2, d2) => {
            if (e2) { res.writeHead(404); res.end('nf'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(d2);
          });
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

// NOTE: window.ztExam assigned FIRST; every DOM touch guarded (init runs at document-start).
function mockInit(scenario) {
  const now = Date.now();
  const withRoom = scenario.withRoom === true;
  const noRoom = scenario.noRoom === true;
  const roomMode = scenario.roomMode || 'closed';
  const room = noRoom
    ? null
    : { roomId: '11111111-1111-4111-8111-111111111111', roomName: 'ห้องสอบ 401', roomPin: '482913', tcpPort: 44456, certFpShort: 'AB12CD34EF56GH78', certFingerprint: 'AB12CD34EF56GH78AB12CD34EF56GH78', mode: roomMode, enforcement: 'report-only' };
  const beacon = { magic: 'ZTEXAM_V1', roomId: '11111111-1111-4111-8111-111111111111', roomName: 'ห้องสอบ 401', hostName: 'TEACHER-PC', examMode: 'closed', tcpPort: 44456, certFpShort: 'AB12CD34EF56GH78', studentCount: 12, examStatus: 'lobby', timestamp: now, sourceIp: '192.168.1.10', lastSeenAtMs: now };
  const students = withRoom
    ? [
        { studentId: 'S001', studentName: 'เด็กชายทดสอบ หนึ่ง', online: true, focusState: 'focused', currentQuestionIndex: 2, lastSeenAtMs: now },
        { studentId: 'S002', studentName: 'เด็กหญิงทดสอบ สอง', online: true, focusState: 'unfocused', currentQuestionIndex: 1, lastSeenAtMs: now - 5000 },
        { studentId: 'S003', studentName: 'เด็กชายทดสอบ สาม', online: false, focusState: null, currentQuestionIndex: null, lastSeenAtMs: now - 60000 }
      ]
    : [];
  const summaries = withRoom
    ? [
        { studentId: 'S001', studentName: 'เด็กชายทดสอบ หนึ่ง', maxReachedCursor: 4, totalQuestions: 10, awardedPoints: 8 },
        { studentId: 'S002', studentName: 'เด็กหญิงทดสอบ สอง', maxReachedCursor: 2, totalQuestions: 10, awardedPoints: 3 }
      ]
    : [];
  const overview = {
    counts: { total: 3, critical: 1, warning: 1, disconnected: 1, normal: 1 },
    serverNowMs: now,
    students: [
      { studentId: 'S001', activeSuspicionScore: 85, unacknowledgedCriticalCount: 2, unacknowledgedWarningCount: 1, triageLevel: 'critical', disconnected: false, frozen: false, lastEventAtMs: now - 60000, latestSummary: 'สลับหน้าต่าง 5 ครั้งใน 2 นาที', alerts: [] },
      { studentId: 'S002', activeSuspicionScore: 35, unacknowledgedCriticalCount: 0, unacknowledgedWarningCount: 2, triageLevel: 'warning', disconnected: false, frozen: false, lastEventAtMs: now - 120000, latestSummary: 'พิมพ์เร็วผิดปกติ', alerts: [] },
      { studentId: 'S003', activeSuspicionScore: 0, unacknowledgedCriticalCount: 0, unacknowledgedWarningCount: 0, triageLevel: 'normal', disconnected: true, frozen: false, lastEventAtMs: null, latestSummary: null, alerts: [] }
    ]
  };
  const examState = scenario.examState || { state: 'idle', title: null, questionCount: 0, durationSeconds: 0 };
  const domains = scenario.domains === 'docs-ai'
    ? [
        { domain: 'docs.example.com', topDomain: 'docs.example.com', source: 'top-url', hits: 42, approved: true, lastSeenAtMs: now },
        { domain: 'cdn.example.net', topDomain: 'docs.example.com', source: 'script', hits: 17, approved: false, lastSeenAtMs: now - 10000 },
        { domain: 'claude.ai', topDomain: 'cdn.example.net', source: 'fetch', hits: 5, approved: false, lastSeenAtMs: now - 20000 }
      ]
    : scenario.domains === 'docs-clean'
      ? [
          { domain: 'docs.example.com', topDomain: 'docs.example.com', source: 'top-url', hits: 42, approved: true, lastSeenAtMs: now },
          { domain: 'cdn.example.net', topDomain: 'docs.example.com', source: 'script', hits: 17, approved: false, lastSeenAtMs: now - 10000 },
          { domain: 'fonts.example.org', topDomain: 'docs.example.com', source: 'stylesheet', hits: 9, approved: false, lastSeenAtMs: now - 15000 }
        ]
      : [];
  const attestation = scenario.attestationDev
    ? { devMode: true, signatureEnforced: false, platform: 'win32', trackedStudents: [] }
    : { devMode: false, signatureEnforced: true, platform: 'win32', trackedStudents: [] };

  window.__emit = {};
  const emitReg = window.__emit;
  function reg(channel, cb) {
    (emitReg[channel] = emitReg[channel] || []).push(cb);
  }

  // Fake screen thumbnail (SVG) for triage cards + screen inspector modal
  function fakeThumb() {
    try {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#0f172a"/><rect x="12" y="12" width="296" height="28" rx="4" fill="#1e293b"/><rect x="12" y="52" width="180" height="120" rx="4" fill="#1e3a5f"/><rect x="200" y="52" width="108" height="56" rx="4" fill="#134e4a"/><rect x="200" y="116" width="108" height="56" rx="4" fill="#4a1e1e"/><text x="16" y="30" font-size="11" fill="#94a3b8">Desktop S001</text></svg>`;
      return { studentId: 'S001', displayIndex: 0, displayCount: 1, mode: 'thumbnail', mimeType: 'image/svg+xml', imageBase64: btoa(unescape(encodeURIComponent(svg))), timestampMs: Date.now(), displayId: 'd0' };
    } catch { return null; }
  }

  window.ztExam = new Proxy(
    {
      getAppInfo: async () => ({ role: scenario.role || 'unselected' }),
      onRoleChanged: () => () => {},
      selectRole: async () => ({ ok: true }),
      getRoom: async () => ({ room }),
      getExamState: async () => examState,
      getStudents: async () => ({ students }),
      getSummaries: async () => ({ summaries }),
      getTriageOverview: async () => overview,
      getAttestationConfig: async () => attestation,
      setAttestationEnforce: async () => ({ ok: true }),
      gatewayInterfaces: async () => ({
        interfaces: [
          { name: 'Ethernet', address: '192.168.1.2', netmask: '255.255.255.0', cidr: '192.168.1.0/24', mac: 'AA:BB:CC:DD:EE:01' }
        ]
      }),
      gatewayStatus: async () => ({
        state: 'stopped', running: false, interfaceName: null, hostIp: null, subnetCidr: null,
        poolStart: null, poolEnd: null, leaseCount: 0, posture: null, warnings: [], lastError: null, startedAtMs: null
      }),
      gatewayLeases: async () => ({ leases: [] }),
      gatewayDnsLog: async () => ({ entries: [] }),
      gatewayStart: async () => ({
        state: 'running', running: true, interfaceName: 'Ethernet', hostIp: '192.168.1.2', subnetCidr: '192.168.1.0/24',
        poolStart: '192.168.1.100', poolEnd: '192.168.1.199', leaseCount: 0,
        posture: { ipv4Forwarding: false, ipv6Forwarding: false, icsEnabled: false, canDisable: true, changed: [], warnings: [] },
        warnings: [], lastError: null, startedAtMs: now
      }),
      gatewayStop: async () => ({
        state: 'stopped', running: false, interfaceName: null, hostIp: null, subnetCidr: null,
        poolStart: null, poolEnd: null, leaseCount: 0, posture: null, warnings: [], lastError: null, startedAtMs: null
      }),
      listRecordedDomains: async () => ({ records: domains }),
      approveDomain: async () => ({ ok: true }),
      clearRecordedDomains: async () => ({ ok: true }),
      setDomainEnforcement: async () => ({ ok: true }),
      openDocPreview: async () => ({ ok: true }),
      setStudentFreeze: async () => ({ ok: true }),
      resolveTriage: async () => ({ ok: true, affectedAlerts: 3 }),
      exportIncidentReport: async () => ({ ok: false, reason: 'CANCELLED' }),
      exportAuditBundle: async () => ({ ok: false, reason: 'CANCELLED' }),
      getStudentEvidence: async () => ({
        info: { studentId: 'S001', studentName: 'เด็กชายทดสอบ หนึ่ง', online: true, status: 'สอบอยู่ ข้อ 3/10', focusState: 'focused', joinedAtMs: now - 1800000, lastSeenAtMs: now - 3000, frozen: false, vmSuspected: false, remoteSuspected: true },
        entries: [
          { seqNo: 41, studentId: 'S001', eventCode: 'WINDOW_BLUR', severity: 'warning', summaryText: 'สลับหน้าต่างออก (ครั้งที่ 3)', scoreDelta: 10, serverTimestampMs: now - 300000, evidence: { count: 3 }, entryHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' },
          { seqNo: 42, studentId: 'S001', eventCode: 'ABNORMAL_TYPING_PATTERN', severity: 'critical', summaryText: 'จังหวะพิมพ์สม่ำเสมอผิดมนุษย์ (bot-like)', scoreDelta: 25, serverTimestampMs: now - 60000, evidence: { cv: 0.04 }, entryHash: 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5' }
        ],
        chain: { valid: true, totalEntries: 42 }
      }),
      sendProctorWarning: async () => ({ ok: true }),
      screenInspect: async () => ({ ok: true }),
      startDiscovery: async () => undefined,
      stopDiscovery: async () => undefined,
      enterKiosk: async () => undefined,
      exitKiosk: async () => undefined,
      joinRoom: async () => ({ ok: true }),
      docsToggle: async () => ({ ok: true }),
      docsNavigate: async () => ({ ok: true }),
      autosaveDraft: async () => ({ ok: true }),
      submitAnswer: async () => ({ ok: true }),
      navigate: async () => ({ ok: true }),
      moduleSend: async () => ({ ok: true }),
      sendTypingMetrics: async () => undefined,
      listSavedForms: async () => ({ forms: [] }),
      saveZtform: async () => ({ ok: false, reason: 'CANCELLED' }),
      loadZtform: async () => ({ ok: false, reason: 'CANCELLED' }),
      getFormResponses: async () => ({ kind: 'database', roomId: '11111111-1111-4111-8111-111111111111', roomName: 'ห้องสอบ 401', formTitle: 'แบบฟอร์มตัวอย่าง', form: { items: [] }, startedAtMs: null, endedAtMs: null, students: [], itemStats: [], distribution: [], summary: { mean: 0, median: 0, min: 0, max: 0, studentCount: 0, needsManualCount: 0 }, regradeHistory: [] }),
      getFormState: async () => ({ formTitle: null }),
      checkRuntimes: async () => ({ runtimes: [] }),
      getCodeSubmissions: async () => scenario.submissions === 'filled'
        ? {
            ok: true, roomId: '11111111-1111-4111-8111-111111111111', roomName: 'ห้องสอบ 401', packageTitle: 'ข้อสอบเขียนโปรแกรม ข้อที่ 1', category: 'cli-algorithm', language: 'java', questionSlug: 'q-code-1', maxPoints: 100, queue: { active: 1, pending: 1 },
            depsUnsupported: [],
            submissions: [
              { studentId: 'S001', fileCount: 4, passedCount: 2, totalCount: 3, autoPoints: 60, manualPoints: null, totalPoints: 60, maxPoints: 100, status: 'graded', blockedReason: null, submittedAtMs: now - 900000, gradedAtMs: now - 600000 },
              { studentId: 'S002', fileCount: 3, passedCount: 0, totalCount: 3, autoPoints: 0, manualPoints: null, totalPoints: 0, maxPoints: 100, status: 'blocked', blockedReason: 'VM suspected — งานถูกกักไว้รอครูตรวจสอบ', submittedAtMs: now - 800000, gradedAtMs: null },
              { studentId: 'S003', fileCount: 2, passedCount: 0, totalCount: 0, autoPoints: 0, manualPoints: null, totalPoints: 0, maxPoints: 100, status: 'grading', blockedReason: null, submittedAtMs: now - 300000, gradedAtMs: null }
            ]
          }
        : { ok: true, roomId: null, roomName: null, packageTitle: null, category: null, language: null, questionSlug: null, maxPoints: 0, queue: { active: 0, pending: 0 }, depsUnsupported: [], submissions: [] },
      getCodeWorkspaceState: async () => ({ rootPath: 'D:/ExamWorkspace/CS202_Final' }),
      getCodeSubmissionDetail: async () => ({
        ok: true, studentId: 'S001', status: 'graded', manualPoints: null, blockedReason: null,
        entries: [
          { path: 'src', kind: 'folder' },
          { path: 'src/Main.java', kind: 'file', content: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int a = sc.nextInt();\n        int b = sc.nextInt();\n        System.out.println(a + b);\n    }\n}\n' }
        ],
        starterEntries: [
          { path: 'src', kind: 'folder' },
          { path: 'src/Main.java', kind: 'file', content: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        // TODO: อ่านเลข 2 ตัวแล้วพิมพ์ผลบวก\n    }\n}\n' }
        ],
        referenceEntries: [
          { path: 'src', kind: 'folder' },
          { path: 'src/Main.java', kind: 'file', content: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        System.out.println(sc.nextInt() + sc.nextInt());\n    }\n}\n' }
        ],
        gradeResults: [
          { testId: 't1', kind: 'stdio', visibility: 'sample', points: 30, earned: 30, passed: true, note: '', durationMs: 118 },
          { testId: 't2', kind: 'stdio', visibility: 'sample', points: 30, earned: 30, passed: true, note: '', durationMs: 121 },
          { testId: 't3', kind: 'stdio', visibility: 'hidden', points: 40, earned: 0, passed: false, note: 'Wrong answer (expected 42, got 41)', durationMs: 130 }
        ]
      }),
      onEvent: (channel, cb) => {
        try {
          reg(channel, cb);
          if (channel === 'network:rooms-updated') setTimeout(() => { try { cb({ rooms: scenario.role === 'student' ? [{ magic: 'ZTEXAM_V1', roomId: '11111111-1111-4111-8111-111111111111', roomName: 'ห้องสอบ 401', hostName: 'TEACHER-PC', examMode: 'closed', tcpPort: 44456, certFpShort: 'AB12CD34EF56GH78', studentCount: 12, examStatus: 'lobby', timestamp: Date.now(), sourceIp: '192.168.1.10', lastSeenAtMs: Date.now() }] : [] }); } catch {} }, 60);
          else if (channel === 'host:students-updated') setTimeout(() => { try { cb({ students }); } catch {} }, 60);
          else if (channel === 'host:exam-summaries') setTimeout(() => { try { cb({ summaries }); } catch {} }, 60);
          else if (channel === 'host:triage-updated') setTimeout(() => { try { cb(overview); } catch {} }, 80);
          else if (channel === 'host:recorded-domains-updated') setTimeout(() => { try { cb({ records: domains }); } catch {} }, 60);
          else if (channel === 'host:screen-thumbnail' && scenario.screenThumb) setTimeout(() => { try { const t = fakeThumb(); if (t) cb(t); } catch {} }, 400);
        } catch {}
        return () => {};
      }
    },
    {
      get(t, p) {
        if (p === '__emit') return emitReg;
        if (p in t) return t[p];
        if (typeof p === 'string' && (p.startsWith('on') || p.startsWith('subscribe'))) return () => () => {};
        return async () => ({ ok: true, records: [], students: [], summaries: [], events: [], entries: [], chain: { ok: true } });
      }
    }
  );

  try { window.localStorage.setItem('zt-theme', scenario.theme || 'dark'); } catch {}
  try {
    if ((scenario.theme || 'dark') === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  } catch {}
}

// ---- payload builders (shared with page.evaluate via JSON) ----
const MCQ = { moduleId: 'stepping-runner', questionId: 'q1', cursorIndex: 2, questionCount: 10, type: 'mcq', prompt: 'จงหาค่าของ 15 × 4 + 20 ÷ 5', points: 5, allowBackNavigation: true, choices: [{ text: '64' }, { text: '68' }, { text: '60' }, { text: '72' }] };
const ESSAY = { moduleId: 'stepping-runner', questionId: 'q2', cursorIndex: 3, questionCount: 10, type: 'essay', prompt: 'จงอธิบายหลักการทำงานของ hash chain ในระบบตรวจจับการทุจริต พร้อมยกตัวอย่างว่าเหตุการณ์ใดบ้างที่ควรบันทึก', points: 10, allowBackNavigation: false };
const STARTED_CLOSED = { examTitle: 'สอบกลางภาค คณิตศาสตร์ ม.4', questionCount: 10, remainingSeconds: 3540 };
const CODE_PKG = {
  moduleId: 'code-ide',
  packageId: '22222222-2222-4222-8222-222222222222',
  title: 'ข้อสอบเขียนโปรแกรม ข้อที่ 1',
  instructions: 'จงเขียนโปรแกรมอ่านจำนวนเต็ม 2 ตัวจาก stdin แล้วพิมพ์ผลบวกออกทาง stdout',
  category: 'cli-algorithm',
  language: 'java',
  entries: [
    { path: 'src', kind: 'folder' },
    { path: 'src/Main.java', kind: 'file', content: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int a = sc.nextInt();\n        int b = sc.nextInt();\n        System.out.println(a + b);\n    }\n}\n' }
  ],
  policy: { entryPointPath: 'src/Main.java' },
  dependencies: [],
  installPolicy: { enabled: false, ecosystems: [] },
  database: { enabled: false },
  sampleTests: [
    { testId: 't1', kind: 'stdio', title: 'ตัวอย่าง: 2 3 -> 5', stdin: '2 3\n', expectedStdout: '5\n', visibility: 'sample', points: 10 }
  ],
  totalSamplePoints: 10
};
const STARTED_DOCS = { examTitle: 'สอบกลางภาค สังคมศึกษา ม.5', questionCount: 8, remainingSeconds: 5320, examMode: 'in-app-docs' };
const DOCS_OPEN = { open: true, url: 'https://docs.example.com/exam-material', allowedDomains: ['docs.example.com'], enforcement: 'warn', blockedUrl: null, warnUrl: null, viewError: null };

const server = await serve(8901);
const CHROME = 'C:\\Users\\MSI_GAMING\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let failed = 0;

async function emit(page, channel, payload) {
  await page.evaluate(([ch, p]) => { (window.__emit[ch] || []).slice().forEach((cb) => { try { cb(p); } catch (e) { console.error('emit-err', e); } }); }, [channel, payload]);
  await page.waitForTimeout(450);
}

async function newPage(scenario, viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1440, height: 900 } });
  await ctx.addInitScript(mockInit, scenario);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0].slice(0, 200)));
  await page.goto('http://127.0.0.1:8901/', { waitUntil: 'load' });
  await page.waitForTimeout(1300);
  return { ctx, page, errors };
}

async function finish(name, ctx, page, errors, opts = {}) {
  const kids = await page.evaluate(() => document.getElementById('root')?.children.length ?? -1);
  if (kids === 0) { await page.waitForTimeout(1200); }
  await page.screenshot({ path: path.join(OUT, name), fullPage: opts.fullPage ?? false });
  const tag = errors.length > 0 ? `WITH-PAGEERRORS: ${errors.join(' | ')}` : 'clean';
  if (errors.length > 0) failed += 1;
  console.log('saved', name, tag);
  await ctx.close();
}

// join flow helper (student lobby -> waiting)
async function doJoin(page) {
  await page.getByText('ห้องสอบ 401', { exact: false }).first().click({ timeout: 3000 });
  await page.waitForTimeout(300);
  const inputs = page.locator('input');
  await inputs.nth(0).fill('S001');
  await inputs.nth(1).fill('เด็กชายทดสอบ หนึ่ง');
  await inputs.nth(2).fill('482913');
  await page.getByText('เข้าห้องสอบ', { exact: false }).last().click({ timeout: 3000 });
  await page.waitForTimeout(900);
}

// ---- HOST ----
{
  let s = await newPage({ role: 'unselected', theme: 'dark' });
  await finish('01-role-dark.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'unselected', theme: 'light' });
  await finish('02-role-light.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true }, { width: 1440, height: 900 });
  await finish('03-host-room-dark.png', s.ctx, s.page, s.errors, { fullPage: true });
}
{
  let s = await newPage({ role: 'host', theme: 'light', withRoom: true });
  await finish('14-host-room-light.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'host', theme: 'dark', noRoom: true });
  await finish('05-host-no-room.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true, examState: { state: 'running', title: 'สอบกลางภาค คณิตศาสตร์ ม.4', questionCount: 10, durationSeconds: 3600 } });
  await finish('06-host-running.png', s.ctx, s.page, s.errors, { fullPage: true });
}
{
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true, examState: { state: 'finished', title: 'สอบกลางภาค คณิตศาสตร์ ม.4', questionCount: 10, durationSeconds: 3600 } });
  await finish('09-host-finished.png', s.ctx, s.page, s.errors, { fullPage: true });
}
{
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true, roomMode: 'in-app-docs', domains: 'docs-ai' });
  await finish('07-host-docs-ai.png', s.ctx, s.page, s.errors, { fullPage: true });
}
{
  // approve-all confirm dialog (clean domains, no AI rows)
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true, roomMode: 'in-app-docs', domains: 'docs-clean' });
  try {
    await s.page.getByText('อนุญาตทั้งหมด', { exact: false }).first().click({ timeout: 3000 });
    await s.page.waitForTimeout(700);
  } catch (e) { console.log('miss approve-all'); }
  await finish('08-host-approve-dialog.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true, attestationDev: true });
  await finish('13-host-attestation-dev.png', s.ctx, s.page, s.errors, { fullPage: true });
}
{
  // evidence drawer: open first card
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true });
  try {
    await s.page.getByText('ดูหลักฐาน', { exact: false }).first().click({ timeout: 3000 });
    await s.page.waitForTimeout(900);
  } catch (e) { console.log('miss evidence'); }
  await finish('10-host-evidence.png', s.ctx, s.page, s.errors);
}
{
  // freeze confirm dialog on first triage card
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true });
  try {
    await s.page.getByText('Dashboard คัดกรอง', { exact: false }).first().scrollIntoViewIfNeeded({ timeout: 5000 });
    await s.page.waitForTimeout(400);
    const clicked = await s.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent && b.textContent.includes('Freeze') && !b.disabled);
      const t = btns[0];
      if (!t) return 'none-found';
      t.scrollIntoView({ block: 'center' });
      t.click();
      return 'clicked:' + (t.textContent || '').trim().slice(0, 20);
    });
    console.log('freeze:', clicked);
    await s.page.waitForTimeout(700);
  } catch (e) { console.log('miss freeze:', String(e).split('\n').slice(0, 6).join(' | ').slice(0, 400)); }
  await finish('11-host-freeze-dialog.png', s.ctx, s.page, s.errors);
}
{
  // screen inspector modal with fake thumbnail (card button "ดูหน้าจอ" always rendered)
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true, screenThumb: true }, { width: 1440, height: 900 });
  try {
    await s.page.getByText('Dashboard คัดกรอง', { exact: false }).first().scrollIntoViewIfNeeded({ timeout: 5000 });
    await s.page.getByRole('button', { name: 'ดูหน้าจอ' }).first().click({ timeout: 5000 });
    await s.page.waitForTimeout(1200);
  } catch (e) { console.log('miss screen-inspect:', String(e).split('\n').slice(1, 2).join(' ').slice(0, 160)); }
  await finish('12-host-screen-modal.png', s.ctx, s.page, s.errors);
}

// ---- STUDENT ----
{
  let s = await newPage({ role: 'student', theme: 'dark' });
  await finish('04-student-lobby-dark.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'student', theme: 'dark' });
  try {
    await s.page.getByText('กรอก IP', { exact: false }).first().click({ timeout: 3000 });
    await s.page.waitForTimeout(600);
  } catch (e) { console.log('miss manual'); }
  await finish('15-student-manual-dialog.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'student', theme: 'dark' });
  await doJoin(s.page);
  await finish('16-student-waiting.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'student', theme: 'dark' });
  await doJoin(s.page);
  await emit(s.page, 'exam:started', STARTED_CLOSED);
  await emit(s.page, 'exam:question', MCQ);
  await emit(s.page, 'exam:tick', { remainingSeconds: 3532 });
  await emit(s.page, 'exam:module-ack', { moduleId: 'stepping-runner', kind: 'autosave', ok: true, progressText: 'บันทึกแล้ว' });
  await finish('17-student-exam-mcq.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'student', theme: 'light' });
  await doJoin(s.page);
  await emit(s.page, 'exam:started', STARTED_CLOSED);
  await emit(s.page, 'exam:question', MCQ);
  await emit(s.page, 'exam:tick', { remainingSeconds: 3532 });
  await finish('23-student-exam-light.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'student', theme: 'dark' });
  await doJoin(s.page);
  await emit(s.page, 'exam:started', STARTED_CLOSED);
  await emit(s.page, 'exam:question', ESSAY);
  await emit(s.page, 'exam:submit-rejected', { reason: 'cursor-mismatch' });
  await finish('18-student-exam-essay-reject.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'student', theme: 'dark' });
  await doJoin(s.page);
  await emit(s.page, 'exam:started', STARTED_DOCS);
  await emit(s.page, 'exam:question', MCQ);
  await emit(s.page, 'exam:docs-state', DOCS_OPEN);
  await finish('19-student-exam-docs.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'student', theme: 'dark' });
  await doJoin(s.page);
  await emit(s.page, 'exam:started', STARTED_CLOSED);
  await emit(s.page, 'exam:question', MCQ);
  await emit(s.page, 'network:connection-state', { state: 'frozen', reason: 'timeout' });
  await finish('20-student-frozen.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'student', theme: 'dark' });
  await doJoin(s.page);
  await emit(s.page, 'exam:started', STARTED_CLOSED);
  await emit(s.page, 'exam:question', MCQ);
  await emit(s.page, 'exam:completed', { reason: 'completed' });
  await finish('21-student-completed.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'student', theme: 'dark' });
  await doJoin(s.page);
  await emit(s.page, 'exam:started', STARTED_CLOSED);
  await emit(s.page, 'exam:question', MCQ);
  await emit(s.page, 'exam:time-up', {});
  await finish('22-student-timeup.png', s.ctx, s.page, s.errors);
}

// ---- STUDENT IDE + HOST GRADING ----
{
  // student doing exam inside the Code IDE workspace (module-state push)
  let s = await newPage({ role: 'student', theme: 'dark' });
  await doJoin(s.page);
  await emit(s.page, 'exam:started', STARTED_CLOSED);
  await emit(s.page, 'exam:module-state', { moduleId: 'code-ide', stateJson: JSON.stringify(CODE_PKG) });
  await s.page.waitForTimeout(3500);
  await finish('28-student-exam-ide.png', s.ctx, s.page, s.errors);
}
{
  // host grading table with real submissions
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true, submissions: 'filled' });
  try {
    await s.page.getByText('ผลตรวจ Code', { exact: false }).first().click({ timeout: 3000 });
    await s.page.waitForTimeout(1000);
  } catch (e) { console.log('miss code-responses'); }
  await finish('29-host-code-grading.png', s.ctx, s.page, s.errors);
}
{
  // host mirror IDE inspector for S001
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true, submissions: 'filled' });
  try {
    await s.page.getByText('ผลตรวจ Code', { exact: false }).first().click({ timeout: 3000 });
    await s.page.waitForTimeout(1000);
    await s.page.getByRole('button', { name: 'ดูโค้ด' }).first().click({ timeout: 5000 });
    await s.page.waitForTimeout(2500);
  } catch (e) { console.log('miss inspector:', String(e).split('\n').slice(1, 2).join(' ').slice(0, 160)); }
  await finish('30-host-code-inspector.png', s.ctx, s.page, s.errors);
}

// ---- MODULE STILLS ----
{
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true });
  try {
    await s.page.getByText('Dynamic Form Builder', { exact: false }).first().click({ timeout: 3000 });
    await s.page.waitForTimeout(800);
  } catch {}
  await finish('24-module-form-builder.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true });
  try {
    await s.page.getByText('ผลตอบฟอร์ม', { exact: false }).first().click({ timeout: 3000 });
    await s.page.waitForTimeout(900);
  } catch {}
  await finish('25-module-responses.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true });
  try {
    await s.page.getByText('Code IDE Builder', { exact: false }).first().click({ timeout: 3000 });
    await s.page.waitForTimeout(900);
  } catch {}
  await finish('26-module-code-builder.png', s.ctx, s.page, s.errors);
}
{
  let s = await newPage({ role: 'host', theme: 'dark', withRoom: true });
  const tabs = ['ผลตรวจ Code', 'ห้องสอบ'];
  for (const t of tabs) {
    try { await s.page.getByText(t, { exact: false }).first().click({ timeout: 3000 }); await s.page.waitForTimeout(800); } catch (e) { console.log('miss', t); }
  }
  await finish('27-module-code-submissions.png', s.ctx, s.page, s.errors);
}

// ---- TOUR VIDEO (stills stitched with ffmpeg) ----
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(mockInit, { role: 'host', theme: 'dark', withRoom: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).split('\n')[0]));
  await page.goto('http://127.0.0.1:8901/', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const steps = [
    ['tour-01.png', null],
    ['tour-02.png', 'Dynamic Form Builder'],
    ['tour-03.png', 'ผลตอบฟอร์ม'],
    ['tour-04.png', 'Code IDE Builder'],
    ['tour-05.png', 'ผลตรวจ Code'],
    ['tour-06.png', 'ห้องสอบ & ผู้คุม']
  ];
  for (const [file, tab] of steps) {
    if (tab) {
      try { await page.getByText(tab, { exact: false }).first().click({ timeout: 3000 }); } catch (e) { console.log('tour miss:', tab); }
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: path.join(OUT, file) });
    console.log('tour step', file, errs.length ? `ERR ${errs.join('|')}` : 'ok');
  }
  await ctx.close();
}

await browser.close();
server.close();

try {
  execFileSync('ffmpeg', ['-y', '-framerate', '1', '-i', path.join(OUT, 'tour-%02d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:720', path.join(OUT, 'tour.mp4')], { stdio: 'pipe' });
  console.log('video: screenshots/tour.mp4');
} catch (e) {
  console.log('ffmpeg stitch failed:', String(e).slice(0, 300));
}
console.log(failed === 0 ? 'ALL-CLEAN' : `PAGEERRORS in ${failed} shots`);

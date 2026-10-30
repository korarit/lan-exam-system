// Screenshot + tour-video harness: serves out/renderer, mocks window.ztExam.
// Run: node scripts/screenshots/shot.mjs
// Video is stitched from step screenshots with system ffmpeg (no playwright video).
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
  const room = withRoom
    ? { roomId: '11111111-1111-4111-8111-111111111111', roomName: 'ห้องสอบ 401', roomPin: '482913', tcpPort: 44456, certFpShort: 'AB12CD34EF56GH78', certFingerprint: 'AB12CD34EF56GH78AB12CD34EF56GH78', mode: 'closed', enforcement: 'report-only' }
    : null;
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

  window.ztExam = new Proxy(
    {
      getAppInfo: async () => ({ role: scenario.role || 'unselected' }),
      onRoleChanged: () => () => {},
      selectRole: async () => ({ ok: true }),
      getRoom: async () => ({ room }),
      getExamState: async () => ({ state: 'idle', title: null, questionCount: 0, durationSeconds: 0 }),
      getStudents: async () => ({ students }),
      getSummaries: async () => ({ summaries }),
      getTriageOverview: async () => overview,
      getAttestationConfig: async () => ({ devMode: false, signatureEnforced: true, platform: 'win32', trackedStudents: [] }),
      listRecordedDomains: async () => ({ records: [] }),
      listSavedForms: async () => ({ forms: [] }),
      getFormResponses: async () => ({ kind: 'database', roomId: '11111111-1111-4111-8111-111111111111', roomName: 'ห้องสอบ 401', formTitle: 'แบบฟอร์มตัวอย่าง', form: { items: [] }, startedAtMs: null, endedAtMs: null, students: [], itemStats: [], distribution: [], summary: { mean: 0, median: 0, min: 0, max: 0, studentCount: 0, needsManualCount: 0 }, regradeHistory: [] }),
      getFormState: async () => ({ formTitle: null }),
      checkRuntimes: async () => ({ runtimes: [] }),
      getCodeSubmissions: async () => ({ ok: true, roomId: null, roomName: null, packageTitle: null, category: null, language: null, questionSlug: null, maxPoints: 0, queue: { active: 0, pending: 0 }, depsUnsupported: [], submissions: [] }),
      getCodeWorkspaceState: async () => ({ rootPath: null }),
      saveZtform: async () => ({ ok: false, reason: 'CANCELLED' }),
      loadZtform: async () => ({ ok: false, reason: 'CANCELLED' }),
      onEvent: (channel, cb) => {
        try {
          if (channel === 'network:rooms-updated') setTimeout(() => { try { cb({ rooms: scenario.role === 'student' ? [beacon] : [] }); } catch {} }, 60);
          else if (channel === 'host:students-updated') setTimeout(() => { try { cb({ students }); } catch {} }, 60);
          else if (channel === 'host:exam-summaries') setTimeout(() => { try { cb({ summaries }); } catch {} }, 60);
          else if (channel === 'host:triage-updated') setTimeout(() => { try { cb(overview); } catch {} }, 80);
          else if (channel === 'host:recorded-domains-updated') setTimeout(() => { try { cb({ records: [] }); } catch {} }, 60);
        } catch {}
        return () => {};
      }
    },
    {
      get(t, p) {
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

const server = await serve(8901);
const CHROME = 'C:\\Users\\MSI_GAMING\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let failed = 0;

async function shot(name, scenario, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(mockInit, scenario);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  await page.goto('http://127.0.0.1:8901/', { waitUntil: 'load' });
  await page.waitForTimeout(opts.wait ?? 1500);
  const kids = await page.evaluate(() => document.getElementById('root')?.children.length ?? -1);
  if (kids === 0) { console.log('RETRY-EMPTY', name); await page.waitForTimeout(1500); }
  await page.screenshot({ path: path.join(OUT, name), fullPage: opts.fullPage ?? false });
  if (errors.length > 0) { failed += 1; console.log('saved', name, 'WITH-PAGEERRORS:', errors.join(' | ')); }
  else console.log('saved', name, 'clean, rootKids=', await page.evaluate(() => document.getElementById('root')?.children.length ?? -1));
  await ctx.close();
}

await shot('01-role-dark.png', { role: 'unselected', theme: 'dark' });
await shot('02-role-light.png', { role: 'unselected', theme: 'light' });
await shot('03-host-room-dark.png', { role: 'host', theme: 'dark', withRoom: true }, { fullPage: true, wait: 2000 });
await shot('04-student-lobby-dark.png', { role: 'student', theme: 'dark' }, { wait: 1800 });

// Tour steps for video: host room -> click each tab -> back to room
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(mockInit, { role: 'host', theme: 'dark', withRoom: true });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8901/', { waitUntil: 'load' });
  await page.waitForTimeout(1800);
  const steps = [
    ['tour-01.png', null],
    ['tour-02.png', 'Dynamic Form Builder'],
    ['tour-03.png', 'ผลตอบฟอร์ม'],
    ['tour-04.png', 'Code IDE Builder'],
    ['tour-05.png', 'ผลตรวจ Code'],
    ['tour-06.png', 'ห้องสอบ']
  ];
  let i = 0;
  for (const [file, tab] of steps) {
    i += 1;
    if (tab) {
      try { await page.getByText(tab, { exact: false }).first().click({ timeout: 2500 }); } catch (e) { console.log('tab miss:', tab); }
      await page.waitForTimeout(1100);
    }
    await page.screenshot({ path: path.join(OUT, file) });
    console.log('step', i, file);
  }
  await ctx.close();
}

await browser.close();
server.close();

// Stitch tour video with system ffmpeg (2s per step, 1280x720 mp4)
try {
  execFileSync('ffmpeg', ['-y', '-framerate', '1', '-i', path.join(OUT, 'tour-%02d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:720', path.join(OUT, 'tour.mp4')], { stdio: 'pipe' });
  console.log('video stitched: screenshots/tour.mp4');
} catch (e) {
  console.log('ffmpeg stitch failed:', String(e).slice(0, 300));
}
console.log(failed === 0 ? 'ALL-CLEAN' : `PAGEERRORS in ${failed} shots`);

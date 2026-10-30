import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCliTest } from './cli-runner'
import { bundleFrontend } from './frontend-runner'
import { runDomTest } from './dom-runner'
import { runSqliteTestWithTimeout } from './sql-runner'
import { gradeProject, type GradeJobInput } from '../code-grader-queue'
import type {
  CliTestCase,
  CodeExamPackage,
  ProjectCategory,
  SupportedCodeLanguage,
  VirtualEntry
} from '../../shared/code-schema'

/* ============================================================
 * Phase 11.1 — Multi-File, Multi-Folder & Multi-Stack Execution
 * ครอบคลุม 4 หมวด (CLI / Frontend / Backend / Database) +
 * โครงสร้างหลายไฟล์/โฟลเดอร์ + Offline Libraries จริง
 *
 * หมายเหตุสภาพแวดล้อม: เครื่องที่รัน test นี้มี
 * python/node/php/java/go/esbuild/jsdom/better-sqlite3
 * แต่ไม่มี gcc/rustc — เคส C/C++/Rust จึงตรวจแบบ adaptive
 * (มี compiler = คอมไพล์จริง / ไม่มี = ต้องได้สถานะ
 *  runtime-missing อย่างสุภาพ ไม่ใช่ crash)
 * ============================================================ */

function f(filePath: string, content: string): VirtualEntry {
  return { path: filePath, kind: 'file', content, encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
}

function dir(dirPath: string): VirtualEntry {
  return { path: dirPath, kind: 'folder', encoding: 'utf8', readOnly: false, allowStudentCreateInside: true, hiddenFromStudent: false }
}

function cliTest(testId: string, stdin: string, expectedStdout: string, timeoutMs = 8000): CliTestCase {
  return { testId, kind: 'stdio', title: testId, stdin, expectedStdout, inputs: [], visibility: 'sample', points: 10, timeoutMs }
}

let pkgCounter = 0
function mkPackage(
  category: ProjectCategory,
  language: SupportedCodeLanguage,
  entryPointPath: string,
  testCases: CodeExamPackage['testCases']
): CodeExamPackage {
  pkgCounter += 1
  return {
    moduleId: 'code-ide',
    packageId: `11111111-1111-4111-8111-1111111111${String(pkgCounter).padStart(2, '0')}`,
    title: `Q${pkgCounter}_${category}_${language}`,
    instructions: 'multi-stack test',
    category,
    language,
    entries: [f(entryPointPath, 'placeholder')],
    referenceSolution: [],
    policy: {
      entryPointPath,
      allowCreateFiles: true,
      allowCreateFolders: true,
      allowDeleteRename: true,
      allowStudentFileUpload: false,
      maxProjectSizeBytes: 10 * 1024 * 1024
    },
    dependencies: [],
    database: {
      enabled: false,
      engine: 'sqlite',
      sqlMode: 'query',
      allowDestructiveQueries: true,
      respawnFreshDbOnEveryRun: true,
      exposeDbViewerToStudent: true,
      host: 'localhost',
      port: 3303,
      dbUser: 'root',
      dbPassword: '',
      databaseName: ''
    },
    testCases,
    installPolicy: { enabled: false, ecosystems: [] },
    blobs: {}
  }
}

function hasCmd(cmd: string, args: string[] = ['--version']): boolean {
  try {
    execSync(`${cmd} ${args.join(' ')}`, { stdio: 'ignore', timeout: 8000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/* ---------------- 11.1.1 CLI multi-file + offline libs ---------------- */

describe('Phase 11.1.1 — CLI multi-file + offline libraries', () => {
  it('Python หลายโมดูลข้ามโฟลเดอร์ (src + utils/)', async () => {
    const entries = [
      dir('src'), dir('src/utils'),
      f('src/main.py', 'from utils.calc import add\nimport sys\ndef main():\n    data = sys.stdin.read().strip().split()\n    print(add(int(data[0]), int(data[1])))\nmain()\n'),
      f('src/utils/__init__.py', ''),
      f('src/utils/calc.py', 'def add(a, b):\n    return a + b\n')
    ]
    const r = await runCliTest(entries, 'python', 'src/main.py', cliTest('py-sum', '20 22', '42'))
    expect(r.passed).toBe(true)
    expect(r.timedOut).toBe(false)
  })

  it('Python ผูก offline site-packages ของครู (PYTHONPATH) โดยไม่ต่อเน็ต', async () => {
    const sp = fs.mkdtempSync(path.join(os.tmpdir(), 'ztcode-sp-'))
    try {
      fs.mkdirSync(path.join(sp, 'acmelib'), { recursive: true })
      fs.writeFileSync(path.join(sp, 'acmelib', '__init__.py'), "def shout(s):\n    return s.upper() + '!'\n", 'utf8')
      const entries = [
        dir('pkg'),
        f('pkg/main.py', 'from acmelib import shout\nprint(shout("hi"))\n')
      ]
      const r = await runCliTest(entries, 'python', 'pkg/main.py', cliTest('py-lib', '', 'HI!'), {
        depsCache: { root: sp, sitePackagesDirs: [sp], jarFiles: [], unsupported: [] }
      })
      expect(r.passed).toBe(true)
    } finally {
      fs.rmSync(sp, { recursive: true, force: true })
    }
  })

  it('JavaScript หลายไฟล์แบบ require ข้ามโฟลเดอร์', async () => {
    const entries = [
      dir('src'), dir('src/lib'),
      f('src/index.js', "const { sum } = require('./lib/sum');\nlet buf = '';\nprocess.stdin.on('data', (c) => { buf += c; });\nprocess.stdin.on('end', () => {\n  const [a, b] = buf.trim().split(/\\s+/).map(Number);\n  console.log(sum(a, b));\n});\n"),
      f('src/lib/sum.js', 'function sum(a, b) { return a + b; }\nmodule.exports = { sum };\n')
    ]
    const r = await runCliTest(entries, 'javascript', 'src/index.js', cliTest('js-sum', '20 22', '42'))
    expect(r.passed).toBe(true)
  })

  it('Node ผูก offline node_modules ของครู (junction/NODE_PATH) โดยไม่ต่อเน็ต', async () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ztcode-nm-'))
    try {
      const pkgDir = path.join(cache, 'shoutbox')
      fs.mkdirSync(pkgDir, { recursive: true })
      fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"name":"shoutbox","version":"1.0.0","main":"index.js"}', 'utf8')
      fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = { shout: (s) => s.toUpperCase() + "!" };\n', 'utf8')
      const entries = [
        dir('pkg'),
        f('pkg/main.js', "const { shout } = require('shoutbox');\nconsole.log(shout('hi'));\n")
      ]
      const r = await runCliTest(entries, 'javascript', 'pkg/main.js', cliTest('js-lib', '', 'HI!'), {
        depsCache: { root: cache, nodeModulesDir: cache, sitePackagesDirs: [], jarFiles: [], unsupported: [] }
      })
      expect(r.passed).toBe(true)
    } finally {
      fs.rmSync(cache, { recursive: true, force: true })
    }
  })

  it('TypeScript หลายไฟล์ (import ข้ามโฟลเดอร์) ผ่าน esbuild + node', async () => {
    const pkg = mkPackage('cli-algorithm', 'typescript', 'src/main.ts', [cliTest('ts-1', '', '42')])
    const entries = [
      dir('src'), dir('src/utils'),
      f('src/main.ts', "import { sum } from './utils/sum';\nconsole.log(sum(20, 22));\n"),
      f('src/utils/sum.ts', 'export function sum(a: number, b: number): number {\n  return a + b;\n}\n')
    ]
    const report = await gradeProject({ examPackage: pkg, studentId: '65010001', entries } satisfies GradeJobInput)
    expect(report.results).toHaveLength(1)
    expect(report.results[0]?.passed).toBe(true)
    expect(report.earnedPoints).toBe(10)
  }, 60_000)

  it('Java หลายคลาสหลายแพ็กเกจ (src/Main.java + src/models/User.java)', async () => {
    const pkg = mkPackage('cli-algorithm', 'java', 'src/Main.java', [cliTest('java-1', 'World', 'Hello, World!')])
    const entries = [
      dir('src'), dir('src/models'),
      f('src/Main.java', 'import models.User;\npublic class Main {\n  public static void main(String[] args) throws Exception {\n    java.io.BufferedReader br = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));\n    String line = br.readLine();\n    User u = new User(line == null ? "" : line.trim());\n    System.out.println(u.greet());\n  }\n}\n'),
      f('src/models/User.java', 'package models;\npublic class User {\n  private final String name;\n  public User(String name) { this.name = name; }\n  public String greet() { return "Hello, " + name + "!"; }\n}\n')
    ]
    const report = await gradeProject({ examPackage: pkg, studentId: '65010001', entries } satisfies GradeJobInput)
    expect(report.results).toHaveLength(1)
    expect(report.results[0]?.passed).toBe(true)
  }, 90_000)

  it('Java runtime crash (หารด้วยศูนย์) = ตก ไม่ใช่ค้าง', async () => {
    const pkg = mkPackage('cli-algorithm', 'java', 'Crash.java', [cliTest('java-crash', '', '0')])
    const entries = [f('Crash.java', 'public class Crash {\n  public static void main(String[] args) {\n    int x = 1 / 0;\n    System.out.println(x);\n  }\n}\n')]
    const report = await gradeProject({ examPackage: pkg, studentId: '65010001', entries } satisfies GradeJobInput)
    expect(report.results[0]?.passed).toBe(false)
  }, 90_000)

  it('PHP หลายไฟล์ require_once ข้ามโฟลเดอร์', async () => {
    if (!hasCmd('php', ['-v'])) {
      expect(true).toBe(true)
      return
    }
    const entries = [
      dir('lib'),
      f('lib/Math.php', '<?php\nfunction poly_add($a, $b) { return $a + $b; }\n'),
      // หมายเหตุ: guard ห้ามพาธ `../` (กัน traversal) — require ข้ามโฟลเดอร์จึงใช้
      // __DIR__ + พาธลงข้างล่างแทน ซึ่งยังข้ามโฟลเดอร์จริง (root -> lib/)
      f('index.php', "<?php\nrequire_once __DIR__ . '/lib/Math.php';\n$line = trim(fgets(STDIN));\necho poly_add((int)$line, 8);\n")
    ]
    const r = await runCliTest(entries, 'php', 'index.php', cliTest('php-1', '34', '42'))
    expect(r.passed).toBe(true)
  })

  it('Go หลายไฟล์หลายแพ็กเกจ (main.go + pkg/mathutil + go.mod)', async () => {
    if (!hasCmd('go', ['version'])) {
      expect(true).toBe(true)
      return
    }
    const pkg = mkPackage('cli-algorithm', 'go', 'main.go', [cliTest('go-1', '', '42')])
    const entries = [
      dir('pkg'), dir('pkg/mathutil'),
      f('go.mod', 'module exam\n\ngo 1.22\n'),
      f('main.go', 'package main\n\nimport (\n\t"fmt"\n\t"exam/pkg/mathutil"\n)\n\nfunc main() { fmt.Println(mathutil.Sum(20, 22)) }\n'),
      f('pkg/mathutil/sum.go', 'package mathutil\n\nfunc Sum(a, b int) int { return a + b }\n')
    ]
    const report = await gradeProject({ examPackage: pkg, studentId: '65010001', entries } satisfies GradeJobInput)
    expect(report.results).toHaveLength(1)
    expect(report.results[0]?.passed).toBe(true)
  }, 150_000)

  it('C multi-file (main.c + include/ + src/) — adaptive ตาม toolchain', async () => {
    const pkg = mkPackage('cli-algorithm', 'c', 'main.c', [cliTest('c-1', '', '42')])
    const entries = [
      dir('include'), dir('src'),
      f('main.c', '#include <stdio.h>\n#include "calc.h"\nint main(void) { printf("%d\\n", add(20, 22)); return 0; }\n'),
      f('include/calc.h', 'int add(int a, int b);\n'),
      f('src/calc.c', '#include "calc.h"\nint add(int a, int b) { return a + b; }\n')
    ]
    const report = await gradeProject({ examPackage: pkg, studentId: '65010001', entries } satisfies GradeJobInput)
    if (hasCmd('gcc')) {
      expect(report.results).toHaveLength(1)
    } else {
      // ไม่มี compiler = ต้องได้สถานะ runtime-missing สุภาพ (ไม่ throw/ไม่ค้าง)
      expect(report.runtimeMissing).toContain('gcc')
      expect(report.results.every((r) => r.passed === null)).toBe(true)
    }
  }, 90_000)

  it('Rust multi-module (main.rs + utils.rs) — adaptive ตาม toolchain', async () => {
    const pkg = mkPackage('cli-algorithm', 'rust', 'main.rs', [cliTest('rs-1', '', '42')])
    const entries = [
      f('main.rs', 'mod utils;\nfn main() { println!("{}", utils::add(20, 22)); }\n'),
      f('utils.rs', 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n')
    ]
    const report = await gradeProject({ examPackage: pkg, studentId: '65010001', entries } satisfies GradeJobInput)
    if (hasCmd('rustc')) {
      expect(report.results).toHaveLength(1)
    } else {
      expect(report.runtimeMissing).toContain('rust')
      expect(report.results.every((r) => r.passed === null)).toBe(true)
    }
  }, 120_000)

  it('Python syntax error = ตกพร้อม stderr (ไม่ใช่ค้าง)', async () => {
    const entries = [f('main.py', 'def broken(:\n  pass\n')]
    const r = await runCliTest(entries, 'python', 'main.py', cliTest('py-err', '', 'whatever'))
    expect(r.passed).toBe(false)
    expect(r.stderr.length).toBeGreaterThan(0)
  })
})

/* ---------------- 11.1.2 Frontend multi-file ---------------- */

describe('Phase 11.1.2 — Frontend multi-file & component folders', () => {
  it('HTML/CSS/JS หลายไฟล์ (index.html + styles/ + scripts/)', async () => {
    const pkg = mkPackage('frontend', 'html-css-js', 'scripts/app.js', [
      {
        testId: 'dom-1', kind: 'dom-assertion', title: 'หัวข้อ + ปุ่ม',
        route: '/index.html',
        assertionScript: "assert(document.querySelector('h1').textContent === 'Hi');\nassert(document.querySelector('button#go') !== null, 'ต้องมีปุ่ม');",
        visibility: 'sample', points: 10, timeoutMs: 5000
      }
    ])
    const entries = [
      dir('styles'), dir('scripts'),
      f('index.html', '<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles/layout.css"></head><body><div id="root"></div><script src="scripts/app.js"></script></body></html>'),
      f('styles/layout.css', 'h1 { color: red; }\n'),
      f('scripts/app.js', "document.getElementById('root').innerHTML = '<h1>Hi</h1><button id=\"go\">Go</button>';\n")
    ]
    const report = await gradeProject({ examPackage: pkg, studentId: '65010001', entries } satisfies GradeJobInput)
    expect(report.results[0]?.passed).toBe(true)
    expect(report.earnedPoints).toBe(10)
  }, 60_000)

  it('JS พัง (syntax error) = bundle ไม่ผ่าน = ตก', async () => {
    const bundled = await bundleFrontend(
      (() => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ztcode-badjs-'))
        fs.writeFileSync(path.join(tmp, 'bad.js'), 'function broken( {\n', 'utf8')
        return path.join(tmp, 'bad.js')
      })(),
      {}
    )
    expect(bundled.ok).toBe(false)
  })

  it('Component folders (App + components/ + hooks/) ผ่าน esbuild เส้นเดียวกับ .tsx', async () => {
    const pkg = mkPackage('frontend', 'react', 'src/App.ts', [
      {
        testId: 'dom-2', kind: 'dom-assertion', title: 'Navbar + filter',
        route: '/',
        assertionScript: "assert(document.querySelector('nav span').textContent === 'Shop');\nassert(document.querySelectorAll('ul li').length === 1, 'ต้องเหลือ 1 รายการหลัง filter');",
        visibility: 'sample', points: 10, timeoutMs: 5000
      }
    ])
    const entries = [
      dir('src'), dir('src/components'), dir('src/hooks'),
      f('src/App.ts', "import { Navbar } from './components/Navbar';\nimport { useFilter } from './hooks/useFilter';\ndocument.getElementById('root').innerHTML = Navbar() + '<ul>' + useFilter(['apple', 'banana'], 'apple').map((x) => `<li>${x}</li>`).join('') + '</ul>';\n"),
      f('src/components/Navbar.ts', "export function Navbar(): string {\n  return '<nav><span>Shop</span></nav>';\n}\n"),
      f('src/hooks/useFilter.ts', 'export function useFilter(items: string[], q: string): string[] {\n  return items.filter((x) => x.includes(q));\n}\n')
    ]
    const report = await gradeProject({ examPackage: pkg, studentId: '65010001', entries } satisfies GradeJobInput)
    expect(report.results[0]?.passed).toBe(true)
  }, 60_000)

  it('runDomTest จับ assertion ผิดได้ (negative control)', async () => {
    const r = await runDomTest({
      testId: 'neg',
      bundleJs: "document.getElementById('root').innerHTML = '<h1>Wrong</h1>';",
      documentHtml: '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
      assertionScript: "assert(document.querySelector('h1').textContent === 'Right');",
      timeoutMs: 3000
    })
    expect(r.passed).toBe(false)
  })
})

/* ---------------- 11.1.3 Backend REST API ---------------- */

const NODE_SEED_SQL = `CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
INSERT INTO users (name, role) VALUES ('Ann', 'admin'), ('Bob', 'user');`

const NODE_ROUTES_JS = `function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
  });
}
async function route(req, res, db) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && url.pathname === '/api/users') {
    return send(200, db.prepare('SELECT id, name, role FROM users ORDER BY id').all());
  }
  if (req.method === 'POST' && url.pathname === '/api/users') {
    const data = JSON.parse((await readBody(req)) || '{}');
    const r = db.prepare('INSERT INTO users (name, role) VALUES (?, ?)').run(String(data.name || ''), String(data.role || 'user'));
    return send(201, { id: Number(r.lastInsertRowid), name: data.name, role: data.role || 'user' });
  }
  const m = url.pathname.match(/^\\/api\\/users\\/(\\d+)$/);
  if (m && req.method === 'PUT') {
    const data = JSON.parse((await readBody(req)) || '{}');
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(data.name || ''), Number(m[1]));
    const row = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(Number(m[1]));
    return row ? send(200, row) : send(404, { error: 'not found' });
  }
  if (m && req.method === 'DELETE') {
    db.prepare('DELETE FROM users WHERE id = ?').run(Number(m[1]));
    return send(200, { ok: true });
  }
  return send(404, { error: 'not found' });
}
module.exports = { route };
`

const NODE_SERVER_JS = `const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { route } = require('./routes/users');
const port = Number(process.env.PORT || '0');
const db = new DatabaseSync(path.join(__dirname, 'app.db'));
db.exec(fs.readFileSync(path.join(__dirname, 'db', 'seed.sql'), 'utf8'));
const server = http.createServer((req, res) => {
  route(req, res, db).catch(() => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
server.listen(port, '127.0.0.1');
`

describe('Phase 11.1.3 — Backend REST API + SQLite', () => {
  it('Node/TS backend หลายโฟลเดอร์ (server + routes/ + db/seed.sql): GET/POST/PUT/DELETE + ตรวจ DB จริง', async () => {
    const pkg = mkPackage('backend', 'node-backend', 'server.js', [
      {
        testId: 'api-crud', kind: 'http-api', title: 'CRUD ครบ + สถานะ DB ตรง',
        requests: [
          { method: 'GET', path: '/api/users', expectedStatus: 200, expectedBodyMatcher: 'regex', expectedBody: '"Ann"' },
          { method: 'POST', path: '/api/users', bodyJson: '{"name":"Cat","role":"user"}', expectedStatus: 201, expectedBodyMatcher: 'json-subset', expectedBody: '{"name":"Cat"}' },
          { method: 'PUT', path: '/api/users/1', bodyJson: '{"name":"Ann2"}', expectedStatus: 200, expectedBodyMatcher: 'json-subset', expectedBody: '{"name":"Ann2"}' },
          { method: 'DELETE', path: '/api/users/2', expectedStatus: 200, expectedBodyMatcher: 'json-subset', expectedBody: '{"ok":true}' }
        ],
        verifyDb: {
          query: 'SELECT id, name, role FROM users ORDER BY id;',
          expectedColumns: ['id', 'name', 'role'],
          expectedRows: [[1, 'Ann2', 'admin'], [3, 'Cat', 'user']],
          checkColumnOrder: true,
          checkRowOrder: true
        },
        visibility: 'sample', points: 20, timeoutMs: 8000
      }
    ])
    const entries = [
      dir('routes'), dir('db'),
      f('server.js', NODE_SERVER_JS),
      f('routes/users.js', NODE_ROUTES_JS),
      f('db/seed.sql', NODE_SEED_SQL)
    ]
    const report = await gradeProject({ examPackage: pkg, studentId: '65010001', entries } satisfies GradeJobInput)
    expect(report.results).toHaveLength(1)
    expect(report.results[0]?.passed).toBe(true)
    expect(report.results[0]?.note).toMatch(/สถานะ DB ตรง/)
    expect(report.earnedPoints).toBe(20)
  }, 90_000)

  it('Python backend หลายไฟล์ (server.py + routes/) ด้วย stdlib ล้วน', async () => {
    if (!hasCmd('python')) {
      expect(true).toBe(true)
      return
    }
    const pkg = mkPackage('backend', 'python-backend', 'server.py', [
      {
        testId: 'py-api', kind: 'http-api', title: 'status + echo',
        requests: [
          { method: 'GET', path: '/api/status', expectedStatus: 200, expectedBodyMatcher: 'json-subset', expectedBody: '{"ok":true}' },
          { method: 'POST', path: '/api/echo', bodyJson: '{"name":"Zed"}', expectedStatus: 201, expectedBodyMatcher: 'json-subset', expectedBody: '{"you":"Zed"}' }
        ],
        visibility: 'sample', points: 10, timeoutMs: 8000
      }
    ])
    const entries = [
      dir('routes'),
      f('server.py', 'import json\nimport os\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\nfrom routes.users import build_routes\n\nROUTES = build_routes()\n\nclass H(BaseHTTPRequestHandler):\n    def _send(self, status, obj):\n        body = json.dumps(obj).encode()\n        self.send_response(status)\n        self.send_header("content-type", "application/json")\n        self.send_header("content-length", str(len(body)))\n        self.end_headers()\n        self.wfile.write(body)\n    def do_GET(self):\n        if self.path == "/api/status":\n            return self._send(200, {"ok": True, "routes": ROUTES})\n        return self._send(404, {})\n    def do_POST(self):\n        if self.path == "/api/echo":\n            n = int(self.headers.get("content-length") or 0)\n            data = json.loads(self.rfile.read(n) or b"{}")\n            return self._send(201, {"you": data.get("name")})\n        return self._send(404, {})\n    def log_message(self, *a):\n        pass\n\nHTTPServer(("127.0.0.1", int(os.environ.get("PORT", "0"))), H).serve_forever()\n'),
      f('routes/__init__.py', ''),
      f('routes/users.py', 'def build_routes():\n    return ["status", "echo"]\n')
    ]
    const report = await gradeProject({ examPackage: pkg, studentId: '65010001', entries } satisfies GradeJobInput)
    expect(report.results[0]?.passed).toBe(true)
  }, 90_000)
})

/* ---------------- 11.1.4 Database / SQL ---------------- */

const UNI_SEED = `CREATE TABLE students(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE courses(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE enrollments(student_id INTEGER NOT NULL REFERENCES students(id), course_id INTEGER NOT NULL REFERENCES courses(id), score INTEGER NOT NULL, PRIMARY KEY(student_id, course_id));
INSERT INTO students VALUES (1, 'Ann'), (2, 'Bob'), (3, 'Cat');
INSERT INTO courses VALUES (10, 'Math'), (20, 'Art');
INSERT INTO enrollments VALUES (1, 10, 80), (1, 20, 40), (2, 10, 90), (3, 20, 30);`

function sqlTest(
  testId: string,
  partial: Partial<Extract<CodeExamPackage['testCases'][number], { kind: 'sql-query' }>>
): Extract<CodeExamPackage['testCases'][number], { kind: 'sql-query' }> {
  return {
    testId, kind: 'sql-query', title: testId,
    expectedColumns: [], expectedRows: [],
    checkColumnOrder: true, checkRowOrder: true,
    visibility: 'sample', points: 10, timeoutMs: 3000,
    ...partial
  }
}

describe('Phase 11.1.4 — Database/SQL + respawn ฐานข้อมูล', () => {
  it('SELECT JOIN 3 ตารางตรง expected', async () => {
    const r = await runSqliteTestWithTimeout(
      UNI_SEED,
      'SELECT s.name FROM students s JOIN enrollments e ON e.student_id = s.id WHERE e.score >= 50 ORDER BY s.name;',
      sqlTest('sql-join', { expectedColumns: ['name'], expectedRows: [['Ann'], ['Bob']] })
    )
    expect(r.passed).toBe(true)
  })

  it('DELETE + ตรวจด้วย verificationQuery', async () => {
    const r = await runSqliteTestWithTimeout(
      UNI_SEED,
      'DELETE FROM enrollments WHERE score < 50;',
      sqlTest('sql-del', {
        verificationQuery: 'SELECT COUNT(*) AS c FROM enrollments;',
        expectedColumns: ['c'], expectedRows: [[2]]
      })
    )
    expect(r.passed).toBe(true)
  })

  it('DROP TABLE แล้วรันใหม่ = ได้ตาราง+ข้อมูลเดิมกลับครบ (respawn)', async () => {
    // หมายเหตุ: ลบตาราง enrollments (ไม่มีใครอ้างถึง) เพื่อไม่ให้ติด FK;
    // ประเด็นที่ตรวจคือ "รันถัดไป spawn จาก Master Seed ใหม่" ไม่ใช่ FK
    const dropped = await runSqliteTestWithTimeout(
      UNI_SEED,
      'DROP TABLE enrollments;',
      sqlTest('sql-drop', { expectedColumns: [], expectedRows: [] })
    )
    expect(dropped.passed).toBe(null)
    // รันถัดไป spawn ใหม่จาก Master Seed — ตาราง enrollments อยู่ครบ
    const again = await runSqliteTestWithTimeout(
      UNI_SEED,
      'SELECT COUNT(*) AS c FROM enrollments;',
      sqlTest('sql-respawn', { expectedColumns: ['c'], expectedRows: [[4]] })
    )
    expect(again.passed).toBe(true)
  })

  it('โหมด create-table: นักเรียนสร้างตารางเอง + ตรวจด้วย verificationQuery', async () => {
    const r = await runSqliteTestWithTimeout(
      '',
      "CREATE TABLE students(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO students VALUES (1, 'Ann');",
      sqlTest('sql-ddl', {
        verificationQuery: 'SELECT name FROM students WHERE id = 1;',
        expectedColumns: ['name'], expectedRows: [['Ann']]
      })
    )
    expect(r.passed).toBe(true)
  })

  it('gradeProject: โจทย์ทำลายข้อมูล (DELETE) ตรวจซ้ำ 2 รอบได้คะแนนเท่าเดิม (ไม่ปนเปื้อนข้ามรอบ)', async () => {
    const pkg = mkPackage('database', 'sql-sqlite', 'answer.sql', [
      sqlTest('g-del', {
        verificationQuery: 'SELECT COUNT(*) AS c FROM enrollments;',
        expectedColumns: ['c'], expectedRows: [[2]], visibility: 'hidden', points: 10
      }),
      sqlTest('g-count', {
        verificationQuery: 'SELECT COUNT(*) AS c FROM students;',
        expectedColumns: ['c'], expectedRows: [[3]], visibility: 'sample', points: 5
      })
    ])
    pkg.entries = [dir('db'), f('db/seed.sql', UNI_SEED)]
    pkg.database.seedSqlPath = 'db/seed.sql'
    const entries = [dir('db'), f('db/seed.sql', UNI_SEED), f('answer.sql', 'DELETE FROM enrollments WHERE score < 50;')]
    const job = { examPackage: pkg, studentId: '65010001', entries } satisfies GradeJobInput
    const first = await gradeProject(job)
    const second = await gradeProject(job)
    expect(first.earnedPoints).toBe(15)
    expect(second.earnedPoints).toBe(15)
    expect(first.passedCount).toBe(2)
  }, 60_000)
})

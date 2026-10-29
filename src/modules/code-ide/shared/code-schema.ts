import { z } from 'zod'

/* ============================================================
 * Phase 8 (8.1) — code-ide Module: Shared Schema
 * Project-Based Multi-File & Folder IDE + 4 หมวดโจทย์
 * (CLI / Frontend / Backend API / Database) + Offline Libraries
 *
 * กติกา Host-authoritative:
 * - VirtualEntry ที่ hiddenFromStudent=true, ReferenceSolution,
 *   Hidden Test Cases และ blobs ลับ ห้ามส่งถึงเครื่องนักเรียน
 *   (ตัดด้วย stripCodePackageForStudent ใน ./student-view)
 * ============================================================ */

/* ---------- 8.1.1 หมวดหมู่โจทย์ + ภาษา/สแต็ก ---------- */

export const ProjectCategorySchema = z.enum([
  'cli-algorithm',
  'frontend',
  'backend',
  'database',
  'fullstack'
])
export type ProjectCategory = z.infer<typeof ProjectCategorySchema>

export const PROJECT_CATEGORY_LABELS: Record<ProjectCategory, string> = {
  'cli-algorithm': 'CLI / Algorithm (โปรแกรมรันผ่าน CLI หรือ Function)',
  frontend: 'Frontend UI (หน้าเว็บ / UI Component)',
  backend: 'Backend API (REST API / Service)',
  database: 'Database / SQL (Query / Schema Design)',
  fullstack: 'Full-Stack (Frontend + Backend + Database)'
}

export const SupportedCodeLanguageSchema = z.enum([
  // Core, Systems & CLI / OOP
  'c',
  'cpp',
  'rust',
  'go',
  'java',
  'python',
  'javascript',
  'typescript',
  'php',
  // Frontend
  'html-css-js',
  'react',
  // Backend API
  'node-backend',
  'python-backend',
  'go-backend',
  'php-backend',
  'java-backend',
  // Database
  'sql-sqlite',
  'sql-mysql'
])
export type SupportedCodeLanguage = z.infer<typeof SupportedCodeLanguageSchema>

export const SUPPORTED_LANGUAGE_LABELS: Record<SupportedCodeLanguage, string> = {
  c: 'C (gcc/clang, .c/.h)',
  cpp: 'C++ (g++/clang++, .cpp/.hpp)',
  rust: 'Rust (rustc/cargo --offline)',
  go: 'Go (go build/run)',
  java: 'Java (Packages + .jar)',
  python: 'Python 3 (Modules + wheels)',
  javascript: 'JavaScript (Node.js CJS/ESM)',
  typescript: 'TypeScript (esbuild/tsx + Node)',
  php: 'PHP CLI (include/require/vendor)',
  'html-css-js': 'HTML + CSS + JS (หลายไฟล์/โฟลเดอร์)',
  react: 'React (JSX/TSX + Components + CSS)',
  'node-backend': 'Node.js Backend (Express/Fastify/Hono)',
  'python-backend': 'Python Backend (Flask/FastAPI)',
  'go-backend': 'Go Backend (net/http/Gin/Fiber)',
  'php-backend': 'PHP Backend (php -S / REST)',
  'java-backend': 'Java Backend (HTTP/REST)',
  'sql-sqlite': 'SQL (SQLite — ไฟล์ในเครื่อง)',
  'sql-mysql': 'SQL (MySQL — เลิกใช้, ไฟล์เก่าอ่านได้อย่างเดียว)'
}

/** ภาษาเริ่มต้นที่อนุญาตต่อหมวด (ใช้ใน Builder เป็นค่าแนะนำ) */
export const CATEGORY_LANGUAGES: Record<ProjectCategory, SupportedCodeLanguage[]> = {
  'cli-algorithm': ['c', 'cpp', 'rust', 'go', 'java', 'python', 'javascript', 'typescript', 'php'],
  frontend: ['html-css-js', 'react'],
  backend: ['node-backend', 'python-backend', 'go-backend', 'php-backend', 'java-backend'],
  database: ['sql-sqlite'],
  fullstack: ['react', 'node-backend', 'python-backend', 'go-backend', 'sql-sqlite', 'html-css-js']
}

/** monaco language id ต่อนามสกุลไฟล์ (Phase 8 ต่อ editor, Phase 9 ต่อ runtime) */
export const EXTENSION_MONACO_LANGUAGE: Record<string, string> = {
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  rs: 'rust',
  go: 'go',
  java: 'java',
  py: 'python',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  php: 'php',
  html: 'html',
  css: 'css',
  scss: 'scss',
  json: 'json',
  sql: 'sql',
  sqlite: 'sql',
  xml: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  txt: 'plaintext'
}

export function monacoLanguageForPath(path: string): string {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  const ext = base.slice(dot + 1).toLowerCase()
  return EXTENSION_MONACO_LANGUAGE[ext] ?? 'plaintext'
}

/* ---------- 8.1.2 โครงสร้างไฟล์/โฟลเดอร์ (VirtualProjectTree) ---------- */

export const VirtualNodeKindSchema = z.enum(['file', 'folder'])
export type VirtualNodeKind = z.infer<typeof VirtualNodeKindSchema>

export const VirtualEntrySchema = z.object({
  /** พาธแบบ POSIX เช่น 'src/components' หรือ 'src/components/Button.tsx' */
  path: z.string().min(1).max(500),
  kind: VirtualNodeKindSchema,
  /** เนื้อหาไฟล์ (เฉพาะ kind === 'file'); ไฟล์ไบนารีเล็กใช้ base64 */
  content: z.string().max(2_000_000).optional(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  /** ล็อกไม่ให้นักเรียนแก้/ลบ/เปลี่ยนชื่อ (ล็อกทั้งโฟลเดอร์รวมลูกข้างใน) */
  readOnly: z.boolean().default(false),
  /** สำหรับโฟลเดอร์: อนุญาตให้นักเรียนสร้างไฟล์/โฟลเดอร์ย่อยข้างในหรือไม่ */
  allowStudentCreateInside: z.boolean().default(true),
  /** ซ่อนจากนักเรียน (ไฟล์ตรวจ/เฉลย — ใช้ตอนรันตรวจเท่านั้น) */
  hiddenFromStudent: z.boolean().default(false)
})
export type VirtualEntry = z.infer<typeof VirtualEntrySchema>

export const ProjectWorkspacePolicySchema = z.object({
  allowCreateFiles: z.boolean().default(true),
  allowCreateFolders: z.boolean().default(true),
  allowDeleteRename: z.boolean().default(true),
  allowStudentFileUpload: z.boolean().default(false),
  /** ไฟล์หลักสำหรับรัน เช่น 'src/Main.java', 'src/server.ts', 'query.sql' */
  entryPointPath: z.string().min(1).max(500),
  /** จำกัดขนาดโค้ดโปรเจกต์ของนักเรียน (ไม่นับโฟลเดอร์ Library ของครู) */
  maxProjectSizeBytes: z.number().int().positive().max(256 * 1024 * 1024).default(10 * 1024 * 1024)
})
export type ProjectWorkspacePolicy = z.infer<typeof ProjectWorkspacePolicySchema>

/* ---------- 8.1.3 Libraries / Dependencies + Database ตั้งต้น ---------- */

export const DependencyBundleSchema = z.object({
  bundleId: z.string().min(1).max(128),
  ecosystem: z.enum([
    'npm',
    'pip',
    'maven-jar',
    'c-cpp-headers-libs',
    'cargo-vendor',
    'go-vendor',
    'composer-vendor',
    'frontend-vendor'
  ]),
  packages: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        version: z.string().min(1).max(64)
      })
    )
    .max(200)
    .default([]),
  /** พาธของไฟล์รวมไลบรารี (.tar.zst/.zip) ที่แนบในแพ็กเกจ .ztcode */
  archiveRelativePath: z.string().min(1).max(500),
  /** ไฟล์ .d.ts สำหรับ Monaco IntelliSense (ถ้ามี) */
  typeDefinitionsPath: z.string().min(1).max(500).optional()
})
export type DependencyBundle = z.infer<typeof DependencyBundleSchema>

export const MYSQL_DEFAULT_PORT = 3303
export const MYSQL_DEFAULT_HOST = 'localhost'
export const MYSQL_DEFAULT_USER = 'root'

export const DatabaseConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /* SQLite เท่านั้น (เลิกใช้ MySQL server ภายนอก — ค่า 'mysql' เก็บไว้แค่ให้ไฟล์ .ztcode เก่าอ่านได้) */
  engine: z.enum(['sqlite', 'mysql']).default('sqlite'),
  /** โหมดข้อสอบ SQL: 'query' = มี table+data ให้มาแล้วให้เขียน query / 'create-table' = ให้นักเรียนสร้าง table เอง */
  sqlMode: z.enum(['query', 'create-table']).default('query'),
  /** เช่น 'db/seed.sql' — สคริปต์สร้างตาราง + ข้อมูลตั้งต้น (Master Seed) */
  seedSqlPath: z.string().min(1).max(500).optional(),
  /** หรือไฟล์ '.sqlite' ต้นฉบับที่อาจารย์อัปโหลดมาให้เลย (เฉพาะ engine sqlite) */
  prebuiltDbPath: z.string().min(1).max(500).optional(),
  /** อนุญาต DELETE/DROP/TRUNCATE/ALTER ใน DB จำลองได้เต็มที่ */
  allowDestructiveQueries: z.boolean().default(true),
  /** Spawn DB ใหม่พร้อมข้อมูลเดิมทุกครั้งที่กด Run / เริ่ม Test Case ใหม่ */
  respawnFreshDbOnEveryRun: z.boolean().default(true),
  /** โหมดดู schema: ครูเปิด/ปิดให้นักเรียนได้ (ฝั่งครูดูได้ตลอดไม่ว่าตั้งค่านี้เป็นอะไร) */
  exposeDbViewerToStudent: z.boolean().default(true),
  /* ---------- MySQL/MariaDB external server (engine === 'mysql') ---------- */
  /** โฮสต์ของ MySQL server — default 'localhost', ครูแก้ได้ */
  host: z.string().min(1).max(255).default(MYSQL_DEFAULT_HOST),
  /** พอร์ตของ MySQL server — default 3303 (เช็ค TCP reachability ก่อนรัน) */
  port: z.number().int().min(1).max(65535).default(MYSQL_DEFAULT_PORT),
  /** ชื่อผู้ใช้ — default 'root', ครูแก้ได้ */
  dbUser: z.string().max(128).default(MYSQL_DEFAULT_USER),
  /** รหัสผ่าน — เก็บใน package เฉพาะฝั่งครู ห้ามส่งให้นักเรียนแบบ plaintext (strip ก่อนส่ง) */
  dbPassword: z.string().max(256).default(''),
  /** ชื่อฐานข้อมูล (database/schema) — ไม่ใช่ชื่อตาราง! เช่น 'exam_db' ไม่ใช่ 'users' */
  databaseName: z.string().max(128).default('')
})
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>

/* ---------- 8.1.4 ชุดทดสอบ 4 หมวด ---------- */

const TestVisibilitySchema = z.enum(['sample', 'hidden'])

/* LeetCode-style typed inputs — ครูกำหนด input ทีละตัวพร้อม type แล้วระบบรวมเป็น stdin ให้อัตโนมัติ */
export const CliInputTypeSchema = z.enum(['string', 'int', 'float', 'bool'])
export type CliInputType = z.infer<typeof CliInputTypeSchema>

export const CliTypedInputSchema = z.object({
  name: z.string().min(1).max(64),
  type: CliInputTypeSchema,
  /** ค่าที่กรอก (เก็บเป็น string แล้วแปลงตาม type ตอนรัน เช่น int "5", float "3.14", bool "true") */
  value: z.string().max(10_000)
})
export type CliTypedInput = z.infer<typeof CliTypedInputSchema>

export const CLI_INPUT_TYPES: CliInputType[] = ['string', 'int', 'float', 'bool']

/** รวม typed inputs เป็น stdin หนึ่งบรรทัดต่อหนึ่ง input (เว้น string ที่มีช่องว่างให้คงเดิม) */
export function typedInputsToStdin(inputs: readonly CliTypedInput[]): string {
  return inputs.map((i) => i.value).join('\n')
}

export const CliTestCaseSchema = z.object({
  testId: z.string().min(1).max(64),
  kind: z.enum(['stdio', 'unit-harness']),
  title: z.string().min(1).max(300),
  /** kind 'stdio': ข้อความป้อนทาง stdin (unit-harness: อาร์กิวเมนต์/ชื่อเทสต์) */
  stdin: z.string().max(100_000).default(''),
  expectedStdout: z.string().max(500_000).default(''),
  /** ฟอร์ม input แบบ LeetCode — ถ้ามีจะใช้ประกอบ/แทน stdin (ดู typedInputsToStdin) */
  inputs: z.array(CliTypedInputSchema).max(32).default([]),
  /** เช่น 'tests/test_main.py::test_sum' หรือคลาส JUnit — ใช้กับ unit-harness */
  harnessTarget: z.string().max(500).optional(),
  visibility: TestVisibilitySchema,
  points: z.number().positive().max(10000),
  timeoutMs: z.number().int().positive().max(120_000).default(5000)
})
export type CliTestCase = z.infer<typeof CliTestCaseSchema>

/**
 * Assertion API ใน HeadlessDomRunner (รันหลัง bundle + flush UI 300ms):
 * - `document`, `window` — DOM จริงของหน้าที่เปิด (route)
 * - `assert(cond, message?)` — ไม่ผ่านให้ throw ทันที
 * - `click(selector)` — helper กด element แล้วรอ re-render 1 เฟรม
 * - จบสคริปต์โดยไม่ throw = ผ่าน (รองรับ async: คืน Promise ได้)
 * ข้อจำกัด: CSS คำนวณได้เฉพาะ inline style/attribute (jsdom ไม่วาง layout)
 */
export const DomTestCaseSchema = z.object({
  testId: z.string().min(1).max(64),
  kind: z.literal('dom-assertion'),
  title: z.string().min(1).max(300),
  /** หน้าที่จะเปิดตรวจ เช่น '/', '/index.html' หรือ Route ของ React */
  route: z.string().max(300).default('/'),
  /** สคริปต์ assertion — ดู API ด้านบน */
  assertionScript: z.string().min(1).max(50_000),
  visibility: TestVisibilitySchema,
  points: z.number().positive().max(10000),
  timeoutMs: z.number().int().positive().max(120_000).default(5000)
})
export type DomTestCase = z.infer<typeof DomTestCaseSchema>

/** ตรวจสถานะฐานข้อมูลหลังยิง API (เช่น POST /api/users แล้ว SELECT ตรวจว่าแถวเข้าจริง) */
export const HttpApiDbCheckSchema = z.object({
  /** SELECT ตรวจสถานะ — รันบนไฟล์ .sqlite ที่เซิร์ฟเวอร์นักเรียนสร้างใน runDir */
  query: z.string().min(1).max(100_000),
  expectedColumns: z.array(z.string().min(1).max(128)).max(64),
  expectedRows: z
    .array(z.array(z.union([z.string(), z.number(), z.null()])).max(64))
    .max(5000),
  checkColumnOrder: z.boolean().default(true),
  checkRowOrder: z.boolean().default(true)
})
export type HttpApiDbCheck = z.infer<typeof HttpApiDbCheckSchema>

export const HttpApiTestCaseSchema = z.object({
  testId: z.string().min(1).max(64),
  kind: z.literal('http-api'),
  title: z.string().min(1).max(300),
  requests: z
    .array(
      z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().min(1).max(500),
        headers: z.record(z.string().min(1).max(200), z.string().max(2000)).optional(),
        bodyJson: z.string().max(200_000).optional(),
        expectedStatus: z.number().int().min(100).max(599),
        expectedBodyMatcher: z.enum(['exact-json', 'json-subset', 'regex', 'custom-script']),
        expectedBody: z.string().max(200_000)
      })
    )
    .min(1)
    .max(20),
  /** ไม่บังคับ — มีแล้ว grader จะหาฐานข้อมูล SQLite ของเซิร์ฟเวอร์ใน runDir มาตรวจเพิ่ม */
  verifyDb: HttpApiDbCheckSchema.optional(),
  visibility: TestVisibilitySchema,
  points: z.number().positive().max(10000),
  timeoutMs: z.number().int().positive().max(120_000).default(5000)
})
export type HttpApiTestCase = z.infer<typeof HttpApiTestCaseSchema>

export const SqlTestCaseSchema = z.object({
  testId: z.string().min(1).max(64),
  kind: z.literal('sql-query'),
  title: z.string().min(1).max(300),
  /** ข้อมูลพิเศษสำหรับ Hidden Test เพื่อกัน hardcode คำตอบ */
  setupSqlOverride: z.string().max(100_000).optional(),
  /** กรณีโจทย์ให้รัน INSERT/UPDATE/CREATE แล้วใช้ SELECT ตรวจสถานะ DB */
  verificationQuery: z.string().max(100_000).optional(),
  expectedColumns: z.array(z.string().min(1).max(128)).max(64),
  expectedRows: z
    .array(z.array(z.union([z.string(), z.number(), z.null()])).max(64))
    .max(5000),
  checkColumnOrder: z.boolean().default(true),
  checkRowOrder: z.boolean().default(true),
  visibility: TestVisibilitySchema,
  points: z.number().positive().max(10000),
  timeoutMs: z.number().int().positive().max(60_000).default(2000)
})
export type SqlTestCase = z.infer<typeof SqlTestCaseSchema>

export const CodeTestCaseSchema = z.discriminatedUnion('kind', [
  CliTestCaseSchema,
  DomTestCaseSchema,
  HttpApiTestCaseSchema,
  SqlTestCaseSchema
])
export type CodeTestCase = z.infer<typeof CodeTestCaseSchema>

/* ---------- แพ็กเกจข้อสอบ + ไฟล์ .ztcode ---------- */

/** ไฟล์ไบนารีแนบ (Library archive / .sqlite ตั้งต้น / รูป assets) เก็บเป็น base64 */
export const ZtcodeBlobSchema = z.object({
  encoding: z.literal('base64'),
  dataBase64: z.string().max(64_000_000),
  mimeType: z.string().max(100).optional()
})
export type ZtcodeBlob = z.infer<typeof ZtcodeBlobSchema>

export const CodeExamPackageSchema = z.object({
  moduleId: z.literal('code-ide'),
  packageId: z.uuid(),
  title: z.string().min(1).max(160),
  instructions: z.string().max(20_000).default(''),
  category: ProjectCategorySchema,
  language: SupportedCodeLanguageSchema,
  /** โครง Starter Project (รวมไฟล์ readOnly + hidden grading files) */
  entries: z.array(VirtualEntrySchema).min(1).max(2000),
  /** เฉลยอ้างอิงของอาจารย์ (หลายไฟล์/โฟลเดอร์) — ฝั่งเครื่องแม่เท่านั้น */
  referenceSolution: z.array(VirtualEntrySchema).max(2000).default([]),
  policy: ProjectWorkspacePolicySchema,
  dependencies: z.array(DependencyBundleSchema).max(50).default([]),
  database: DatabaseConfigSchema.default(() => ({
    enabled: false,
    engine: 'sqlite' as const,
    sqlMode: 'query' as const,
    allowDestructiveQueries: true,
    respawnFreshDbOnEveryRun: true,
    exposeDbViewerToStudent: true,
    host: MYSQL_DEFAULT_HOST,
    port: MYSQL_DEFAULT_PORT,
    dbUser: MYSQL_DEFAULT_USER,
    dbPassword: '',
    databaseName: ''
  })),
  testCases: z.array(CodeTestCaseSchema).max(200).default([]),
  /** ไฟล์แนบไบนารี (key = archiveRelativePath / seed/prebuilt path) */
  blobs: z.record(z.string().min(1).max(500), ZtcodeBlobSchema).default({})
})
export type CodeExamPackage = z.infer<typeof CodeExamPackageSchema>

export const ZtcodeManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    packageId: z.uuid(),
    title: z.string().min(1).max(160),
    category: ProjectCategorySchema,
    language: SupportedCodeLanguageSchema,
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    totalFiles: z.number().int().nonnegative(),
    totalTests: z.number().int().nonnegative(),
    totalPoints: z.number().nonnegative()
  })
  .strict()
export type ZtcodeManifest = z.infer<typeof ZtcodeManifestSchema>

export const ZtcodeContainerSchema = z
  .object({
    container: z.literal('ztcode'),
    formatVersion: z.literal(1),
    integrityKey: z.string().length(64),
    integrityHmac: z.string().length(64),
    manifest: ZtcodeManifestSchema,
    codePackage: CodeExamPackageSchema
  })
  .strict()
export type ZtcodeContainer = z.infer<typeof ZtcodeContainerSchema>

/** ซองเข้ารหัสด้วยรหัสผ่านครู (PBKDF2 100k → AES-256-GCM) */
export const ZtcodeEncryptedEnvelopeSchema = z
  .object({
    container: z.literal('ztcode-encrypted'),
    formatVersion: z.literal(1),
    kdf: z.object({
      saltBase64: z.string().min(8).max(64),
      iterations: z.number().int().min(1).max(5_000_000),
      keyLengthBytes: z.number().int().refine((v) => v === 32)
    }),
    cipher: z.object({
      ivBase64: z.string().min(8).max(64),
      tagBase64: z.string().min(12).max(64),
      dataBase64: z.string().max(80_000_000)
    })
  })
  .strict()
export type ZtcodeEncryptedEnvelope = z.infer<typeof ZtcodeEncryptedEnvelopeSchema>

/* ---------- มุมมองนักเรียน (ตัดความลับออกหมด) ---------- */

/** โจทย์ที่ส่งถึงนักเรียนได้: ไม่มี hidden entries / เฉลย / hidden tests / blobs ลับ */
export interface StudentCodePackageView {
  moduleId: 'code-ide'
  packageId: string
  title: string
  instructions: string
  category: ProjectCategory
  language: SupportedCodeLanguage
  entries: VirtualEntry[]
  policy: ProjectWorkspacePolicy
  /** เหลือเฉพาะ bundle ที่ต้องใช้รัน (ตัด archive path ลับออก เหลือชื่อ packages) */
  dependencies: Array<{ ecosystem: DependencyBundle['ecosystem']; packages: DependencyBundle['packages'] }>
  database: DatabaseConfig
  /** เหลือเฉพาะ test ที่ visibility === 'sample' */
  sampleTests: CodeTestCase[]
  totalSamplePoints: number
}

export function countCodePoints(tests: readonly CodeTestCase[]): number {
  return tests.reduce((sum, t) => sum + t.points, 0)
}

/** JSON canonical (เรียง key + ข้าม undefined) — ใช้ทำ integrity HMAC ทั้ง main และ renderer */
export function canonicalStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(obj[key])}`)
  return `{${parts.join(',')}}`
}

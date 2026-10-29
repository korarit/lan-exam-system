import type { CliTestCase, CodeTestCase, DatabaseConfig, DomTestCase, HttpApiTestCase, ProjectCategory, SqlTestCase, SupportedCodeLanguage, VirtualEntry } from '../../shared/code-schema'
import CliTestRunnerPanel from './panels/CliTestRunnerPanel'
import WebReactPreviewPanel from './panels/WebReactPreviewPanel'
import BackendApiTesterPanel from './panels/BackendApiTesterPanel'
import DatabaseWorkbenchPanel from './panels/DatabaseWorkbenchPanel'

/* Phase 8 (8.2.3) — AdaptiveExecutionPanel: สลับแผงผลลัพธ์ตามประเภทโจทย์ */

interface Props {
  category: ProjectCategory
  language: SupportedCodeLanguage
  entries: readonly VirtualEntry[]
  entryPointPath: string
  sampleTests: CodeTestCase[]
  database: DatabaseConfig
  seedSql: string
  /** ตัวนับจาก Ctrl+Enter — CLI/DB panels รันทันทีเมื่อค่าเปลี่ยน */
  runSignal?: number | undefined
  /** 'teacher' ดู schema ได้ตลอด / 'student' ดูได้เฉพาะเมื่อครูเปิด exposeDbViewerToStudent */
  viewerRole?: 'teacher' | 'student'
  /** F-3: packageId ใช้ผูก offline libs ที่แคชไว้ตอนรัน CLI sample */
  packageId?: string | undefined
  /** F-3b: นโยบายติดตั้งเอง (ครู opt-in) + รายชื่อ exact ที่ครูอนุมัติ */
  installPolicy?: { enabled: boolean; ecosystems: Array<'npm' | 'pip'> } | undefined
  installPackages?: Array<{ ecosystem: 'npm' | 'pip'; name: string; version: string }> | undefined
}

export default function AdaptiveExecutionPanel(props: Props): React.JSX.Element {
  const tabs = executionTabsFor(props.category)
  const viewerRole = props.viewerRole ?? 'student'

  if (props.category === 'fullstack') {
    const cli = props.sampleTests.filter((t): t is CliTestCase => t.kind === 'stdio' || t.kind === 'unit-harness')
    const dom = props.sampleTests.filter((t): t is DomTestCase => t.kind === 'dom-assertion')
    const api = props.sampleTests.filter((t): t is HttpApiTestCase => t.kind === 'http-api')
    const sql = props.sampleTests.filter((t): t is SqlTestCase => t.kind === 'sql-query')
    return (
      <div className="divide-y divide-slate-800">
        <section><SectionLabel text="CLI" /><CliTestRunnerPanel tests={cli} entries={props.entries} language={props.language} entryPointPath={props.entryPointPath} runSignal={props.runSignal} packageId={props.packageId} installPolicy={props.installPolicy} installPackages={props.installPackages} /></section>
        <section><SectionLabel text="Web Preview" /><WebReactPreviewPanel entries={props.entries} language={props.language} tests={dom} /></section>
        <section><SectionLabel text="API" /><BackendApiTesterPanel tests={api} /></section>
        <section><SectionLabel text="Database" /><DatabaseWorkbenchPanel database={props.database} seedSql={props.seedSql} tests={sql} runSignal={props.runSignal} viewerRole={viewerRole} /></section>
      </div>
    )
  }

  if (tabs === 'cli') {
    return <CliTestRunnerPanel tests={props.sampleTests.filter((t): t is CliTestCase => t.kind === 'stdio' || t.kind === 'unit-harness')} entries={props.entries} language={props.language} entryPointPath={props.entryPointPath} runSignal={props.runSignal} packageId={props.packageId} installPolicy={props.installPolicy} installPackages={props.installPackages} />
  }
  if (tabs === 'web') {
    return <WebReactPreviewPanel entries={props.entries} language={props.language} tests={props.sampleTests.filter((t): t is DomTestCase => t.kind === 'dom-assertion')} />
  }
  if (tabs === 'api') {
    return <BackendApiTesterPanel tests={props.sampleTests.filter((t): t is HttpApiTestCase => t.kind === 'http-api')} />
  }
  return <DatabaseWorkbenchPanel database={props.database} seedSql={props.seedSql} tests={props.sampleTests.filter((t): t is SqlTestCase => t.kind === 'sql-query')} runSignal={props.runSignal} viewerRole={viewerRole} />
}

function executionTabsFor(category: ProjectCategory): 'cli' | 'web' | 'api' | 'db' {
  switch (category) {
    case 'cli-algorithm': return 'cli'
    case 'frontend': return 'web'
    case 'backend': return 'api'
    case 'database': return 'db'
    case 'fullstack': return 'cli'
  }
}

function SectionLabel(props: { text: string }): React.JSX.Element {
  return <h4 className="bg-slate-950/60 px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{props.text}</h4>
}

import type Database from 'better-sqlite3'

export interface Migration {
  version: number
  sql: string
}

/**
 * Migration runner เล็ก ๆ อิง PRAGMA user_version (append-only เพิ่มรายการใหม่ด้านล่างเท่านั้น)
 * เรียกภายใน transaction เดียวต่อ migration
 */
export function applyMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.transaction(() => {
      db.exec(migration.sql)
      db.pragma(`user_version = ${migration.version}`)
    })()
  }
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      -- ห้องสอบที่เปิด (โหมด, เวลา, salt ของการเข้ารหัส)
      CREATE TABLE IF NOT EXISTS exam_sessions (
        id            TEXT PRIMARY KEY,
        room_name     TEXT NOT NULL,
        mode          TEXT NOT NULL CHECK (mode IN ('closed', 'in-app-docs', 'external-tools')),
        enforcement   TEXT NOT NULL CHECK (enforcement IN ('report-only', 'block-and-report')),
        status        TEXT NOT NULL CHECK (status IN ('lobby', 'running', 'frozen', 'ended')),
        started_at_ms INTEGER,
        ended_at_ms   INTEGER,
        crypto_salt   TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      -- นักเรียนที่เข้าร่วมห้อง
      CREATE TABLE IF NOT EXISTS students (
        student_id      TEXT NOT NULL,
        session_id      TEXT NOT NULL REFERENCES exam_sessions(id),
        display_name    TEXT NOT NULL,
        seed            TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('joined', 'taking', 'frozen', 'submitted', 'disconnected')),
        suspicion_score REAL NOT NULL DEFAULT 0,
        joined_at_ms    INTEGER NOT NULL,
        PRIMARY KEY (session_id, student_id)
      );

      -- คำตอบรายข้อ (ฟิลด์คำตอบเข้ารหัส AES-256-GCM, มี HMAC กันแก้)
      CREATE TABLE IF NOT EXISTS submissions (
        session_id     TEXT NOT NULL REFERENCES exam_sessions(id),
        student_id     TEXT NOT NULL,
        question_id    TEXT NOT NULL,
        seq_no         INTEGER NOT NULL,
        ciphertext     TEXT NOT NULL,
        iv             TEXT NOT NULL,
        tag            TEXT NOT NULL,
        hmac           TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL,
        PRIMARY KEY (session_id, student_id, question_id, seq_no)
      );
      CREATE INDEX IF NOT EXISTS idx_submissions_student
        ON submissions(session_id, student_id);

      -- Audit log แบบ append-only + hash chain (Phase 3b ใช้เต็มรูปแบบ)
      CREATE TABLE IF NOT EXISTS audit_logs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL REFERENCES exam_sessions(id),
        student_id    TEXT,
        timestamp_ms  INTEGER NOT NULL,
        event_type    TEXT NOT NULL,
        severity      TEXT NOT NULL CHECK (severity IN ('normal', 'warning', 'critical')),
        payload_json  TEXT NOT NULL,
        prev_hash     TEXT NOT NULL,
        entry_hash    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_session
        ON audit_logs(session_id, timestamp_ms);
    `
  },
  {
    /** Phase 2: ฉบับร่าง (autosave) — ทับค่าล่าสุดของ (student, question) เสมอ */
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS draft_submissions (
        session_id     TEXT NOT NULL REFERENCES exam_sessions(id),
        student_id     TEXT NOT NULL,
        question_id    TEXT NOT NULL,
        ciphertext     TEXT NOT NULL,
        iv             TEXT NOT NULL,
        tag            TEXT NOT NULL,
        hmac           TEXT NOT NULL,
        updated_at_ms  INTEGER NOT NULL,
        PRIMARY KEY (session_id, student_id, question_id)
      );
    `
  },
  {
    /** Phase 3a-plus: โดเมนที่หน้า Doc Preview เรียกจริง (ครูอนุมัติแล้วฝังเป็น allowedDomains) */
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS recorded_domains (
        session_id     TEXT NOT NULL REFERENCES exam_sessions(id),
        domain         TEXT NOT NULL,   -- hostname ที่ถูกเรียก (lowercase, ไม่รวม port)
        top_domain     TEXT NOT NULL,   -- hostname ของหน้าเว็บชั้นบนสุดที่เรียกมัน
        source         TEXT NOT NULL DEFAULT 'preview' CHECK (source IN ('preview', 'top-url')),
        hits           INTEGER NOT NULL DEFAULT 1,
        first_seen_ms  INTEGER NOT NULL,
        last_seen_ms   INTEGER NOT NULL,
        approved       INTEGER NOT NULL DEFAULT 0,
        approved_at_ms INTEGER,
        PRIMARY KEY (session_id, domain, top_domain)
      );
      CREATE INDEX IF NOT EXISTS idx_recorded_domains_session
        ON recorded_domains(session_id, approved);
    `
  },
  {
    /** Phase 3b: คอลัมน์เสริมของ audit_logs — hash chain แบบมี seq_no + HMAC ของเครื่องแม่ */
    version: 4,
    sql: `
      ALTER TABLE audit_logs ADD COLUMN seq_no              INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE audit_logs ADD COLUMN client_timestamp_ms INTEGER;
      ALTER TABLE audit_logs ADD COLUMN category            TEXT    NOT NULL DEFAULT '';
      ALTER TABLE audit_logs ADD COLUMN score_delta         REAL    NOT NULL DEFAULT 0;
      ALTER TABLE audit_logs ADD COLUMN summary_text        TEXT    NOT NULL DEFAULT '';
      ALTER TABLE audit_logs ADD COLUMN host_hmac           TEXT    NOT NULL DEFAULT '';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_session_seq
        ON audit_logs(session_id, seq_no);
      CREATE INDEX IF NOT EXISTS idx_audit_student
        ON audit_logs(session_id, student_id, seq_no);
    `
  },
  {
    /** Phase 6: ฟอร์ม `.ztform` ที่เคยเปิดล่าสุดบนเครื่องแม่ (รายการล่าสุดของหน้า Builder) */
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS saved_forms (
        form_id          TEXT PRIMARY KEY,
        title            TEXT NOT NULL,
        file_path        TEXT NOT NULL,
        sha256           TEXT NOT NULL,
        total_questions  INTEGER NOT NULL,
        total_points     REAL NOT NULL,
        encrypted        INTEGER NOT NULL DEFAULT 0,
        created_at_ms    INTEGER NOT NULL,
        updated_at_ms    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_saved_forms_updated
        ON saved_forms(updated_at_ms DESC);
    `
  },
  {
    /** Phase 7: Backend ฟอร์ม — คำตอบ/คะแนนรายข้อ (เข้ารหัส), ไฟล์แนบใน vault, ประวัติ re-grade */
    version: 6,
    sql: `
      -- คำตอบรายข้อของโมดูล dynamic-form (ciphertext = { value, artifacts, journey })
      -- สถานะการตรวจ + คะแนนเก็บเพื่อให้ query/export ได้โดยไม่ต้องถอดรหัส
      CREATE TABLE IF NOT EXISTS form_responses (
        session_id     TEXT NOT NULL REFERENCES exam_sessions(id),
        student_id     TEXT NOT NULL,
        item_id        TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('auto-graded','needs-manual','manual-graded','invalid','ungraded')),
        earned_points  REAL NOT NULL DEFAULT 0,
        manual_points  REAL,
        violations_json TEXT NOT NULL DEFAULT '[]',
        ciphertext     TEXT NOT NULL,
        iv             TEXT NOT NULL,
        tag            TEXT NOT NULL,
        hmac           TEXT NOT NULL,
        time_spent_ms  INTEGER NOT NULL DEFAULT 0,
        submitted_at_ms INTEGER,
        revision       INTEGER NOT NULL DEFAULT 0,
        updated_at_ms  INTEGER NOT NULL,
        PRIMARY KEY (session_id, student_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_form_responses_session
        ON form_responses(session_id, student_id);

      -- Local Encrypted File Vault (ข้อ file_upload): ไฟล์ถูกเข้ารหัส AES-256-GCM
      -- เก็บที่ userData/exam-vault/<roomId>/<studentId>/<itemId>/<artifactId>_<safe>.enc
      CREATE TABLE IF NOT EXISTS uploaded_artifacts (
        session_id      TEXT NOT NULL REFERENCES exam_sessions(id),
        student_id      TEXT NOT NULL,
        item_id         TEXT NOT NULL,
        artifact_id     TEXT NOT NULL,
        file_name       TEXT NOT NULL,
        mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes      INTEGER NOT NULL,
        sha256          TEXT NOT NULL,
        file_path       TEXT NOT NULL,
        iv              TEXT NOT NULL,
        tag             TEXT NOT NULL,
        row_hmac        TEXT NOT NULL,
        received_at_ms  INTEGER NOT NULL,
        PRIMARY KEY (session_id, student_id, item_id, artifact_id)
      );

      -- ประวัติ "คำนวณคะแนนใหม่ทั้งห้อง" (Re-grade All) — ครูแก้เฉลยแล้วต้องมีร่องรอย
      CREATE TABLE IF NOT EXISTS form_regrade_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT NOT NULL REFERENCES exam_sessions(id),
        run_at_ms    INTEGER NOT NULL,
        trigger_source TEXT NOT NULL DEFAULT 'teacher-ui',
        form_sha256  TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}'
      );
    `
  }
]

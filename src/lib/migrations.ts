import type { DatabaseSync } from "node:sqlite";

const migrations: ((db: DatabaseSync) => void)[] = [
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS interview_sessions (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, briefing TEXT NOT NULL,
      prompt TEXT NOT NULL, duration_sec INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'created', created_at INTEGER NOT NULL,
      started_at INTEGER, ended_at INTEGER, live_session_id TEXT,
      recording_path TEXT, transcript TEXT NOT NULL DEFAULT '[]',
      timeline TEXT NOT NULL DEFAULT '[]', final_scene TEXT, final_image TEXT, grade TEXT
    )`);
    // Adopt databases created before persisted migration versions were introduced.
    const columns = new Set(db.prepare("PRAGMA table_info(interview_sessions)").all().map((r) => r.name));
    for (const [name, definition] of Object.entries({
      grading_status: "TEXT NOT NULL DEFAULT 'idle'", grading_started_at: "INTEGER", grade_error: "TEXT",
      recording_status: "TEXT NOT NULL DEFAULT 'idle'", recording_started_at: "INTEGER", recording_error: "TEXT",
      live_trace: "TEXT NOT NULL DEFAULT '[]'",
    })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE interview_sessions ADD COLUMN ${name} ${definition}`);
    }
    db.exec(`
      UPDATE interview_sessions SET grading_status = 'done' WHERE grade IS NOT NULL AND grading_status = 'idle';
      UPDATE interview_sessions SET recording_status = 'done' WHERE recording_path IS NOT NULL AND recording_path != '' AND recording_status = 'idle';
      UPDATE interview_sessions SET recording_status = 'unavailable' WHERE recording_path = '' AND recording_status = 'idle';
    `);
  },
  (db) => db.exec(`
    ALTER TABLE interview_sessions ADD COLUMN checkpoint_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE interview_sessions ADD COLUMN start_token TEXT;
    ALTER TABLE interview_sessions ADD COLUMN start_expires_at INTEGER;
    CREATE INDEX interview_sessions_created_at ON interview_sessions(created_at DESC);
  `),
  (db) => db.exec(`
    ALTER TABLE interview_sessions ADD COLUMN grading_attempt TEXT;
    ALTER TABLE interview_sessions ADD COLUMN grading_expires_at INTEGER;
    ALTER TABLE interview_sessions ADD COLUMN recording_attempt TEXT;
    ALTER TABLE interview_sessions ADD COLUMN recording_expires_at INTEGER;
  `),
  (db) => db.exec(`CREATE TABLE generated_prompts (
    id TEXT PRIMARY KEY, spec TEXT NOT NULL, created_at INTEGER NOT NULL
  )`),
];

export const SCHEMA_VERSION = migrations.length;

export function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (version > SCHEMA_VERSION) throw new Error("Database was created by a newer application version");
    for (let i = version; i < migrations.length; i++) {
      migrations[i](db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

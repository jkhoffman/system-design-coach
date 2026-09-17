import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrate, SCHEMA_VERSION } from "../src/lib/migrations.ts";

const legacySchema = `CREATE TABLE interview_sessions (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, briefing TEXT NOT NULL, prompt TEXT NOT NULL,
      duration_sec INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      started_at INTEGER, ended_at INTEGER, live_session_id TEXT, recording_path TEXT,
      transcript TEXT NOT NULL DEFAULT '[]', timeline TEXT NOT NULL DEFAULT '[]',
      final_scene TEXT, final_image TEXT, grade TEXT
    )`;

test("adopts legacy databases without losing content, grades, or media references", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(legacySchema);
    db.prepare(`INSERT INTO interview_sessions
      (id, mode, briefing, prompt, duration_sec, status, created_at, recording_path, transcript, final_image, grade)
      VALUES (?, 'library', '{}', '{}', 300, 'graded', 100, ?, ?, ?, ?)`)
      .run("legacy", "/existing/recording.wav", '[{"text":"keep me"}]', "data:image/png;base64,abc", '{"overall":{"score":4}}');
    migrate(db);
    migrate(db);
    const row = db.prepare("SELECT * FROM interview_sessions WHERE id = 'legacy'").get();
    assert.equal(row.transcript, '[{"text":"keep me"}]');
    assert.equal(row.final_image, "data:image/png;base64,abc");
    assert.equal(row.recording_path, "/existing/recording.wav");
    assert.equal(row.grade, '{"overall":{"score":4}}');
    assert.equal(row.grading_status, "done");
    assert.equal(row.recording_status, "done");
    assert.equal(row.checkpoint_revision, 0);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  } finally { db.close(); }
});

test("adopts the previous schema with job columns already present", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(legacySchema);
    db.exec(`ALTER TABLE interview_sessions ADD COLUMN grading_status TEXT NOT NULL DEFAULT 'idle';
      ALTER TABLE interview_sessions ADD COLUMN grading_started_at INTEGER;
      ALTER TABLE interview_sessions ADD COLUMN grade_error TEXT;
      ALTER TABLE interview_sessions ADD COLUMN recording_status TEXT NOT NULL DEFAULT 'idle';
      ALTER TABLE interview_sessions ADD COLUMN recording_started_at INTEGER;
      ALTER TABLE interview_sessions ADD COLUMN recording_error TEXT;
      ALTER TABLE interview_sessions ADD COLUMN live_trace TEXT NOT NULL DEFAULT '[]';`);
    migrate(db);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  } finally { db.close(); }
});


test("migration preserves legacy long evidence and negative times while caching grade readability", async () => {
  const { gradeReport } = await import("../scripts/mock-fixtures.mjs");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(legacySchema);
    const report = gradeReport();
    report.overall.summary = "long evidence ".repeat(2000);
    report.dimensions[0].moments = [{ startMs: -10, note: "legacy" }];
    const raw = JSON.stringify(report);
    const insert = db.prepare(`INSERT INTO interview_sessions (id, mode, briefing, prompt, duration_sec, status, created_at, grade)
      VALUES (?, 'library', '{}', '{}', 300, 'graded', 1, ?)`);
    insert.run("readable", raw); insert.run("broken", "{broken");
    migrate(db);
    const readable = db.prepare("SELECT grade, grade_readable FROM interview_sessions WHERE id = 'readable'").get();
    assert.equal(readable.grade, raw); assert.equal(readable.grade_readable, 1);
    assert.equal(db.prepare("SELECT grade_readable FROM interview_sessions WHERE id = 'broken'").get().grade_readable, 0);
  } finally { db.close(); }
});

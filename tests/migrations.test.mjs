import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrate, SCHEMA_VERSION } from "../src/lib/migrations.ts";

test("adopts legacy databases without losing content, grades, or media references", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE interview_sessions (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, briefing TEXT NOT NULL, prompt TEXT NOT NULL,
      duration_sec INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      started_at INTEGER, ended_at INTEGER, live_session_id TEXT, recording_path TEXT,
      transcript TEXT NOT NULL DEFAULT '[]', timeline TEXT NOT NULL DEFAULT '[]',
      final_scene TEXT, final_image TEXT, grade TEXT
    )`);
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
    migrate(db);
    db.exec("PRAGMA user_version = 0");
    // Simulate the original unversioned schema, including its newer columns.
    db.exec("ALTER TABLE interview_sessions DROP COLUMN checkpoint_revision; ALTER TABLE interview_sessions DROP COLUMN start_token; ALTER TABLE interview_sessions DROP COLUMN start_expires_at; ALTER TABLE interview_sessions DROP COLUMN grading_attempt; ALTER TABLE interview_sessions DROP COLUMN grading_expires_at; ALTER TABLE interview_sessions DROP COLUMN recording_attempt; ALTER TABLE interview_sessions DROP COLUMN recording_expires_at; DROP INDEX interview_sessions_created_at; DROP TABLE generated_prompts");
    migrate(db);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  } finally { db.close(); }
});

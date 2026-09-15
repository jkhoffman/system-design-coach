import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  SessionRow,
  Briefing,
  PromptSpec,
  Mode,
  TranscriptTurn,
  TimelineEvent,
  GradeReport,
  GradeStatus,
  RecordingStatus,
  SessionSummary,
} from "./types";

const DATA_DIR = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.join(process.cwd(), "data");
export const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
export const RECORDING_DIR = path.join(DATA_DIR, "recordings");

const GRADING_CLAIM_STALE_MS = 3 * 60 * 1000;
const RECORDING_CLAIM_STALE_MS = 2 * 60 * 1000;
const SCHEMA_VERSION = 2;

function ensureDirs() {
  for (const d of [DATA_DIR, SNAPSHOT_DIR, RECORDING_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function addColumn(db: DatabaseSync, sql: string): void {
  try {
    db.exec(sql);
  } catch (err) {
    if (!String(err).includes("duplicate column name")) throw err;
  }
}

function ensureSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS interview_sessions (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      briefing TEXT NOT NULL,
      prompt TEXT NOT NULL,
      duration_sec INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      live_session_id TEXT,
      recording_path TEXT,
      transcript TEXT NOT NULL DEFAULT '[]',
      timeline TEXT NOT NULL DEFAULT '[]',
      final_scene TEXT,
      final_image TEXT,
      grade TEXT,
      grading_status TEXT NOT NULL DEFAULT 'idle',
      grading_started_at INTEGER,
      grade_error TEXT,
      recording_status TEXT NOT NULL DEFAULT 'idle',
      recording_started_at INTEGER,
      recording_error TEXT
    )
  `);
  addColumn(db, "ALTER TABLE interview_sessions ADD COLUMN grading_status TEXT NOT NULL DEFAULT 'idle'");
  addColumn(db, "ALTER TABLE interview_sessions ADD COLUMN grading_started_at INTEGER");
  addColumn(db, "ALTER TABLE interview_sessions ADD COLUMN grade_error TEXT");
  addColumn(db, "ALTER TABLE interview_sessions ADD COLUMN recording_status TEXT NOT NULL DEFAULT 'idle'");
  addColumn(db, "ALTER TABLE interview_sessions ADD COLUMN recording_started_at INTEGER");
  addColumn(db, "ALTER TABLE interview_sessions ADD COLUMN recording_error TEXT");
  db.exec(`
    UPDATE interview_sessions SET grading_status = 'done' WHERE grade IS NOT NULL AND grading_status = 'idle';
    UPDATE interview_sessions SET recording_status = 'done' WHERE recording_path IS NOT NULL AND recording_path != '' AND recording_status = 'idle';
    UPDATE interview_sessions SET recording_status = 'unavailable' WHERE recording_path = '' AND recording_status = 'idle';
  `);
}

const g = globalThis as unknown as { __appdb?: DatabaseSync; __appdbSchemaVersion?: number };

// Lazy open so build-time module collection never touches the database file.
function getDb(): DatabaseSync {
  if (!g.__appdb) {
    ensureDirs();
    g.__appdb = new DatabaseSync(path.join(DATA_DIR, "app.db"));
  }
  // A Next dev server can retain the old connection across hot reloads.
  if (g.__appdbSchemaVersion !== SCHEMA_VERSION) {
    ensureSchema(g.__appdb);
    g.__appdbSchemaVersion = SCHEMA_VERSION;
  }
  return g.__appdb;
}

export function newId(): string {
  return crypto.randomBytes(8).toString("hex");
}

interface RawRow {
  id: string;
  mode: string;
  briefing: string;
  prompt: string;
  duration_sec: number;
  status: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  live_session_id: string | null;
  recording_path: string | null;
  recording_status: string | null;
  recording_error: string | null;
  transcript: string;
  timeline: string;
  final_scene: string | null;
  final_image: string | null;
  grade: string | null;
  grading_status: string | null;
  grade_error: string | null;
}

function toRow(r: RawRow): SessionRow {
  return {
    id: r.id,
    mode: r.mode as Mode,
    briefing: JSON.parse(r.briefing) as Briefing,
    prompt: JSON.parse(r.prompt) as PromptSpec,
    durationSec: r.duration_sec,
    status: r.status as SessionRow["status"],
    createdAt: r.created_at,
    startedAt: r.started_at ?? undefined,
    endedAt: r.ended_at ?? undefined,
    liveSessionId: r.live_session_id ?? undefined,
    recordingPath: r.recording_path ?? undefined,
    recordingStatus: (r.recording_status ?? "idle") as RecordingStatus,
    recordingError: r.recording_error ?? undefined,
    transcript: JSON.parse(r.transcript) as TranscriptTurn[],
    timeline: JSON.parse(r.timeline) as TimelineEvent[],
    finalScene: r.final_scene ? JSON.parse(r.final_scene) : undefined,
    finalImage: r.final_image ?? undefined,
    grade: r.grade ? (JSON.parse(r.grade) as GradeReport) : undefined,
    gradeStatus: (r.grading_status ?? "idle") as GradeStatus,
    gradeError: r.grade_error ?? undefined,
  };
}

export function createSession(input: {
  mode: Mode;
  briefing: Briefing;
  prompt: PromptSpec;
  durationSec: number;
}): SessionRow {
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO interview_sessions (id, mode, briefing, prompt, duration_sec, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'created', ?)`
    )
    .run(id, input.mode, JSON.stringify(input.briefing), JSON.stringify(input.prompt), input.durationSec, Date.now());
  return getSession(id)!;
}

export function getSession(id: string): SessionRow | null {
  const r = getDb().prepare(`SELECT * FROM interview_sessions WHERE id = ?`).get(id) as
    | RawRow
    | undefined;
  return r ? toRow(r) : null;
}

interface RawSummaryRow {
  id: string;
  title: string | null;
  company: string | null;
  level: string | null;
  duration_sec: number;
  status: string;
  created_at: number;
  score: number | null;
}

export function listSessionSummaries(limit = 50): SessionSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT id,
              json_extract(prompt, '$.title') AS title,
              json_extract(briefing, '$.company') AS company,
              json_extract(briefing, '$.level') AS level,
              duration_sec,
              status,
              created_at,
              json_extract(grade, '$.overall.score') AS score
       FROM interview_sessions
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit) as unknown as RawSummaryRow[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? "Untitled interview",
    company: r.company ?? "",
    level: r.level ?? "",
    durationSec: r.duration_sec,
    status: r.status as SessionRow["status"],
    createdAt: r.created_at,
    score: typeof r.score === "number" ? r.score : undefined,
  }));
}

export function updateSession(
  id: string,
  patch: Partial<{
    status: SessionRow["status"];
    startedAt: number;
    endedAt: number;
    liveSessionId: string;
    recordingPath: string | null;
    recordingStatus: RecordingStatus;
    recordingError: string | null;
    transcript: TranscriptTurn[];
    timeline: TimelineEvent[];
    finalScene: unknown;
    finalImage: string | null;
    grade: GradeReport;
    gradeStatus: GradeStatus;
    gradeError: string | null;
  }>
): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const add = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.startedAt !== undefined) add("started_at", patch.startedAt);
  if (patch.endedAt !== undefined) add("ended_at", patch.endedAt);
  if (patch.liveSessionId !== undefined) add("live_session_id", patch.liveSessionId);
  if (patch.recordingPath !== undefined) add("recording_path", patch.recordingPath);
  if (patch.recordingStatus !== undefined) add("recording_status", patch.recordingStatus);
  if (patch.recordingError !== undefined) add("recording_error", patch.recordingError);
  if (patch.transcript !== undefined) add("transcript", JSON.stringify(patch.transcript));
  if (patch.timeline !== undefined) add("timeline", JSON.stringify(patch.timeline));
  if (patch.finalScene !== undefined) add("final_scene", JSON.stringify(patch.finalScene));
  if (patch.finalImage !== undefined) add("final_image", patch.finalImage);
  if (patch.grade !== undefined) add("grade", JSON.stringify(patch.grade));
  if (patch.gradeStatus !== undefined) add("grading_status", patch.gradeStatus);
  if (patch.gradeError !== undefined) add("grade_error", patch.gradeError);
  if (!sets.length) return;
  vals.push(id);
  getDb()
    .prepare(`UPDATE interview_sessions SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
}

function changed(result: { changes?: number | bigint }): boolean {
  return Number(result.changes ?? 0) > 0;
}

/** Atomically turns an ended, ungraded session into a running grading job. */
export function claimGrading(id: string): boolean {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `UPDATE interview_sessions
       SET grading_status = 'running', grading_started_at = ?, grade_error = NULL
       WHERE id = ?
         AND status = 'ended'
         AND grade IS NULL
         AND (grading_status != 'running' OR grading_started_at IS NULL OR grading_started_at < ?)`
    )
    .run(now, id, now - GRADING_CLAIM_STALE_MS) as { changes?: number | bigint };
  return changed(result);
}

export function finishGrading(id: string, grade: GradeReport): boolean {
  const result = getDb()
    .prepare(
      `UPDATE interview_sessions
       SET grade = ?, grading_status = 'done', grading_started_at = NULL, status = 'graded', grade_error = NULL
       WHERE id = ? AND grading_status = 'running'`
    )
    .run(JSON.stringify(grade), id) as { changes?: number | bigint };
  return changed(result);
}

export function failGrading(id: string, error: string): void {
  updateSession(id, {
    gradeStatus: "failed",
    gradeError: error.slice(0, 2000),
  });
}

export function claimRecording(id: string): boolean {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `UPDATE interview_sessions
       SET recording_status = 'running', recording_started_at = ?, recording_error = NULL
       WHERE id = ?
         AND status IN ('ended', 'graded')
         AND live_session_id IS NOT NULL
         AND recording_path IS NULL
         AND (recording_status != 'running' OR recording_started_at IS NULL OR recording_started_at < ?)`
    )
    .run(now, id, now - RECORDING_CLAIM_STALE_MS) as { changes?: number | bigint };
  return changed(result);
}

export function finishRecording(id: string, recordingPath: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE interview_sessions
       SET recording_path = ?, recording_status = 'done', recording_started_at = NULL, recording_error = NULL
       WHERE id = ? AND recording_status = 'running'`
    )
    .run(recordingPath, id) as { changes?: number | bigint };
  return changed(result);
}

export function failRecording(id: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE interview_sessions
       SET recording_status = 'failed', recording_started_at = NULL, recording_error = ?
       WHERE id = ?`
    )
    .run(error.slice(0, 2000), id);
}

export function markRecordingUnavailable(id: string, reason: string): void {
  updateSession(id, {
    recordingPath: "",
    recordingStatus: "unavailable",
    recordingError: reason.slice(0, 2000),
  });
}

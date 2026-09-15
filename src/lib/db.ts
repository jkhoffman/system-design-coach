import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { SessionRow, Briefing, PromptSpec, Mode, TranscriptTurn, TimelineEvent, GradeReport } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
export const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
export const RECORDING_DIR = path.join(DATA_DIR, "recordings");

function ensureDirs() {
  for (const d of [DATA_DIR, SNAPSHOT_DIR, RECORDING_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

const g = globalThis as unknown as { __appdb?: DatabaseSync };

// Lazy open so build-time module collection never touches the database file.
function getDb(): DatabaseSync {
  if (!g.__appdb) {
    ensureDirs();
    const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));
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
        grade TEXT
      )
    `);
    g.__appdb = db;
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
  transcript: string;
  timeline: string;
  final_scene: string | null;
  final_image: string | null;
  grade: string | null;
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
    transcript: JSON.parse(r.transcript) as TranscriptTurn[],
    timeline: JSON.parse(r.timeline) as TimelineEvent[],
    finalScene: r.final_scene ? JSON.parse(r.final_scene) : undefined,
    finalImage: r.final_image ?? undefined,
    grade: r.grade ? (JSON.parse(r.grade) as GradeReport) : undefined,
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

export function listSessions(): SessionRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM interview_sessions ORDER BY created_at DESC`)
    .all() as unknown as RawRow[];
  return rows.map(toRow);
}

export function updateSession(
  id: string,
  patch: Partial<{
    status: SessionRow["status"];
    startedAt: number;
    endedAt: number;
    liveSessionId: string;
    recordingPath: string;
    transcript: TranscriptTurn[];
    timeline: TimelineEvent[];
    finalScene: unknown;
    finalImage: string;
    grade: GradeReport;
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
  if (patch.transcript !== undefined) add("transcript", JSON.stringify(patch.transcript));
  if (patch.timeline !== undefined) add("timeline", JSON.stringify(patch.timeline));
  if (patch.finalScene !== undefined) add("final_scene", JSON.stringify(patch.finalScene));
  if (patch.finalImage !== undefined) add("final_image", patch.finalImage);
  if (patch.grade !== undefined) add("grade", JSON.stringify(patch.grade));
  if (!sets.length) return;
  vals.push(id);
  getDb()
    .prepare(`UPDATE interview_sessions SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
}

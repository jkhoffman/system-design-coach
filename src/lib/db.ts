import "server-only";
import { newId } from "./ids";
import { sanitizeTrace } from "./traceContracts";
import { readStoredGrade } from "./legacyContracts";
import { getDb } from "./database";
export { closeDb, SNAPSHOT_DIR, RECORDING_DIR } from "./database";
import type {
  SessionRow,
  Briefing,
  PromptSpec,
  Mode,
  TranscriptTurn,
  TimelineEvent,
  GradeStatus,
  RecordingStatus,
  SessionSummary,
} from "./types";


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
  live_trace: string | null;
  final_scene: string | null;
  final_image: string | null;
  final_image_path: string | null;
  grade: string | null;
  grading_status: string | null;
  grade_error: string | null;
  checkpoint_revision: number;
}

function toRow(r: RawRow): SessionRow {
  const gradeRead = readStoredGrade(r.grade);
  return {
    id: r.id,
    checkpointRevision: r.checkpoint_revision,
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
    liveTrace: r.live_trace ? (sanitizeTrace(JSON.parse(r.live_trace)) ?? []) : [],
    finalScene: r.final_scene ? JSON.parse(r.final_scene) : undefined,
    finalImage: r.final_image ?? undefined,
    finalImagePath: r.final_image_path ?? undefined,
    grade: gradeRead.state === "readable" ? gradeRead.grade : undefined,
    gradeReadError: gradeRead.state === "unreadable" ? gradeRead.reason : undefined,
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
              CASE WHEN json_valid(grade) THEN json_extract(grade, '$.overall.score') END AS score
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

import "server-only";
import { getDb } from "./database";
import { normalizeLegacyGrade } from "./legacyContracts";
import { sanitizeTrace } from "./traceContracts";
import type { Briefing, ClientSession, PromptSpec, SessionRow } from "./types";

function readClientSession(id: string, includeGrade: boolean): ClientSession | null {
  const row = getDb().prepare(`SELECT id, mode, status, duration_sec, created_at, started_at, ended_at, checkpoint_revision,
    json_extract(briefing, '$.company') AS company, json_extract(briefing, '$.position') AS position,
    json_extract(briefing, '$.level') AS level, json_extract(prompt, '$.id') AS prompt_id,
    json_extract(prompt, '$.title') AS title, json_extract(prompt, '$.question') AS question,
    transcript, timeline, ${includeGrade ? "grade" : "NULL AS grade"}, grading_status, grade_error, recording_status, recording_error,
    (recording_path IS NOT NULL AND recording_path != '') AS has_recording,
    (final_image_path IS NOT NULL OR final_image IS NOT NULL) AS has_image
    FROM interview_sessions WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    id, checkpointRevision: Number(row.checkpoint_revision), mode: row.mode as ClientSession["mode"],
    status: row.status as ClientSession["status"], durationSec: Number(row.duration_sec), createdAt: Number(row.created_at),
    startedAt: row.started_at == null ? undefined : Number(row.started_at), endedAt: row.ended_at == null ? undefined : Number(row.ended_at),
    briefing: { company: String(row.company ?? ""), position: String(row.position ?? ""), level: String(row.level ?? "") },
    prompt: { id: String(row.prompt_id), title: String(row.title), question: String(row.question) },
    transcript: JSON.parse(String(row.transcript)), timeline: JSON.parse(String(row.timeline)),
    grade: row.grade ? normalizeLegacyGrade(JSON.parse(String(row.grade))) : undefined,
    gradeStatus: row.grading_status as ClientSession["gradeStatus"], gradeError: row.grade_error == null ? undefined : String(row.grade_error),
    recordingStatus: row.recording_status as ClientSession["recordingStatus"], recordingError: row.recording_error == null ? undefined : String(row.recording_error),
    hasRecording: Boolean(row.has_recording), finalImageUrl: row.has_image ? `/api/sessions/${id}/image` : undefined,
  };
}

export const getRecoverySession = (id: string) => readClientSession(id, false);
export const getReviewSession = (id: string) => readClientSession(id, true);

export function getLiveSetup(id: string) {
  const row = getDb().prepare("SELECT id, status, briefing, prompt, duration_sec FROM interview_sessions WHERE id = ?").get(id);
  return row ? { id, status: row.status as SessionRow["status"], briefing: JSON.parse(String(row.briefing)) as Briefing,
    prompt: JSON.parse(String(row.prompt)) as PromptSpec, durationSec: Number(row.duration_sec) } : null;
}

export function getGradingSession(id: string) {
  const setup = getLiveSetup(id);
  if (!setup) return null;
  const row = getDb().prepare(`SELECT started_at, ended_at, transcript, timeline, grade, grading_status, grade_error
    FROM interview_sessions WHERE id = ?`).get(id)!;
  return { ...setup, startedAt: row.started_at == null ? undefined : Number(row.started_at),
    endedAt: row.ended_at == null ? undefined : Number(row.ended_at),
    transcript: JSON.parse(String(row.transcript)) as SessionRow["transcript"],
    timeline: JSON.parse(String(row.timeline)) as SessionRow["timeline"],
    grade: row.grade ? normalizeLegacyGrade(JSON.parse(String(row.grade))) : undefined,
    gradeStatus: row.grading_status as SessionRow["gradeStatus"], gradeError: row.grade_error,
  };
}

export function getRecordingSession(id: string) {
  const row = getDb().prepare(`SELECT status, live_session_id, recording_path, recording_status, recording_error
    FROM interview_sessions WHERE id = ?`).get(id);
  return row ? { id, status: row.status, liveSessionId: row.live_session_id == null ? undefined : String(row.live_session_id),
    recordingPath: row.recording_path == null ? undefined : String(row.recording_path),
    recordingStatus: row.recording_status, recordingError: row.recording_error } : null;
}

export function getFinalImageReference(id: string) {
  const row = getDb().prepare("SELECT final_image_path, final_image FROM interview_sessions WHERE id = ?").get(id);
  return row ? { path: row.final_image_path == null ? undefined : String(row.final_image_path),
    inline: row.final_image == null ? undefined : String(row.final_image) } : null;
}

export function getSessionDiagnostics(id: string) {
  const row = getDb().prepare(`SELECT status, live_session_id, started_at, ended_at, live_trace,
    json_array_length(transcript) AS transcript_turns, json_array_length(timeline) AS timeline_events
    FROM interview_sessions WHERE id = ?`).get(id);
  return row ? { session: { id, status: row.status, liveSessionId: row.live_session_id,
    startedAt: row.started_at, endedAt: row.ended_at, transcriptTurns: Number(row.transcript_turns), timelineEvents: Number(row.timeline_events) },
    trace: sanitizeTrace(JSON.parse(String(row.live_trace ?? "[]"))) ?? [] } : null;
}

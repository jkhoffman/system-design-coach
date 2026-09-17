import "server-only";
import crypto from "node:crypto";
import { getDb } from "./database";
import type { GradeReport, SessionStatus } from "./types";
import type { JobKind, JobState, SessionJobStatus } from "./jobTypes";

export const JOB_TIMING = {
  grade: { timeoutMs: 110_000, leaseMs: 150_000 },
  recording: { timeoutMs: 45_000, leaseMs: 75_000 },
} as const;
const columns = { grade: "grading", recording: "recording" } as const;
export interface JobAttempt { id: string; kind: JobKind; token: string; expiresAt: number }

export function claimJob(id: string, kind: JobKind): JobAttempt | null {
  const prefix = columns[kind];
  const token = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + JOB_TIMING[kind].leaseMs;
  const eligible = kind === "grade" ? "status = 'ended' AND grade IS NULL" :
    "status IN ('ended', 'graded') AND live_session_id IS NOT NULL AND recording_path IS NULL";
  const result = getDb().prepare(`UPDATE interview_sessions
    SET ${prefix}_status = 'running', ${prefix}_started_at = ?, ${prefix}_attempt = ?, ${prefix}_expires_at = ?,
        ${kind === "grade" ? "grade" : "recording"}_error = NULL
    WHERE id = ? AND ${eligible} AND ${prefix}_status != 'unavailable'
      AND (${prefix}_status != 'running' OR ${prefix}_expires_at IS NULL OR ${prefix}_expires_at <= ?)`)
    .run(now, token, expiresAt, id, now);
  return result.changes ? { id, kind, token, expiresAt } : null;
}

export function ownsJob(attempt: JobAttempt): boolean {
  const prefix = columns[attempt.kind];
  return Boolean(getDb().prepare(`SELECT id FROM interview_sessions WHERE id = ?
    AND ${prefix}_status = 'running' AND ${prefix}_attempt = ? AND ${prefix}_expires_at > ?`)
    .get(attempt.id, attempt.token, Date.now()));
}

export function failJob(attempt: JobAttempt, error: string): boolean {
  const prefix = columns[attempt.kind];
  return Boolean(getDb().prepare(`UPDATE interview_sessions
    SET ${prefix}_status = 'failed', ${prefix}_started_at = NULL, ${prefix}_expires_at = NULL,
        ${prefix}_attempt = NULL, ${attempt.kind === "grade" ? "grade" : "recording"}_error = ?
    WHERE id = ? AND ${prefix}_status = 'running' AND ${prefix}_attempt = ? AND ${prefix}_expires_at > ?`)
    .run(error.slice(0, 2000), attempt.id, attempt.token, Date.now()).changes);
}

export function finishGrading(attempt: JobAttempt, grade: GradeReport): boolean {
  if (attempt.kind !== "grade") return false;
  return Boolean(getDb().prepare(`UPDATE interview_sessions
    SET grade = ?, status = 'graded', grading_status = 'done', grading_started_at = NULL,
        grading_attempt = NULL, grading_expires_at = NULL, grade_error = NULL
    WHERE id = ? AND grading_status = 'running' AND grading_attempt = ? AND grading_expires_at > ?`)
    .run(JSON.stringify(grade), attempt.id, attempt.token, Date.now()).changes);
}

export function finishRecording(attempt: JobAttempt, recordingPath: string): boolean {
  if (attempt.kind !== "recording") return false;
  return Boolean(getDb().prepare(`UPDATE interview_sessions
    SET recording_path = ?, recording_status = 'done', recording_started_at = NULL,
        recording_attempt = NULL, recording_expires_at = NULL, recording_error = NULL
    WHERE id = ? AND recording_status = 'running' AND recording_attempt = ? AND recording_expires_at > ?`)
    .run(recordingPath, attempt.id, attempt.token, Date.now()).changes);
}

export function resetMissingRecording(id: string, expectedPath: string): void {
  getDb().prepare(`UPDATE interview_sessions SET recording_path = NULL, recording_status = 'idle', recording_error = NULL
    WHERE id = ? AND recording_path = ? AND recording_status = 'done'`).run(id, expectedPath);
}

export function getSessionJobStatus(id: string): SessionJobStatus | null {
  const row = getDb().prepare(`SELECT id, status, grading_status, grade_error, grading_expires_at,
    recording_status, recording_error, recording_expires_at FROM interview_sessions WHERE id = ?`).get(id);
  if (!row) return null;
  const state = (kind: JobKind): JobState => {
    const prefix = columns[kind];
    const status = row[`${prefix}_status`] as JobState["status"];
    const expiry = row[`${prefix}_expires_at`];
    return {
      status, error: (row[`${kind}_error`] as string | null) ?? undefined,
      leaseExpiresAt: expiry == null ? undefined : Number(expiry),
      stale: status === "running" && (expiry == null || Number(expiry) <= Date.now()),
    };
  };
  return { id, status: row.status as SessionStatus, grade: state("grade"), recording: state("recording") };
}

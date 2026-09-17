import "server-only";
import crypto from "node:crypto";
import { getDb } from "./database";
import type { SessionRow, SessionStatus } from "./types";

export const START_LEASE_MS = 45_000;
export const START_TIMEOUT_MS = 30_000;

export interface SessionAcknowledgment {
  id: string;
  status: SessionStatus;
  revision: number;
}

export function getSessionAcknowledgment(id: string): SessionAcknowledgment | null {
  return (getDb().prepare(`SELECT id, status, checkpoint_revision AS revision
    FROM interview_sessions WHERE id = ?`).get(id) as unknown as SessionAcknowledgment) ?? null;
}

export function reserveSessionStart(id: string): string | null {
  const token = crypto.randomUUID();
  const now = Date.now();
  const result = getDb().prepare(`UPDATE interview_sessions SET start_token = ?, start_expires_at = ?
    WHERE id = ? AND status = 'created'
    AND (start_token IS NULL OR start_expires_at <= ?)`).run(token, now + START_LEASE_MS, id, now);
  return result.changes ? token : null;
}

export function releaseSessionStart(id: string, token: string): void {
  getDb().prepare(`UPDATE interview_sessions SET start_token = NULL, start_expires_at = NULL
    WHERE id = ? AND status = 'created' AND start_token = ?`).run(id, token);
}

export function completeSessionStart(id: string, token: string, liveSessionId: string, storageAllowed = true): boolean {
  const now = Date.now();
  return Boolean(getDb().prepare(`UPDATE interview_sessions
    SET status = 'live', started_at = ?, live_session_id = ?, start_token = NULL, start_expires_at = NULL,
        recording_status = ?, recording_path = ?, recording_error = ?
    WHERE id = ? AND status = 'created' AND start_token = ? AND start_expires_at > ?`)
    .run(now, liveSessionId, storageAllowed ? "idle" : "unavailable", storageAllowed ? null : "",
      storageAllowed ? null : "session storage not permitted on project", id, token, now).changes);
}

type InterviewContent = Pick<SessionRow, "transcript" | "timeline" | "liveTrace">;

export function saveSessionProgress(id: string, input: InterviewContent & { revision: number }): boolean {
  return Boolean(getDb().prepare(`UPDATE interview_sessions
    SET transcript = ?, timeline = ?, live_trace = COALESCE(?, live_trace), checkpoint_revision = ?
    WHERE id = ? AND status = 'live' AND checkpoint_revision < ?`)
    .run(JSON.stringify(input.transcript), JSON.stringify(input.timeline),
      input.liveTrace === undefined ? null : JSON.stringify(input.liveTrace), input.revision, id, input.revision).changes);
}

export type FinishInput = InterviewContent & {
  endedAt: number;
  finalScene?: unknown;
  finalImage?: string | null;
};

/** First finish wins; every retry observes the same immutable interview content. */
export function finishSession(id: string, input: FinishInput): "saved" | "already_finished" | "not_found" | "not_live" | "invalid_time" {
  const row = getDb().prepare("SELECT status, started_at FROM interview_sessions WHERE id = ?").get(id);
  if (!row) return "not_found";
  if (row.status === "ended" || row.status === "graded") return "already_finished";
  if (row.status !== "live") return "not_live";
  if (input.endedAt > Date.now() + 60_000 || (row.started_at && input.endedAt < Number(row.started_at))) return "invalid_time";
  const result = getDb().prepare(`UPDATE interview_sessions
    SET status = 'ended', ended_at = ?, transcript = ?, timeline = ?, live_trace = COALESCE(?, live_trace),
        final_scene = COALESCE(?, final_scene), final_image = CASE WHEN ? THEN ? ELSE final_image END
    WHERE id = ? AND status = 'live'`)
    .run(input.endedAt, JSON.stringify(input.transcript), JSON.stringify(input.timeline),
      input.liveTrace === undefined ? null : JSON.stringify(input.liveTrace),
      input.finalScene === undefined ? null : JSON.stringify(input.finalScene),
      input.finalImage !== undefined ? 1 : 0, input.finalImage ?? null, id);
  if (result.changes) return "saved";
  return "already_finished";
}

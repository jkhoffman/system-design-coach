import "server-only";
import crypto from "node:crypto";
import { getDb } from "./database";
import { OWNER_LEASE_MS, type SessionOwner } from "./ownership";
import type { SessionRow, SessionStatus } from "./types";

export const START_LEASE_MS = 90_000;
export const START_TIMEOUT_MS = 30_000;
export interface SessionAcknowledgment { id: string; status: SessionStatus; revision: number }
export function getSessionAcknowledgment(id: string): SessionAcknowledgment | null {
  return (getDb().prepare(`SELECT id, status, checkpoint_revision AS revision
    FROM interview_sessions WHERE id = ?`).get(id) as unknown as SessionAcknowledgment) ?? null;
}
function transaction<T>(work: () => T): T {
  const db = getDb(); db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function reserveSessionStart(id: string, token: string = crypto.randomUUID()): string | null {
  return transaction(() => {
    const db = getDb();
    const result = db.prepare(`UPDATE interview_sessions SET start_token = ?, start_expires_at = ?
      WHERE id = ? AND status = 'created' AND start_token IS NULL
      AND NOT EXISTS (SELECT 1 FROM connection_attempts WHERE session_id = ? AND cleanup IN ('pending', 'unknown'))`)
      .run(token, Date.now() + START_LEASE_MS, id, id);
    if (!result.changes) return null;
    db.prepare("INSERT INTO connection_attempts(session_id, token, created_at) VALUES (?, ?, ?)").run(id, token, Date.now());
    return token;
  });
}
export function attemptOwner(id: string, token: string): SessionOwner | null {
  const row = getDb().prepare("SELECT generation FROM connection_attempts WHERE session_id = ? AND token = ?").get(id, token);
  return row ? { ownerToken: token, generation: Number(row.generation) } : null;
}
/** Store the provider identity even if cancellation or lease expiry won the race. */
export function recordUpstream(id: string, token: string, upstreamId: string, storageAllowed = true): void {
  getDb().prepare(`UPDATE connection_attempts SET upstream_id = ?, storage_allowed = ?,
    cleanup = CASE WHEN state = 'retired' THEN 'pending' ELSE 'none' END, cleanup_error = NULL WHERE session_id = ? AND token = ?`)
    .run(upstreamId, storageAllowed ? 1 : 0, id, token);
}
export function markUnknownStart(id: string, token: string): void {
  getDb().prepare(`UPDATE connection_attempts SET cleanup = 'unknown',
    cleanup_error = 'Provider creation outcome unknown; no session ID was received.'
    WHERE session_id = ? AND token = ? AND upstream_id IS NULL`).run(id, token);
}
export function clearUnknownStart(id: string, token: string): void {
  getDb().prepare(`UPDATE connection_attempts SET cleanup = 'none', cleanup_error = NULL
    WHERE session_id = ? AND token = ? AND upstream_id IS NULL`).run(id, token);
}
export function releaseSessionStart(id: string, token: string): void {
  transaction(() => {
    getDb().prepare(`UPDATE connection_attempts SET state = 'retired',
      cleanup = CASE WHEN upstream_id IS NOT NULL THEN 'pending' ELSE cleanup END
      WHERE session_id = ? AND token = ? AND state != 'retired'`).run(id, token);
    // A confirmed interview keeps its checkpoint and becomes explicitly recoverable.
    getDb().prepare(`UPDATE interview_sessions SET start_expires_at = 0,
      start_token = CASE WHEN status = 'created' THEN NULL ELSE start_token END
      WHERE id = ? AND start_token = ?`).run(id, token);
  });
}
export function expireSessionStarts(id?: string): void {
  const rows = getDb().prepare(`SELECT id, start_token FROM interview_sessions
    WHERE status = 'created' AND start_token IS NOT NULL AND start_expires_at <= ? ${id ? "AND id = ?" : ""}`)
    .all(Date.now(), ...(id ? [id] : []));
  for (const row of rows) releaseSessionStart(String(row.id), String(row.start_token));
}
/** Provider creation prepares an attempt; only browser confirmation makes it live. */
export function completeSessionStart(id: string, token: string, liveSessionId: string, storageAllowed = true): boolean {
  recordUpstream(id, token, liveSessionId, storageAllowed);
  return Boolean(getDb().prepare(`UPDATE connection_attempts SET state = 'ready'
    WHERE session_id = ? AND token = ? AND state = 'starting' AND EXISTS (
      SELECT 1 FROM interview_sessions WHERE id = ? AND status = 'created' AND start_token = ? AND start_expires_at > ?)`)
    .run(id, token, id, token, Date.now()).changes);
}
export function confirmSessionStart(id: string, owner: SessionOwner): boolean {
  return transaction(() => {
    const db = getDb();
    const attempt = db.prepare(`SELECT upstream_id, storage_allowed FROM connection_attempts
      WHERE session_id = ? AND token = ? AND generation = ? AND state IN ('ready', 'confirmed')`)
      .get(id, owner.ownerToken, owner.generation);
    if (!attempt?.upstream_id) return false;
    const now = Date.now();
    const result = db.prepare(`UPDATE interview_sessions SET status = 'live', started_at = COALESCE(started_at, ?),
      live_session_id = ?, start_expires_at = ?, recording_status = ?, recording_path = ?, recording_error = ?
      WHERE id = ? AND status IN ('created', 'live') AND start_token = ? AND start_expires_at > ?`)
      .run(now, attempt.upstream_id, now + OWNER_LEASE_MS, attempt.storage_allowed ? "idle" : "unavailable",
        attempt.storage_allowed ? null : "", attempt.storage_allowed ? null : "session storage not permitted on project",
        id, owner.ownerToken, now);
    if (!result.changes) return false;
    db.prepare("UPDATE connection_attempts SET state = 'confirmed' WHERE token = ?").run(owner.ownerToken);
    return true;
  });
}
const ownershipWhere = `start_token = ? AND start_expires_at > ? AND EXISTS (
  SELECT 1 FROM connection_attempts WHERE session_id = interview_sessions.id AND token = start_token
    AND generation = ? AND state = 'confirmed')`;
export function ownsSession(id: string, owner: SessionOwner): boolean {
  return Boolean(getDb().prepare(`SELECT id FROM interview_sessions WHERE id = ? AND status = 'live' AND ${ownershipWhere}`)
    .get(id, owner.ownerToken, Date.now(), owner.generation));
}
export function renewSessionOwner(id: string, owner: SessionOwner): boolean {
  return Boolean(getDb().prepare(`UPDATE interview_sessions SET start_expires_at = ?
    WHERE id = ? AND status = 'live' AND ${ownershipWhere}`)
    .run(Date.now() + OWNER_LEASE_MS, id, owner.ownerToken, Date.now(), owner.generation).changes);
}
type InterviewContent = Pick<SessionRow, "transcript" | "timeline" | "liveTrace">;
export function saveSessionProgress(id: string, input: InterviewContent & SessionOwner & { revision: number }): boolean {
  return Boolean(getDb().prepare(`UPDATE interview_sessions
    SET transcript = ?, timeline = ?, live_trace = COALESCE(?, live_trace), checkpoint_revision = ?
    WHERE id = ? AND status = 'live' AND checkpoint_revision < ? AND ${ownershipWhere}`)
    .run(JSON.stringify(input.transcript), JSON.stringify(input.timeline),
      input.liveTrace === undefined ? null : JSON.stringify(input.liveTrace), input.revision, id, input.revision,
      input.ownerToken, Date.now(), input.generation).changes);
}
export type FinishInput = InterviewContent & SessionOwner & {
  requestId: string; endedAt: number; finalScene?: unknown; finalImage?: string | null; finalImagePath?: string | null;
};
export function finishSession(id: string, input: FinishInput, payloadHash?: string):
  "saved" | "already_saved_by_this_request" | "not_found" | "ownership_conflict" | "invalid_time" {
  const hash = payloadHash ?? crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return transaction(() => {
    const db = getDb();
    const row = db.prepare("SELECT status, started_at, finish_key, finish_hash, start_token FROM interview_sessions WHERE id = ?").get(id);
    if (!row) return "not_found";
    if (row.status === "ended" || row.status === "graded") {
      return row.finish_key === input.requestId && row.finish_hash === hash && row.start_token === input.ownerToken
        ? "already_saved_by_this_request" : "ownership_conflict";
    }
    if (!ownsSession(id, input)) return "ownership_conflict";
    if (input.endedAt > Date.now() + 60_000 || (row.started_at && input.endedAt < Number(row.started_at))) return "invalid_time";
    db.prepare(`UPDATE interview_sessions SET status = 'ended', ended_at = ?, transcript = ?, timeline = ?,
      live_trace = COALESCE(?, live_trace), final_scene = COALESCE(?, final_scene),
      final_image = ?, final_image_path = ?, finish_key = ?, finish_hash = ? WHERE id = ?`)
      .run(input.endedAt, JSON.stringify(input.transcript), JSON.stringify(input.timeline),
        input.liveTrace === undefined ? null : JSON.stringify(input.liveTrace),
        input.finalScene === undefined ? null : JSON.stringify(input.finalScene), input.finalImage ?? null,
        input.finalImagePath ?? null, input.requestId, hash, id);
    return "saved";
  });
}
/** Recovery consumes the latest persisted content inside the same write transaction. */
export function recoverSession(id: string, requestId: string): "saved" | "already_saved_by_this_request" | "ownership_conflict" | "not_found" {
  return transaction(() => {
    const db = getDb();
    const row = db.prepare("SELECT status, start_token, start_expires_at, finish_key, finish_hash FROM interview_sessions WHERE id = ?").get(id);
    if (!row) return "not_found";
    if (row.finish_key === requestId && row.finish_hash === "recovery") return "already_saved_by_this_request";
    if (row.status !== "live" || Number(row.start_expires_at) > Date.now()) return "ownership_conflict";
    db.prepare(`UPDATE interview_sessions SET status = 'ended', ended_at = ?, finish_key = ?, finish_hash = 'recovery' WHERE id = ?`)
      .run(Date.now(), requestId, id);
    if (row.start_token) db.prepare(`UPDATE connection_attempts SET state = 'retired',
      cleanup = CASE WHEN upstream_id IS NOT NULL THEN 'pending' ELSE cleanup END WHERE token = ?`).run(row.start_token);
    return "saved";
  });
}

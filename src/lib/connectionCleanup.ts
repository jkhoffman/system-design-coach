import "server-only";
import { getDb } from "./database";
import { expireSessionStarts } from "./sessionCommands";
import { openAiUrl } from "./openai";
import { delay } from "./async";

/** Idempotent hang-up has its own deadline, independent of an aborted browser request. */
export async function reconcileConnections(id?: string): Promise<void> {
  expireSessionStarts(id);
  const rows = getDb().prepare(`SELECT token, upstream_id FROM connection_attempts
    WHERE cleanup = 'pending' ${id ? "AND session_id = ?" : ""}`).all(...(id ? [id] : []));
  for (const row of rows) {
    let failure = "Unable to close abandoned provider session";
    for (let retry = 0; retry < 3; retry++) {
      try {
        const response = await fetch(openAiUrl(`/live/sessions/${encodeURIComponent(String(row.upstream_id))}/hangup`), {
          method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          signal: AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        if (response.ok || response.status === 404 || response.status === 410) {
          getDb().prepare("UPDATE connection_attempts SET cleanup = 'done', cleanup_error = NULL WHERE token = ?").run(row.token);
          failure = ""; break;
        }
        failure = `Provider hang-up failed (${response.status})`;
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      if (retry < 2) await delay(250 * (retry + 1));
    }
    if (failure) getDb().prepare("UPDATE connection_attempts SET cleanup_error = ? WHERE token = ?").run(failure, row.token);
  }
}
export function connectionBlocker(id: string): string | null {
  const row = getDb().prepare(`SELECT cleanup, cleanup_error FROM connection_attempts
    WHERE session_id = ? AND cleanup IN ('pending', 'unknown') LIMIT 1`).get(id);
  if (!row) return null;
  return row.cleanup === "unknown"
    ? "The provider did not return a session ID. This connection needs reconciliation before another attempt can start."
    : `The previous connection could not be closed. Retry to close it before joining. ${row.cleanup_error ?? ""}`;
}

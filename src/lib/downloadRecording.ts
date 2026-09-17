import "server-only";
import { publishRecording, RecordingContentError } from "./artifacts";
import { openAiUrl } from "./openai";
import type { JobAttempt } from "./sessionJobs";
import { delay } from "./async";
class PermanentDownloadError extends Error {}
export function retryAfterMs(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.min(60_000, ms)) : fallback;
}
export async function downloadRecording(attempt: JobAttempt, liveSessionId: string, signal: AbortSignal,
  options: { headerMs?: number; idleMs?: number; backoffMs?: number } = {}): Promise<void> {
  for (let retry = 0; ; retry++) {
    signal.throwIfAborted();
    let backoff = (options.backoffMs ?? 2500) * (retry + 1);
    const headersDeadline = new AbortController();
    const timer = setTimeout(() => headersDeadline.abort(new Error("Recording response headers timed out")), options.headerMs ?? 30_000);
    try {
      const response = await fetch(openAiUrl(`/live/sessions/${encodeURIComponent(liveSessionId)}/content`), {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        signal: AbortSignal.any([signal, headersDeadline.signal]),
      });
      clearTimeout(timer);
      if (!response.ok) {
        backoff = retryAfterMs(response.headers.get("retry-after"), backoff);
        await response.body?.cancel();
        const retryable = [404, 408, 409, 429].includes(response.status) || response.status >= 500;
        const message = `Recording fetch failed (${response.status})`;
        if (!retryable) throw new PermanentDownloadError(message);
        throw new Error(message);
      }
      await publishRecording(response, attempt, signal, options.idleMs);
      return;
    } catch (error) {
      if (signal.aborted || retry === 3 || error instanceof PermanentDownloadError || error instanceof RecordingContentError) throw error;
    } finally { clearTimeout(timer); headersDeadline.abort(); }
    await delay(backoff, signal);
  }
}

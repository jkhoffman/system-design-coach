import { delay } from "./async";
import { fetchJson } from "./clientApi";
import type { z } from "zod";
import type { SessionPatchSchema } from "./schemas";
export type FinalPayload = Extract<z.infer<typeof SessionPatchSchema>, { kind: "finish" }>;

export async function persistFinalSession(id: string, payload: FinalPayload, signal: AbortSignal): Promise<void> {
  const body = JSON.stringify(payload);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      await fetchJson(`/api/sessions/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      return;
    } catch (error) {
      if (signal.aborted || attempt === 3) throw error;
      await delay(750 * (attempt + 1), signal);
    }
  }
}

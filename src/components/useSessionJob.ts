"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/clientApi";
import { watchJob } from "@/lib/pollJob";
import type { JobKind, JobState, SessionJobStatus } from "@/lib/jobTypes";

export function useSessionJob(sessionId: string, kind: JobKind, onDone?: () => void) {
  const [job, setJob] = useState<JobState>({ status: "idle", stale: false });
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  useEffect(() => watchJob({
    async load(signal) {
      const session = await fetchJson<SessionJobStatus>(`/api/sessions/${sessionId}/status`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (session.status !== "ended" && session.status !== "graded") throw new Error("The interview has not been saved as ended yet.");
      return session[kind];
    },
    async start(signal) {
      await fetchJson(`/api/sessions/${sessionId}/${kind}`, {
        method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(130_000)]),
      });
    },
    onState(state) { setJob(state); setError(null); },
    onError: setError,
    onDone,
    retryFailed: retryNonce > 0,
  }), [sessionId, kind, retryNonce, onDone]);

  const retry = () => { setError(null); setRetryNonce((n) => n + 1); };
  return { job, error, retry };
}

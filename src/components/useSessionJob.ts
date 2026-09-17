"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/clientApi";
import { JOB_CLIENT_TIMEOUT_MS } from "@/lib/jobTiming";
import { watchJob } from "@/lib/pollJob";
import type { JobKind, JobState, SessionJobStatus } from "@/lib/jobTypes";

export function useSessionJob(sessionId: string, kind: JobKind, onDone?: () => void, options: { initial?: JobState; manual?: boolean; repair?: boolean } = {}) {
  const [job, setJob] = useState<JobState>(options.initial ?? { status: "idle", stale: false });
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const initialStatus = options.initial?.status;
  const manual = options.manual;
  const repair = options.repair;
  useEffect(() => {
    if (retryNonce === 0 && (manual || initialStatus === "done" || initialStatus === "unavailable")) return;
    return watchJob({
      async load(signal) {
        const session = await fetchJson<SessionJobStatus>(`/api/sessions/${sessionId}/status`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        if (session.status !== "ended" && session.status !== "graded") throw new Error("The interview has not been saved as ended yet.");
        return session[kind];
      },
      async start(signal) {
        await fetchJson(`/api/sessions/${sessionId}/${kind}${repair || (kind === "recording" && retryNonce > 0) ? "?repair=true" : ""}`, {
          method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(JOB_CLIENT_TIMEOUT_MS[kind])]),
        });
      },
      onState(state) { setJob(state); setError(null); },
      onError: setError,
      onDone,
      retryFailed: retryNonce > 0,
      maxPolls: Math.ceil(JOB_CLIENT_TIMEOUT_MS[kind] / 3000) + 20,
    });
  }, [sessionId, kind, retryNonce, onDone, initialStatus, manual, repair]);

  const retry = () => { setError(null); setRetryNonce((n) => n + 1); };
  return { job, error, retry };
}

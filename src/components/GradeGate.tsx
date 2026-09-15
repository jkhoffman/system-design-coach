"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ClientSession } from "@/lib/types";

/** Polls the persisted grading job and starts it only after the interview has been saved as ended. */
export default function GradeGate({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const attemptedRetry = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let requesting = false;

    const tick = async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`);
        if (!res.ok) throw new Error(`could not load session (${res.status})`);
        const data = (await res.json()) as { session?: ClientSession };
        const session = data.session;
        if (!session) throw new Error("session not found");
        if (session.grade) {
          if (!cancelled) router.refresh();
          return;
        }
        if (session.gradeStatus === "failed" && attemptedRetry.current === retryNonce) {
          if (!cancelled) setError(session.gradeError ?? "grading failed");
          return;
        }
        if (session.gradeStatus === "failed") attemptedRetry.current = retryNonce;
        if (session.status !== "ended" && session.status !== "graded") {
          if (!cancelled) setError("The interview has not been saved as ended yet.");
          return;
        }
        if (session.gradeStatus !== "running" && !requesting) {
          requesting = true;
          try {
            const gradeRes = await fetch(`/api/sessions/${sessionId}/grade`, { method: "POST" });
            const gradeData = (await gradeRes.json().catch(() => ({}))) as {
              grade?: ClientSession["grade"];
              error?: string;
            };
            if (gradeRes.ok && gradeData.grade) {
              if (!cancelled) router.refresh();
              return;
            }
            if (!gradeRes.ok && gradeRes.status !== 202) {
              throw new Error(gradeData.error ?? `grading failed (${gradeRes.status})`);
            }
          } finally {
            requesting = false;
          }
        }
        timer = setTimeout(() => void tick(), 3000);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, router, retryNonce]);

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-center">
      <p className="text-neutral-300">Generating your scorecard…</p>
      <p className="mt-1 text-sm text-neutral-500">Reading the transcript and your diagram.</p>
      {error && (
        <>
          <p className="mt-3 text-sm text-red-400">{error}</p>
          <button
            onClick={() => {
              setError(null);
              setRetryNonce((n) => n + 1);
            }}
            className="mt-4 rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800"
          >
            Retry grading
          </button>
        </>
      )}
    </div>
  );
}

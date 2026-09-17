"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSessionJob } from "./useSessionJob";

/** Polls the persisted grading job and starts it only after the interview has been saved as ended. */
export default function GradeGate({ sessionId, readError }: { sessionId: string; readError?: string }) {
  const router = useRouter();
  const onDone = useCallback(() => router.refresh(), [router]);
  const { job, error, retry } = useSessionJob(sessionId, "grade", onDone, { manual: Boolean(readError), repair: Boolean(readError) });

  const running = job.status === "running";
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-center">
      <p className="text-neutral-300">{readError && !running ? "Saved scorecard needs recovery" : "Generating your scorecard…"}</p>
      <p className="mt-1 text-sm text-neutral-500">Reading the transcript and your diagram.</p>
      {(error || (readError && !running)) && (
        <>
          <p className="mt-3 text-sm text-red-400">{error ?? readError}</p>
          <button
            onClick={retry}
            className="mt-4 rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800"
          >
            Retry grading
          </button>
        </>
      )}
    </div>
  );
}

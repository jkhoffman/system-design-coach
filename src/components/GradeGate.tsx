"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** When a session has no grade yet, kick off grading and poll until it lands. */
export default function GradeGate({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const run = async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/grade`, { method: "POST" });
        if (!res.ok) throw new Error((await res.json()).error ?? "grading failed");
        if (!cancelled) router.refresh();
        return;
      } catch (e) {
        tries++;
        if (tries > 3) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
          return;
        }
        setTimeout(run, 4000);
      }
    };
    void run();
    // also poll in case grading was started by the interview page
    const poll = setInterval(async () => {
      const r = await fetch(`/api/sessions/${sessionId}`);
      const d = await r.json();
      if (d.session?.grade && !cancelled) {
        clearInterval(poll);
        router.refresh();
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [sessionId, router]);

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-center">
      <p className="text-neutral-300">Generating your scorecard…</p>
      <p className="mt-1 text-sm text-neutral-500">Reading the transcript and your diagram.</p>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </div>
  );
}

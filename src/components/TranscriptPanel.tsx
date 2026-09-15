"use client";

import { useEffect, useRef } from "react";
import type { TimelineEvent } from "@/lib/types";
import { fmtMs } from "@/lib/rubric";

export default function TranscriptPanel({ events }: { events: TimelineEvent[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-800 px-3 py-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
        Live transcript
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3 text-sm">
        {events.length === 0 && (
          <p className="text-neutral-600">The conversation will appear here.</p>
        )}
        {events.map((e, i) => {
          if (e.kind === "turn") {
            const isCandidate = e.speaker === "candidate";
            return (
              <div key={i} className={isCandidate ? "text-neutral-200" : "text-sky-300"}>
                <span className="mr-1 text-[10px] text-neutral-600">{fmtMs(e.startMs)}</span>
                <span className="font-medium">{isCandidate ? "You" : "Interviewer"}:</span>{" "}
                {e.text}
              </div>
            );
          }
          if (e.kind === "board") {
            return (
              <div key={i} className="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[11px] text-neutral-500">
                <span className="text-neutral-600">{fmtMs(e.startMs)}</span> whiteboard ·{" "}
                {e.summary.split("\n")[0].slice(0, 90)}
                {e.summary.length > 90 ? "…" : ""}
              </div>
            );
          }
          if (e.kind === "marker") {
            return (
              <div key={i} className="text-center text-[11px] text-neutral-600">
                — {fmtMs(e.startMs)} · {e.label} —
              </div>
            );
          }
          return null;
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}

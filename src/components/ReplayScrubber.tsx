"use client";

import { useRef, useState } from "react";
import type { SessionRow } from "@/lib/types";
import { fmtMs } from "@/lib/rubric";

/**
 * Audio replay + synchronized view of the interview: WAV recording (candidate
 * left / interviewer right), milestone board snapshots, and the time-coded
 * transcript.
 */
export default function ReplayScrubber({ session }: { session: SessionRow }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [cursorMs, setCursorMs] = useState(0);
  const snapshots = session.timeline.filter(
    (e): e is Extract<typeof e, { kind: "snapshot" }> => e.kind === "snapshot"
  );
  const hasRecording = Boolean(session.recordingPath);

  const seekTo = (ms: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = ms / 1000;
    void a.play();
  };

  return (
    <div className="space-y-4">
      {hasRecording ? (
        <audio
          ref={audioRef}
          controls
          src={`/api/sessions/${session.id}/recording`}
          onTimeUpdate={(e) => setCursorMs(e.currentTarget.currentTime * 1000)}
          className="w-full"
        />
      ) : (
        <p className="text-sm text-neutral-500">
          No recording available (session storage may be disabled on the API project).
        </p>
      )}

      {snapshots.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-neutral-400">Board evolution</h4>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {snapshots.map((s, i) => (
              <button
                key={i}
                onClick={() => seekTo(s.startMs)}
                className="shrink-0 text-left"
                title={`t=${fmtMs(s.startMs)}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/sessions/${session.id}/snapshot?file=${s.file}`}
                  alt={`whiteboard at ${fmtMs(s.startMs)}`}
                  className="h-24 rounded border border-neutral-800"
                />
                <div className="mt-0.5 text-center text-[10px] text-neutral-500">
                  {fmtMs(s.startMs)}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <h4 className="mb-2 text-sm font-medium text-neutral-400">Transcript</h4>
        <div className="max-h-96 space-y-1.5 overflow-y-auto rounded-lg border border-neutral-800 p-3 text-sm">
          {session.transcript.length === 0 && (
            <p className="text-neutral-600">No transcript recorded.</p>
          )}
          {session.transcript.map((t, i) => {
            const active = cursorMs >= t.startMs && cursorMs <= t.endMs + 500;
            return (
              <button
                key={i}
                onClick={() => seekTo(t.startMs)}
                className={`block w-full rounded px-2 py-1 text-left ${
                  active ? "bg-neutral-800" : "hover:bg-neutral-900"
                }`}
              >
                <span className="mr-2 text-[10px] text-neutral-600">{fmtMs(t.startMs)}</span>
                <span
                  className={`font-medium ${
                    t.speaker === "candidate" ? "text-neutral-300" : "text-sky-400"
                  }`}
                >
                  {t.speaker === "candidate" ? "You" : "Interviewer"}:
                </span>{" "}
                <span className="text-neutral-300">{t.text}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

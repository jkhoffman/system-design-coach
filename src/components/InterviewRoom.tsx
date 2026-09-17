"use client";

import { useState } from "react";
import Link from "next/link";
import Whiteboard from "./Whiteboard";
import TranscriptPanel from "./TranscriptPanel";
import TimerChip from "./TimerChip";
import { useInterviewController } from "./useInterviewController";
import type { ClientSession } from "@/lib/types";

export default function InterviewRoom({ session }: { session: ClientSession }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const { phase, statusDetail, elapsedSec, muted, thinking, events, error, checkpointError,
    start, endInterview, saveAndFinish, recoverSavedInterview, toggleMute, onBoardApi, onWhiteboardChange,
  } = useInterviewController(session);

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="font-semibold">{session.prompt.title}</span>
          <span className="text-sm text-neutral-500">
            {session.briefing.company} · {session.briefing.level} {session.briefing.position}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <TimerChip elapsedSec={elapsedSec} totalSec={session.durationSec} live={phase === "live"} />
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              phase === "live" ? (thinking ? "bg-amber-400" : "bg-emerald-400") : "bg-neutral-600"
            }`}
            title={thinking ? "interviewer thinking" : "status"}
          />
          <button
            onClick={() => setShowPrompt((s) => !s)}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
          >
            Prompt
          </button>
          {phase === "live" && (
            <>
              <button
                onClick={toggleMute}
                className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800"
              >
                {muted ? "Unmute" : "Mute"}
              </button>
              <button
                onClick={() => void endInterview("ended by candidate")}
                className="rounded bg-red-600 px-3 py-1 text-sm font-medium hover:bg-red-500"
              >
                End interview
              </button>
            </>
          )}
        </div>
      </header>

      {checkpointError && phase === "live" && (
        <p role="status" className="bg-amber-950 px-4 py-2 text-sm text-amber-200">{checkpointError}</p>
      )}
      {showPrompt && (
        <div className="border-b border-neutral-800 bg-neutral-900 px-4 py-2 text-sm text-neutral-300">
          {session.prompt.question}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="relative flex-1">
          <Whiteboard onApi={onBoardApi} onChange={onWhiteboardChange} />
          {phase === "lobby" || phase === "connecting" ? (
            <div className="absolute inset-0 z-[9999] grid place-items-center bg-neutral-950/90">
              <div className="max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-center">
                {session.status === "live" ? (
                  <>
                    <h2 className="mb-2 text-lg font-semibold">Connection interrupted</h2>
                    <p className="mb-4 text-sm text-neutral-400">
                      The last checkpoint was saved before this page reloaded. You can end the
                      interrupted interview and review what was captured.
                    </p>
                    <div className="flex justify-center gap-3">
                      <button
                        onClick={recoverSavedInterview}
                        className="rounded-lg bg-emerald-600 px-5 py-2 font-medium hover:bg-emerald-500"
                      >
                        Review saved progress
                      </button>
                      <Link
                        href="/"
                        className="rounded-lg border border-neutral-700 px-5 py-2 hover:bg-neutral-800"
                      >
                        New interview
                      </Link>
                    </div>
                  </>
                ) : (
                  <>
                    <h2 className="mb-2 text-lg font-semibold">Mock interview ready</h2>
                    <p className="mb-4 text-sm text-neutral-400">
                      {Math.round(session.durationSec / 60)} minutes · the interviewer will read the
                      prompt aloud once you join. Use speaker + mic like a real call.
                    </p>
                    <button
                      onClick={() => void start()}
                      disabled={phase === "connecting"}
                      className="rounded-lg bg-emerald-600 px-5 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {phase === "connecting" ? "Connecting…" : "Join interview"}
                    </button>
                    {phase === "connecting" && statusDetail && (
                      <p className="mt-3 text-xs text-neutral-400">{statusDetail}…</p>
                    )}
                    {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
                  </>
                )}
              </div>
            </div>
          ) : null}
          {phase === "ending" && (
            <div className="absolute inset-0 z-[9999] grid place-items-center bg-neutral-950/80">
              <div className="max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-center">
                {error ? (
                  <>
                    <p className="text-red-300">{error}</p>
                    <button
                      onClick={() => void saveAndFinish()}
                      className="mt-4 rounded-lg bg-emerald-600 px-5 py-2 font-medium hover:bg-emerald-500"
                    >
                      Retry save
                    </button>
                  </>
                ) : (
                  <p className="text-neutral-300">Wrapping up — saving the interview…</p>
                )}
              </div>
            </div>
          )}
        </main>
        <aside className="w-80 shrink-0 border-l border-neutral-800">
          <TranscriptPanel events={events} />
        </aside>
      </div>
    </div>
  );
}

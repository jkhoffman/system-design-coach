"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Whiteboard from "./Whiteboard";
import TranscriptPanel from "./TranscriptPanel";
import TimerChip from "./TimerChip";
import { GptLiveTransport, type LiveTransport } from "@/lib/liveSession";
import { Timeline } from "@/lib/timeline";
import { summarizeScene, type ExcalidrawElementLike } from "@/lib/summarizeScene";
import {
  interviewClockContext,
  interviewPacing,
  TIME_CONTEXT_INTERVAL_MS,
} from "@/lib/pacing";
import { useBoardSync } from "./useBoardSync";
import { useInterviewCheckpoint } from "./useInterviewCheckpoint";
import type { LiveTraceEvent } from "@/lib/liveTrace";
import type { ClientSession, TimelineEvent, TranscriptTurn } from "@/lib/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

type Phase = "lobby" | "connecting" | "live" | "ending" | "ended";

type FinalPayload = {
  kind: "finish";
  endedAt: number;
  transcript: TranscriptTurn[];
  timeline: TimelineEvent[];
  liveTrace?: LiveTraceEvent[];
  finalScene: readonly unknown[];
  finalImage: string | null;
};

export default function InterviewRoom({ session }: { session: ClientSession }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("lobby");
  const [statusDetail, setStatusDetail] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [muted, setMuted] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  const excalidrawApi = useRef<ExcalidrawImperativeAPI | null>(null);
  const transport = useRef<LiveTransport | null>(null);
  const connectAbort = useRef<AbortController | null>(null);
  const timeline = useRef(new Timeline());
  const t0 = useRef<number | null>(null);
  const warnedAt = useRef(new Set<number>());
  const nextTimeContextAt = useRef(TIME_CONTEXT_INTERVAL_MS);
  const endedRef = useRef(false);
  const unmountedRef = useRef(false);
  const imagePushEnabled = useRef(true);
  const finalPayload = useRef<FinalPayload | null>(null);

  const pacingWarnings = useMemo(
    () => interviewPacing(session.durationSec).warnings,
    [session.durationSec]
  );

  const sessionMs = useCallback((): number => {
    return t0.current == null ? 0 : performance.now() - t0.current;
  }, []);

  const currentElements = useCallback((): ExcalidrawElementLike[] => {
    return (excalidrawApi.current?.getSceneElements() ?? []) as unknown as ExcalidrawElementLike[];
  }, []);

  const exportBoardDataUrl = useCallback(
    async (opts: {
      mimeType: "image/png" | "image/jpeg";
      maxWidthOrHeight?: number;
      quality?: number;
    }): Promise<string | null> => {
      const api = excalidrawApi.current;
      if (!api) return null;
      const els = api.getSceneElements().filter((e) => !e.isDeleted);
      if (!els.length) return null;
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const blob = await exportToBlob({
        elements: els,
        appState: { exportWithDarkMode: true, exportBackground: true },
        files: api.getFiles(),
        mimeType: opts.mimeType,
        maxWidthOrHeight: opts.maxWidthOrHeight,
        quality: opts.quality,
      });
      return await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
    },
    []
  );

  const exportPngDataUrl = useCallback(
    () => exportBoardDataUrl({ mimeType: "image/png" }),
    [exportBoardDataUrl]
  );

  const exportLiveImageDataUrl = useCallback(
    () => exportBoardDataUrl({ mimeType: "image/jpeg", maxWidthOrHeight: 1600, quality: 0.85 }),
    [exportBoardDataUrl]
  );

  const { onWhiteboardChange, flushBoardUpdates } = useBoardSync({
    sessionId: session.id,
    transport,
    timeline,
    t0,
    sessionMs,
    currentElements,
    exportPngDataUrl,
  });

  const liveTraceSnapshot = useCallback(
    () => transport.current?.traceSnapshot() ?? [],
    []
  );

  useInterviewCheckpoint({
    sessionId: session.id,
    timeline,
    t0,
    ended: endedRef,
    liveTrace: liveTraceSnapshot,
    active: phase === "live",
  });

  const persistFinal = useCallback(
    async (payload: FinalPayload) => {
      let lastError = "failed to save interview";
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch(`/api/sessions/${session.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (res.ok) return;
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          lastError = data.error ?? `save failed with HTTP ${res.status}`;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
      }
      throw new Error(lastError);
    },
    [session.id]
  );

  const completeAfterSave = useCallback(async () => {
    // Recording download and grading are independent jobs owned by their routes/UI.
    void fetch(`/api/sessions/${session.id}/recording`, { method: "POST" }).catch(() => {});
    setPhase("ended");
    router.push(`/interview/${session.id}/review`);
  }, [router, session.id]);

  const saveAndFinish = useCallback(async () => {
    if (!finalPayload.current) {
      setError("No finalized interview data is available to save.");
      return;
    }
    try {
      setError(null);
      await persistFinal(finalPayload.current);
      await completeAfterSave();
    } catch (err) {
      setError(`Could not save the interview: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [persistFinal, completeAfterSave]);

  const endInterview = useCallback(
    async (reason: string) => {
      if (endedRef.current) return;
      endedRef.current = true;
      setPhase("ending");
      setError(null);
      timeline.current.addMarker(sessionMs(), `interview ended (${reason})`);

      await flushBoardUpdates();

      let finalImage: string | null = null;
      try {
        finalImage = await exportPngDataUrl();
      } catch {
        finalImage = null;
      }
      const finalScene = excalidrawApi.current?.getSceneElements() ?? [];

      try {
        await transport.current?.close();
      } catch {
        /* local teardown still proceeds */
      }

      finalPayload.current = {
        kind: "finish",
        endedAt: Date.now(),
        transcript: timeline.current.getTranscript(),
        timeline: timeline.current.getEvents(),
        liveTrace: transport.current?.traceSnapshot() ?? [],
        finalScene,
        finalImage,
      };
      await saveAndFinish();
    },
    [sessionMs, flushBoardUpdates, exportPngDataUrl, saveAndFinish]
  );

  const recoverSavedInterview = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    setPhase("ending");
    setError(null);
    finalPayload.current = {
      kind: "finish",
      endedAt: Date.now(),
      transcript: session.transcript,
      timeline: session.timeline,
      finalScene: [],
      finalImage: session.finalImage ?? null,
    };
    void saveAndFinish();
  }, [session.transcript, session.timeline, session.finalImage, saveAndFinish]);

  const start = useCallback(async () => {
    if (phase !== "lobby") return;
    setPhase("connecting");
    setError(null);
    setMuted(false);
    const tl = timeline.current;
    const controller = new AbortController();
    connectAbort.current?.abort();
    connectAbort.current = controller;
    nextTimeContextAt.current = TIME_CONTEXT_INTERVAL_MS;

    const t = new GptLiveTransport(session.id, {
      onStatus(status, detail) {
        if (unmountedRef.current) return;
        setStatusDetail(detail ?? status);
        if (status === "live") {
          setThinking(false);
          setPhase("live");
        } else if (status === "thinking") {
          setThinking(true);
        } else if (status === "error") {
          setError(detail ?? "session error");
        }
      },
      onStarted(liveSessionId) {
        t0.current = t.sessionT0() ?? performance.now();
        tl.addMarker(0, `interview started (live session ${liveSessionId || "?"})`);
        // Full-duplex models wait for the user to speak — kick the greeting.
        t.sendCommentary(
          "The candidate has just joined the call. Greet them briefly and deliver the interview question now."
        );
      },
      onTranscript(speaker, delta, startMs, endMs) {
        tl.addTranscriptFragment(speaker, delta, startMs, endMs);
      },
      onUsageSeconds() {
        /* informational; pacing uses session clock from t0 */
      },
      async onToolCall(name) {
        if (name === "view_whiteboard") {
          const summary = summarizeScene(currentElements());
          // Queue a fresh image so the NEXT delegation sees the actual board.
          transport.current?.markLocal("tool.view_whiteboard.export.start");
          const image = await exportLiveImageDataUrl().catch(() => null);
          transport.current?.markLocal("tool.view_whiteboard.export.end", image ? `${image.length} chars` : "failed");
          if (image && imagePushEnabled.current) {
            transport.current?.queueBoardImage(image, "requested via view_whiteboard");
          }
          return JSON.stringify({ whiteboard: summary });
        }
        return JSON.stringify({ error: `unknown tool ${name}` });
      },
      onEnded(reason) {
        void endInterview(reason);
      },
    });

    transport.current = t;
    try {
      await t.connect(controller.signal);
      if (controller.signal.aborted || unmountedRef.current) {
        await t.close(false);
        return;
      }
      imagePushEnabled.current = t.imagePushEnabled;
    } catch (err) {
      await t.close(false);
      if (transport.current === t) transport.current = null;
      if (controller.signal.aborted || unmountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("lobby");
    }
  }, [phase, session.id, currentElements, exportLiveImageDataUrl, endInterview]);

  useEffect(() => {
    unmountedRef.current = false;
    const unsubscribe = timeline.current.subscribe(() => setEvents([...timeline.current.getEvents()]));
    return () => {
      unmountedRef.current = true;
      unsubscribe();
      connectAbort.current?.abort();
      void transport.current?.close(false);
    };
  }, []);

  // Session-clock timer + pacing warnings
  useEffect(() => {
    if (phase !== "live") return;
    const iv = setInterval(() => {
      const ms = sessionMs();
      setElapsedSec(Math.floor(ms / 1000));
      const remain = session.durationSec - ms / 1000;
      if (ms >= nextTimeContextAt.current) {
        const context = interviewClockContext(session.durationSec, ms);
        if (context) transport.current?.sendThinking(context);
        nextTimeContextAt.current =
          (Math.floor(ms / TIME_CONTEXT_INTERVAL_MS) + 1) * TIME_CONTEXT_INTERVAL_MS;
      }
      for (const warning of pacingWarnings) {
        if (remain <= warning.remainingSec && !warnedAt.current.has(warning.remainingSec)) {
          warnedAt.current.add(warning.remainingSec);
          transport.current?.sendInstructions(warning.instruction);
          timeline.current.addMarker(ms, warning.label);
        }
      }
      if (remain <= 0) void endInterview("time expired");
    }, 500);
    return () => clearInterval(iv);
  }, [phase, session.durationSec, sessionMs, pacingWarnings, endInterview]);


  const toggleMute = () => {
    if (muted) transport.current?.unmute();
    else transport.current?.mute();
    setMuted(!muted);
  };

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

      {showPrompt && (
        <div className="border-b border-neutral-800 bg-neutral-900 px-4 py-2 text-sm text-neutral-300">
          {session.prompt.question}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="relative flex-1">
          <Whiteboard onApi={(api) => (excalidrawApi.current = api)} onChange={onWhiteboardChange} />
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

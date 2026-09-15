"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Whiteboard from "./Whiteboard";
import TranscriptPanel from "./TranscriptPanel";
import TimerChip from "./TimerChip";
import { GptLiveTransport, type LiveTransport } from "@/lib/liveSession";
import { Timeline } from "@/lib/timeline";
import { elementsVersionKey, summarizeScene, type ExcalidrawElementLike } from "@/lib/summarizeScene";
import { fmtMs } from "@/lib/rubric";
import type { SessionRow, TimelineEvent } from "@/lib/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const DRAWING_PAUSE_MS = 4000;
const SNAPSHOT_MIN_GAP_MS = 45_000;
const MAX_SNAPSHOTS = 12;

type Phase = "lobby" | "connecting" | "live" | "ending" | "ended";

export default function InterviewRoom({ session }: { session: SessionRow }) {
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
  const timeline = useRef(new Timeline());
  const t0 = useRef<number | null>(null);
  const lastVersionKey = useRef("");
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boardDirty = useRef(false);
  const lastSnapshotMs = useRef(-SNAPSHOT_MIN_GAP_MS);
  const snapshotCount = useRef(0);
  const warnedAt = useRef(new Set<number>());
  const endedRef = useRef(false);
  const imagePushMode = useRef<string>("queue-only");

  const sessionMs = useCallback((): number => {
    return t0.current == null ? 0 : performance.now() - t0.current;
  }, []);

  const currentElements = useCallback((): ExcalidrawElementLike[] => {
    return (excalidrawApi.current?.getSceneElements() ?? []) as unknown as ExcalidrawElementLike[];
  }, []);

  const exportPngDataUrl = useCallback(async (): Promise<string | null> => {
    const api = excalidrawApi.current;
    if (!api) return null;
    const els = api.getSceneElements().filter((e) => !e.isDeleted);
    if (!els.length) return null;
    const { exportToBlob } = await import("@excalidraw/excalidraw");
    const blob = await exportToBlob({
      elements: els,
      appState: { exportWithDarkMode: true, exportBackground: true },
      files: api.getFiles(),
      mimeType: "image/png",
    });
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }, []);

  const pushBoardUpdate = useCallback(async () => {
    if (!boardDirty.current || !transport.current || t0.current == null) return;
    boardDirty.current = false;
    const t = sessionMs();
    const summary = summarizeScene(currentElements());
    transport.current.sendThinking(`[whiteboard state at ${fmtMs(t)}]\n${summary}`);
    timeline.current.addBoardSummary(t, summary);

    const png = await exportPngDataUrl();
    if (png && imagePushMode.current !== "off") {
      transport.current.queueBoardImage(png, `t=${fmtMs(t)}`);
      if (imagePushMode.current === "queue-and-run") transport.current.runBackendNow();
    }
    if (
      png &&
      snapshotCount.current < MAX_SNAPSHOTS &&
      t - lastSnapshotMs.current >= SNAPSHOT_MIN_GAP_MS
    ) {
      lastSnapshotMs.current = t;
      snapshotCount.current++;
      void fetch(`/api/sessions/${session.id}/snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startMs: t, label: "milestone", png }),
      })
        .then((r) => r.json())
        .then((d: { file?: string }) => {
          if (d.file) timeline.current.addSnapshot(t, "milestone", d.file);
        })
        .catch(() => {});
    }
  }, [session.id, sessionMs, currentElements, exportPngDataUrl]);

  const onWhiteboardChange = useCallback(
    (elements: readonly { id: string; version?: number; isDeleted?: boolean }[]) => {
      const key = elementsVersionKey(elements as readonly ExcalidrawElementLike[]);
      if (key === lastVersionKey.current) return; // selection/scroll only
      lastVersionKey.current = key;
      boardDirty.current = true;
      if (pauseTimer.current) clearTimeout(pauseTimer.current);
      pauseTimer.current = setTimeout(() => void pushBoardUpdate(), DRAWING_PAUSE_MS);
    },
    [pushBoardUpdate]
  );

  const endInterview = useCallback(
    async (reason: string) => {
      if (endedRef.current) return;
      endedRef.current = true;
      setPhase("ending");
      timeline.current.addMarker(sessionMs(), `interview ended (${reason})`);

      let finalImage: string | null = null;
      try {
        finalImage = await exportPngDataUrl();
      } catch {
        finalImage = null;
      }
      const finalScene = excalidrawApi.current?.getSceneElements() ?? [];

      await transport.current?.close();

      await fetch(`/api/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "ended",
          endedAt: Date.now(),
          transcript: timeline.current.getTranscript(),
          timeline: timeline.current.getEvents(),
          finalScene,
          finalImage,
        }),
      }).catch(() => {});

      // Fetch recording + grade in the background; review page waits on grade.
      // Re-read the row: live/session may have cleared recordingPath when the
      // project disallows session storage.
      const fresh = await fetch(`/api/sessions/${session.id}`)
        .then((r) => r.json())
        .catch(() => null);
      if (fresh?.session?.recordingPath !== "") {
        void fetch(`/api/sessions/${session.id}/recording`, { method: "POST" }).catch(() => {});
      }
      void fetch(`/api/sessions/${session.id}/grade`, { method: "POST" }).catch(() => {});
      setPhase("ended");
      router.push(`/interview/${session.id}/review`);
    },
    [router, session.id, sessionMs, exportPngDataUrl]
  );

  const start = useCallback(async () => {
    setPhase("connecting");
    setError(null);
    const tl = timeline.current;

    const t = new GptLiveTransport(session.id, {
      onStatus(status, detail) {
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
        t0.current = performance.now();
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
          const png = await exportPngDataUrl().catch(() => null);
          if (png && imagePushMode.current !== "off") {
            transport.current?.queueBoardImage(png, "requested via view_whiteboard");
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
    tl.subscribe(() => setEvents([...tl.getEvents()]));

    try {
      await t.connect();
      imagePushMode.current = t.imagePushMode;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("lobby");
    }
  }, [session.id, currentElements, exportPngDataUrl, endInterview]);

  // Session-clock timer + pacing warnings
  useEffect(() => {
    if (phase !== "live") return;
    const iv = setInterval(() => {
      const ms = sessionMs();
      setElapsedSec(Math.floor(ms / 1000));
      const remain = session.durationSec - ms / 1000;
      for (const w of [600, 300]) {
        if (remain <= w && !warnedAt.current.has(w)) {
          warnedAt.current.add(w);
          transport.current?.sendInstructions(
            `There are ${w / 60} minutes left in the interview. ${w === 300 ? "Start wrapping up — ask the candidate for a closing summary." : "Begin steering toward wrap-up."}`
          );
          timeline.current.addMarker(ms, `${w / 60} minutes remaining`);
        }
      }
      if (remain <= 0) void endInterview("time expired");
    }, 500);
    return () => clearInterval(iv);
  }, [phase, session.durationSec, sessionMs, endInterview]);

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
            <div className="absolute inset-0 grid place-items-center bg-neutral-950/90">
              <div className="max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-center">
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
              </div>
            </div>
          ) : null}
          {phase === "ending" && (
            <div className="absolute inset-0 grid place-items-center bg-neutral-950/80">
              <p className="text-neutral-300">Wrapping up — generating feedback…</p>
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

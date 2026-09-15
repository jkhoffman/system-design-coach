/**
 * LiveTransport abstracts the voice-interview session so a different backend
 * (e.g. gpt-realtime-2.1, whose event vocabulary and tool loop differ) can be
 * swapped in as an adapter without touching the interview room.
 */

export type Speaker = "candidate" | "interviewer";

export interface LiveEvents {
  onStatus(status: "connecting" | "live" | "thinking" | "ended" | "error", detail?: string): void;
  /** Transcript fragment; times are session-timeline ms. */
  onTranscript(speaker: Speaker, delta: string, startMs: number, endMs: number): void;
  /** Session-timeline ms of the anchor (session.started received). */
  onStarted(sessionId: string): void;
  /** Cumulative voice-usage seconds reported by the session. */
  onUsageSeconds(sec: number): void;
  /** A delegation backend function call. Return the string result to send back. */
  onToolCall(name: string, args: Record<string, unknown>): Promise<string>;
  onEnded(reason: string): void;
}

export interface LiveTransport {
  /** ms timestamp of session start on the session timeline (0) mapped to perf clock. */
  sessionT0(): number | null;
  /** Server-selected image push strategy. */
  imagePushMode: string;
  connect(): Promise<void>;
  sendThinking(content: string): void;
  sendInstructions(content: string): void;
  sendCommentary(content: string): void;
  /** Queue a whiteboard PNG into the delegation context (data URL). */
  queueBoardImage(dataUrl: string, note: string): void;
  /** Fire response.create so queued items are consumed now. */
  runBackendNow(): void;
  mute(): void;
  unmute(): void;
  close(): Promise<void>;
}

type LiveEvent = {
  type: string;
  event_id?: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  delegation_id?: string | null;
  session?: { id?: string };
  usage?: Record<string, unknown>;
  reason?: string;
  event?: {
    type: string;
    item?: {
      type?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    };
  };
  error?: { message?: string };
  message?: string;
};

let counter = 0;
const eid = (p: string) => `${p}_${Date.now().toString(36)}_${counter++}`;

export class GptLiveTransport implements LiveTransport {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private t0: number | null = null;
  private pendingCalls = 0;
  imagePushMode = "queue-only";

  constructor(
    private sessionDbId: string,
    private ev: LiveEvents
  ) {}

  sessionT0(): number | null {
    return this.t0;
  }

  async connect(): Promise<void> {
    this.ev.onStatus("connecting");
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: true });

    const pc = new RTCPeerConnection();
    this.pc = pc;

    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0];
    };

    pc.addTrack(this.mic.getTracks()[0]);

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onmessage = (m) => this.handleMessage(m.data);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const check = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", check);
      setTimeout(resolve, 3000); // don't hang on ICE trickle
    });

    const res = await fetch("/api/live/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionDbId, sdp: pc.localDescription?.sdp }),
    });
    if (!res.ok) throw new Error(`live session create failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      sdp: string;
      liveSessionId?: string;
      imagePushMode?: string;
    };
    if (data.imagePushMode) this.imagePushMode = data.imagePushMode;
    if (!data.sdp) throw new Error("no SDP answer from server");
    await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
  }

  private send(obj: Record<string, unknown>): void {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(obj));
  }

  private handleMessage(raw: string): void {
    let ev: LiveEvent;
    try {
      ev = JSON.parse(raw) as LiveEvent;
    } catch {
      return;
    }

    switch (ev.type) {
      case "session.started":
        this.t0 = performance.now();
        this.ev.onStarted(ev.session?.id ?? "");
        this.ev.onStatus("live");
        return;
      case "session.input_transcript.delta":
        this.ev.onTranscript("candidate", ev.delta ?? "", ev.start_ms ?? 0, ev.end_ms ?? 0);
        return;
      case "session.output_transcript.delta":
        this.ev.onTranscript("interviewer", ev.delta ?? "", ev.start_ms ?? 0, ev.end_ms ?? 0);
        return;
      case "session.usage.updated": {
        const u = ev.usage ?? {};
        const sec =
          (u["voice_seconds"] as number) ??
          (u["seconds"] as number) ??
          (u["duration_seconds"] as number);
        if (typeof sec === "number") this.ev.onUsageSeconds(sec);
        return;
      }
      case "session.delegation.created":
        this.pendingCalls++;
        this.ev.onStatus("thinking");
        return;
      case "session.delegation.completed":
        this.pendingCalls = Math.max(0, this.pendingCalls - 1);
        if (this.pendingCalls === 0) this.ev.onStatus("live");
        return;
      case "response.event":
        this.handleResponseEvent(ev);
        return;
      case "session.closed":
        this.ev.onEnded(ev.reason ?? "closed");
        return;
      case "error":
        this.ev.onStatus("error", ev.error?.message ?? ev.message ?? "unknown error");
        return;
      default:
        return;
    }
  }

  private handleResponseEvent(ev: LiveEvent): void {
    const inner = ev.event;
    if (inner?.type !== "response.output_item.done") return;
    const item = inner.item;
    if (item?.type !== "function_call" || !item.call_id || !item.name) return;

    const callId = item.call_id;
    let args: Record<string, unknown> = {};
    try {
      args = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }

    void (async () => {
      try {
        const output = await this.ev.onToolCall(item.name!, args);
        this.send({
          type: "response.item.create",
          event_id: eid("tool_result"),
          item: { type: "function_call_output", call_id: callId, output },
        });
      } catch (err) {
        this.send({
          type: "response.item.create",
          event_id: eid("tool_result"),
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({ error: String(err) }),
          },
        });
      } finally {
        // Appending a function result does not auto-continue; must create.
        this.send({ type: "response.create", event_id: eid("continue") });
      }
    })();
  }

  sendThinking(content: string): void {
    this.send({
      type: "session.thinking.append",
      event_id: eid("thinking"),
      delegation_id: null,
      content,
    });
  }

  sendInstructions(content: string): void {
    this.send({
      type: "session.instructions.append",
      event_id: eid("instr"),
      delegation_id: null,
      content,
    });
  }

  sendCommentary(content: string): void {
    this.send({
      type: "session.commentary.append",
      event_id: eid("commentary"),
      delegation_id: null,
      content,
    });
  }

  queueBoardImage(dataUrl: string, note: string): void {
    this.send({
      type: "response.item.create",
      event_id: eid("img"),
      item: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: `[whiteboard snapshot — ${note}]` },
          { type: "input_image", image_url: dataUrl, detail: "high" },
        ],
      },
    });
  }

  runBackendNow(): void {
    this.send({ type: "response.create", event_id: eid("run") });
  }

  mute(): void {
    this.send({ type: "session.input_audio.mute", event_id: eid("mute") });
  }

  unmute(): void {
    this.send({ type: "session.input_audio.unmute", event_id: eid("unmute") });
  }

  async close(): Promise<void> {
    try {
      this.send({ type: "session.close", event_id: eid("close") });
    } catch {
      /* channel may already be down */
    }
    // Give the close a moment to finalize server-side, then tear down locally.
    await new Promise((r) => setTimeout(r, 1500));
    this.dc?.close();
    this.pc?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.dc = null;
    this.pc = null;
    this.mic = null;
  }
}

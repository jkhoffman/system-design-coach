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
  /** Whether the server allows live board images to be queued. */
  imagePushEnabled: boolean;
  connect(signal?: AbortSignal): Promise<void>;
  sendThinking(content: string): void;
  sendInstructions(content: string): void;
  sendCommentary(content: string): void;
  /** Queue a compact whiteboard image into the delegation context (data URL). */
  queueBoardImage(dataUrl: string, note: string): void;
  mute(): void;
  unmute(): void;
  close(graceful?: boolean): Promise<void>;
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
  private audioEl: HTMLAudioElement | null = null;
  private t0: number | null = null;
  private pendingCalls = 0;
  private toolCallDepth = 0;
  private queuedBoardImages: { dataUrl: string; note: string }[] = [];
  private closing = false;
  private sessionStarted = false;
  private sessionClosed = false;
  private endedNotified = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closeWaiter: (() => void) | null = null;
  imagePushEnabled = true;

  constructor(
    private sessionDbId: string,
    private ev: LiveEvents
  ) {}

  sessionT0(): number | null {
    return this.t0;
  }

  private abortError(): DOMException {
    return new DOMException("connection aborted", "AbortError");
  }

  private assertActive(signal?: AbortSignal): void {
    if (this.closing || signal?.aborted) throw this.abortError();
  }

  async connect(signal?: AbortSignal): Promise<void> {
    try {
      this.assertActive(signal);
      this.ev.onStatus("connecting", "requesting microphone access");
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      this.assertActive(signal);

      this.ev.onStatus("connecting", "creating WebRTC offer");
      const pc = new RTCPeerConnection();
      this.pc = pc;

      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      this.audioEl = audioEl;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };
      pc.onconnectionstatechange = () => {
        if (this.closing || !this.sessionStarted) return;
        if (pc.connectionState === "disconnected") {
          this.disconnectTimer ??= setTimeout(() => {
            this.disconnectTimer = null;
            if (!this.closing && pc.connectionState === "disconnected") {
              this.notifyEnded("connection disconnected");
            }
          }, 12_000);
          return;
        }
        this.clearDisconnectTimer();
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          this.resolveCloseWaiter();
          this.notifyEnded(`connection ${pc.connectionState}`);
        }
      };

      pc.addTrack(this.mic.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (m) => this.handleMessage(m.data);
      dc.onclose = () => {
        if (this.closing) {
          this.resolveCloseWaiter();
        } else if (this.sessionStarted) {
          this.notifyEnded("connection lost");
        }
      };

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
      this.assertActive(signal);

      this.ev.onStatus("connecting", "contacting interviewer");
      const res = await fetch("/api/live/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: this.sessionDbId, sdp: pc.localDescription?.sdp }),
        signal,
      });
      if (!res.ok) throw new Error(`live session create failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as {
        sdp: string;
        liveSessionId?: string;
        imagePushEnabled?: boolean;
      };
      if (typeof data.imagePushEnabled === "boolean") {
        this.imagePushEnabled = data.imagePushEnabled;
      }
      if (!data.sdp) throw new Error("no SDP answer from server");
      this.assertActive(signal);
      await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      this.assertActive(signal);
    } catch (err) {
      await this.close(false);
      throw err;
    }
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  private resolveCloseWaiter(): void {
    const resolve = this.closeWaiter;
    this.closeWaiter = null;
    resolve?.();
  }

  private send(obj: Record<string, unknown>): boolean {
    const dc = this.dc;
    if (dc?.readyState !== "open") {
      console.warn(`[live] dropped ${String(obj.type)}; data channel is ${dc?.readyState ?? "missing"}`);
      return false;
    }
    const raw = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(raw).length;
    const negotiatedMax = this.pc?.sctp?.maxMessageSize;
    const maxMessageSize = negotiatedMax && negotiatedMax > 0 ? negotiatedMax : 64 * 1024;
    if (bytes > maxMessageSize) {
      console.warn(
        `[live] dropped oversized ${String(obj.type)} message (${bytes} bytes > ${maxMessageSize} bytes)`
      );
      return false;
    }
    try {
      dc.send(raw);
      return true;
    } catch (err) {
      console.warn(`[live] failed to send ${String(obj.type)}`, err);
      return false;
    }
  }

  private notifyEnded(reason: string): void {
    if (this.endedNotified) return;
    this.clearDisconnectTimer();
    this.endedNotified = true;
    this.ev.onEnded(reason);
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
        this.sessionStarted = true;
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
      case "response.completed":
        this.delegationCompleted();
        return;
      case "response.event":
        this.handleResponseEvent(ev);
        return;
      case "session.closed":
        this.sessionClosed = true;
        this.resolveCloseWaiter();
        this.notifyEnded(ev.reason ?? "closed");
        return;
      case "error":
        this.ev.onStatus("error", ev.error?.message ?? ev.message ?? "unknown error");
        return;
      default:
        return;
    }
  }

  private delegationCompleted(): void {
    this.pendingCalls = Math.max(0, this.pendingCalls - 1);
    if (this.pendingCalls === 0) this.ev.onStatus("live");
  }

  private handleResponseEvent(ev: LiveEvent): void {
    const inner = ev.event;
    if (inner?.type === "response.completed") {
      this.delegationCompleted();
      return;
    }
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
      this.toolCallDepth++;
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
        this.toolCallDepth--;
        this.flushQueuedBoardImages();
        // Appending function results/images does not auto-continue; must create.
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
    if (this.toolCallDepth > 0) {
      this.queuedBoardImages.push({ dataUrl, note });
      return;
    }
    this.sendBoardImage(dataUrl, note);
  }

  private flushQueuedBoardImages(): void {
    const pending = this.queuedBoardImages.splice(0);
    for (const image of pending) this.sendBoardImage(image.dataUrl, image.note);
  }

  private sendBoardImage(dataUrl: string, note: string): void {
    const sent = this.send({
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
    if (!sent) {
      this.sendThinking(`[whiteboard image unavailable — ${note}; use the latest structural summary]`);
    }
  }

  mute(): void {
    this.send({ type: "session.input_audio.mute", event_id: eid("mute") });
  }

  unmute(): void {
    this.send({ type: "session.input_audio.unmute", event_id: eid("unmute") });
  }

  async close(graceful = true): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.clearDisconnectTimer();
    const closeSent = !this.sessionClosed && this.send({ type: "session.close", event_id: eid("close") });
    if (graceful && closeSent && this.sessionStarted && !this.sessionClosed) {
      const acknowledged = new Promise<void>((resolve) => {
        this.closeWaiter = resolve;
      });
      const timedOut = await Promise.race([
        acknowledged.then(() => false),
        new Promise<true>((resolve) => setTimeout(() => resolve(true), 10_000)),
      ]);
      this.closeWaiter = null;
      if (timedOut) console.warn("[live] timed out waiting for session.closed");
    }
    const dc = this.dc;
    const pc = this.pc;
    const mic = this.mic;
    const audioEl = this.audioEl;
    this.dc = null;
    this.pc = null;
    this.mic = null;
    this.audioEl = null;
    if (dc) {
      dc.onmessage = null;
      dc.onclose = null;
      dc.close();
    }
    if (pc) {
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    mic?.getTracks().forEach((t) => t.stop());
    if (audioEl) audioEl.srcObject = null;
  }
}

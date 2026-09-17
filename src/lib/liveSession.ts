import { LiveTrace, type LiveTraceEvent } from "./liveTrace";
import { bounded } from "./async";
import { LiveActivity, parseLiveEvent, type LiveEvent } from "./liveProtocol";

/**
 * LiveTransport abstracts the voice-interview session so a different backend
 * (e.g. gpt-realtime-2.1, whose event vocabulary and tool loop differ) can be
 * swapped in as an adapter without touching the interview room.
 */

export type Speaker = "candidate" | "interviewer";

export interface ToolResult { output: string; image?: { dataUrl: string; note: string } }

export interface LiveEvents {
  onStatus(status: "connecting" | "live" | "thinking" | "ended" | "error", detail?: string): void;
  /** Transcript fragment; times are session-timeline ms. */
  onTranscript(speaker: Speaker, delta: string, startMs: number, endMs: number): void;
  /** Session-timeline ms of the anchor (session.started received). */
  onStarted(sessionId: string): void;
  /** Cumulative voice-usage seconds reported by the session. */
  onUsageSeconds(sec: number): void;
  /** A delegation backend function call. Return the string result to send back. */
  onToolCall(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult | string>;
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
  mute(): void;
  unmute(): void;
  close(graceful?: boolean): Promise<void>;
  traceSnapshot(): LiveTraceEvent[];
  markLocal(type: string, detail?: string): void;
}

let counter = 0;
const eid = (p: string) => `${p}_${Date.now().toString(36)}_${counter++}`;

export class GptLiveTransport implements LiveTransport {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private t0: number | null = null;
  private activity = new LiveActivity();
  private activeTools = new Set<string>();
  private seenTools = new Set<string>();
  private toolResults: { callId: string; result: ToolResult }[] = [];
  private lifetime = new AbortController();
  private closePromise: Promise<void> | null = null;
  private startWaiter: (() => void) | null = null;
  private cleanups = new Set<() => void>();
  private closing = false;
  private forceClose = false;
  private sessionStarted = false;
  private sessionClosed = false;
  private endedNotified = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closeWaiter: (() => void) | null = null;
  private trace = new LiveTrace();
  imagePushEnabled = true;

  constructor(
    private sessionDbId: string,
    private ev: LiveEvents,
    private timing = { startupMs: 60_000, closeMs: 10_000, toolMs: 10_000 }
  ) {}

  sessionT0(): number | null {
    return this.t0;
  }

  traceSnapshot(): LiveTraceEvent[] {
    return this.trace.snapshot();
  }

  markLocal(type: string, detail?: string): void {
    this.trace.mark(type, detail);
  }

  private abortError(): DOMException {
    return new DOMException("connection aborted", "AbortError");
  }

  private assertActive(signal?: AbortSignal): void {
    if (this.closing || signal?.aborted) throw this.abortError();
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const startup = new AbortController();
    const timeout = setTimeout(() => startup.abort(new Error("Interviewer connection timed out")), this.timing.startupMs);
    const activeSignal = AbortSignal.any([this.lifetime.signal, startup.signal, ...(signal ? [signal] : [])]);
    const onAbort = () => { void this.close(false); };
    activeSignal.addEventListener("abort", onAbort, { once: true });
    try {
      this.assertActive(activeSignal);
      this.ev.onStatus("connecting", "requesting microphone access");
      this.trace.mark("mic.request");
      const microphone = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      }).then((stream) => {
        if (this.closing || activeSignal.aborted) {
          stream.getTracks().forEach((track) => track.stop());
          throw activeSignal.reason ?? this.abortError();
        }
        this.mic = stream;
        return stream;
      });
      const mic = await bounded(microphone, this.timing.startupMs, activeSignal);
      this.trace.mark("mic.acquired");
      this.assertActive(activeSignal);

      this.ev.onStatus("connecting", "creating WebRTC offer");
      const pc = new RTCPeerConnection();
      this.pc = pc;
      this.trace.mark("peer.created");

      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      this.audioEl = audioEl;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };
      pc.onconnectionstatechange = () => {
        this.trace.mark("peer.connectionstate", pc.connectionState);
        if (this.closing) return;
        if (!this.sessionStarted) {
          if (pc.connectionState === "failed" || pc.connectionState === "closed") startup.abort(new Error("Connection failed before the interview started"));
          return;
        }
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

      pc.addTrack(mic.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      this.trace.mark("dc.created", dc.label);
      dc.onopen = () => this.trace.mark("dc.open");
      dc.onmessage = (m) => this.handleMessage(m.data);
      dc.onclose = () => {
        this.trace.mark("dc.close", this.sessionStarted ? "after session start" : "before session start");
        if (this.closing) {
          this.resolveCloseWaiter();
        } else if (this.sessionStarted) {
          this.notifyEnded("connection lost");
        } else startup.abort(new Error("Connection closed before the interview started"));
      };

      const offer = await bounded(pc.createOffer(), this.timing.startupMs, activeSignal);
      this.trace.mark("sdp.offer.created");
      this.assertActive(activeSignal);
      await bounded(pc.setLocalDescription(offer), this.timing.startupMs, activeSignal);
      this.trace.mark("sdp.local_description_set");
      await bounded(new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const finish = () => {
          clearTimeout(timer);
          pc.removeEventListener("icegatheringstatechange", check);
          this.cleanups.delete(finish);
          resolve();
        };
        const check = () => { if (pc.iceGatheringState === "complete") finish(); };
        const timer = setTimeout(finish, 3000);
        this.cleanups.add(finish);
        pc.addEventListener("icegatheringstatechange", check);
      }), 4000, activeSignal);
      this.trace.mark("ice.gathering_finished", pc.iceGatheringState);
      this.assertActive(activeSignal);

      this.ev.onStatus("connecting", "contacting interviewer");
      this.trace.mark("live_api.request");
      const res = await fetch("/api/live/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: this.sessionDbId, sdp: pc.localDescription?.sdp }),
        signal: activeSignal,
      });
      this.trace.mark("live_api.response", String(res.status));
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
      this.trace.mark("live_api.answer", data.liveSessionId);
      this.assertActive(activeSignal);
      await bounded(pc.setRemoteDescription({ type: "answer", sdp: data.sdp }), this.timing.startupMs, activeSignal);
      this.trace.mark("sdp.remote_description_set");
      this.assertActive(activeSignal);
      if (!this.sessionStarted) await bounded(new Promise<void>((resolve) => { this.startWaiter = resolve; }), this.timing.startupMs, activeSignal);
      this.assertActive(activeSignal);
    } catch (err) {
      this.trace.mark("connect.error", err instanceof Error ? err.message : String(err));
      await this.close(false);
      throw err;
    } finally {
      clearTimeout(timeout);
      activeSignal.removeEventListener("abort", onAbort);
      this.startWaiter = null;
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
    if (this.closing && obj.type !== "session.close") return false;
    const raw = JSON.stringify(obj);
    const dc = this.dc;
    if (dc?.readyState !== "open") {
      this.trace.outgoing(obj, raw, false, `data channel is ${dc?.readyState ?? "missing"}`);
      console.warn(`[live] dropped ${String(obj.type)}; data channel is ${dc?.readyState ?? "missing"}`);
      return false;
    }
    const bytes = new TextEncoder().encode(raw).length;
    const negotiatedMax = this.pc?.sctp?.maxMessageSize;
    const maxMessageSize = negotiatedMax && negotiatedMax > 0 ? negotiatedMax : 64 * 1024;
    if (bytes > maxMessageSize) {
      this.trace.outgoing(obj, raw, false, `oversized message (${bytes} > ${maxMessageSize})`);
      console.warn(
        `[live] dropped oversized ${String(obj.type)} message (${bytes} bytes > ${maxMessageSize} bytes)`
      );
      return false;
    }
    try {
      dc.send(raw);
      this.trace.outgoing(obj, raw, true);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.trace.outgoing(obj, raw, false, message);
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
    this.trace.incoming(raw);
    const ev = parseLiveEvent(raw);
    if (!ev) return;
    this.activity.observe(ev);

    switch (ev.type) {
      case "session.started":
        if (this.closing || this.sessionStarted) return;
        this.startWaiter?.();
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
        this.reportActivity();
        return;
      case "session.delegation.completed":
      case "response.completed":
        this.reportActivity();
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

  private reportActivity(): void {
    if (!this.closing) this.ev.onStatus(this.activity.pending || this.activeTools.size > 0 ? "thinking" : "live");
  }

  private handleResponseEvent(ev: LiveEvent): void {
    const inner = ev.event;
    this.reportActivity();
    if (this.closing || inner?.type !== "response.output_item.done") return;
    const item = inner.item;
    if (item?.type !== "function_call" || !item.call_id || !item.name || this.seenTools.has(item.call_id)) return;
    const callId = item.call_id;
    const name = item.name;
    this.seenTools.add(callId);
    this.activeTools.add(callId);
    this.reportActivity();
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(item.arguments ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
    } catch { /* invalid arguments are an empty object */ }
    void (async () => {
      const startedAt = performance.now();
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
      this.trace.mark("tool.handler.start", `${name}:${callId}`, { callId, toolName: name });
      let result: ToolResult;
      try {
        const value = await bounded(this.ev.onToolCall(name, args, signal), this.timing.toolMs, signal);
        result = typeof value === "string" ? { output: value } : value;
        this.trace.mark("tool.handler.end", `${Math.round(performance.now() - startedAt)}ms`, { callId, toolName: name });
      } catch (error) {
        controller.abort();
        this.trace.mark("tool.handler.error", String(error), { callId, toolName: name });
        result = { output: JSON.stringify({ error: String(error) }) };
      }
      this.activeTools.delete(callId);
      if (this.closing) return;
      this.toolResults.push({ callId, result });
      if (this.activeTools.size === 0) {
        for (const completed of this.toolResults.splice(0)) {
          this.send({ type: "response.item.create", event_id: eid("tool_result"),
            item: { type: "function_call_output", call_id: completed.callId, output: completed.result.output } });
          if (completed.result.image && this.imagePushEnabled) {
            this.sendBoardImage(completed.result.image.dataUrl, completed.result.image.note);
          }
        }
        this.activity.expectResponse();
        this.send({ type: "response.create", event_id: eid("continue") });
      }
      this.reportActivity();
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

  close(graceful = true): Promise<void> {
    if (!graceful) this.forceClose = true;
    if (this.closePromise) {
      if (!graceful) this.resolveCloseWaiter();
      return this.closePromise;
    }
    this.closing = true;
    this.closePromise = Promise.resolve().then(() => this.shutdown(graceful));
    return this.closePromise;
  }

  private async shutdown(graceful: boolean): Promise<void> {
    this.trace.mark("close.requested", graceful ? "graceful" : "immediate");
    this.lifetime.abort();
    this.clearDisconnectTimer();
    this.cleanups.forEach((cleanup) => cleanup());
    this.mic?.getTracks().forEach((track) => track.stop());
    this.mic = null;
    // Install the waiter before sending; adapters can acknowledge synchronously.
    const acknowledged = new Promise<void>((resolve) => { this.closeWaiter = resolve; });
    const closeSent = !this.sessionClosed && this.dc?.readyState === "open" && this.send({ type: "session.close", event_id: eid("close") });
    if (graceful && !this.forceClose && closeSent && this.sessionStarted && !this.sessionClosed) {
      try {
        await bounded(acknowledged, this.timing.closeMs);
        this.trace.mark("close.acknowledged");
      } catch { this.trace.mark("close.ack_timeout"); }
    }
    this.closeWaiter = null;
    const dc = this.dc;
    const pc = this.pc;
    const audioEl = this.audioEl;
    this.dc = null;
    this.pc = null;
    this.mic = null;
    this.audioEl = null;
    if (dc) {
      dc.onopen = null;
      dc.onmessage = null;
      dc.onclose = null;
      dc.close();
    }
    if (pc) {
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    if (audioEl) audioEl.srcObject = null;
    this.toolResults = [];
    this.trace.mark("teardown.complete");
  }
}

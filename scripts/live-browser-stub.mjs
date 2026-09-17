export function installLiveBrowserStub(options = {}) {
  const state = {
    getUserMediaCalls: 0,
    tracksAdded: 0,
    micTracksStopped: 0,
    dataChannelsCreated: 0,
    sends: 0,
    sentTypes: [],
    boardSummaries: 0,
    boardImages: 0,
    toolCalls: 0,
    toolResults: 0,
    backendRuns: 0,
    instructions: 0,
    closeRequests: 0,
    peerConnectionsClosed: 0,
    peerClosedAt: 0,
    remoteDescriptions: [],
    sent: [],
    received: [],
  };
  Object.defineProperty(window, "__liveStub", { value: state, configurable: true });

  class FakeTrack extends EventTarget {
    constructor() {
      super();
      this.kind = "audio";
      this.enabled = true;
      this.readyState = "live";
    }
    stop() {
      if (this.readyState === "ended") return;
      this.readyState = "ended";
      state.micTracksStopped++;
    }
  }

  class FakeMediaStream extends EventTarget {
    constructor() {
      super();
      this.id = "mock-mic-stream";
      this.active = true;
      this.tracks = [new FakeTrack()];
    }
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks;
    }
  }

  const mediaDevices = navigator.mediaDevices ?? {};
  mediaDevices.getUserMedia = async () => {
    state.getUserMediaCalls++;
    if (options.microphoneDelayMs) await new Promise((resolve) => setTimeout(resolve, options.microphoneDelayMs));
    return new FakeMediaStream();
  };
  try {
    Object.defineProperty(navigator, "mediaDevices", { value: mediaDevices, configurable: true });
  } catch {
    navigator.mediaDevices = mediaDevices;
  }

  class FakeDataChannel extends EventTarget {
    constructor(peerConnection, label) {
      super();
      this.peerConnection = peerConnection;
      this.label = label;
      this.readyState = "open";
      this.onmessage = null;
      this.onclose = null;
      this.onopen = null;
      state.dataChannelsCreated++;
    }

    emit(event) {
      queueMicrotask(() => {
        state.received.push({
          type: event.type,
          innerType: event.event?.type,
          at: performance.now(),
        });
        if (this.onmessage) this.onmessage({ data: JSON.stringify(event) });
      });
    }

    emitTranscript(speaker, delta, startMs, endMs) {
      this.emit({
        type:
          speaker === "candidate"
            ? "session.input_transcript.delta"
            : "session.output_transcript.delta",
        delta,
        start_ms: startMs,
        end_ms: endMs,
      });
    }

    send(raw) {
      if (this.readyState === "closed") return;
      state.sends++;
      const message = JSON.parse(raw);
      const content = message.item?.content;
      state.sentTypes.push(message.type);
      state.sent.push({
        type: message.type,
        itemType: message.item?.type,
        hasImage:
          Array.isArray(content) && content.some((part) => part?.type === "input_image"),
        bytes: new TextEncoder().encode(raw).length,
        at: performance.now(),
      });

      const appendAck = {
        "session.commentary.append": "session.commentary.appended",
        "session.thinking.append": "session.thinking.appended",
        "session.instructions.append": "session.instructions.appended",
      }[message.type];
      if (appendAck) {
        this.emit({ type: appendAck, event_id: message.event_id });
      }

      if (message.type === "session.commentary.append") {
        this.emitTranscript(
          "interviewer",
          "Design a URL shortener that can support a large consumer product. ",
          200,
          1300
        );
        this.emitTranscript(
          "interviewer",
          "Start with the requirements you care about.",
          1300,
          2100
        );
        setTimeout(() => {
          this.emitTranscript(
            "candidate",
            "I will scope reads, writes, and durability first, then draw the core flow. ",
            2400,
            4300
          );
        }, 50);
        return;
      }

      if (message.type === "session.thinking.append") {
        const content = String(message.content ?? "");
        if (content.includes("[whiteboard state")) {
          state.boardSummaries++;
          for (let call = 0; call < (options.overlappingToolCalls ?? 1); call++) {
          state.toolCalls++;
          this.emit({ type: "session.delegation.created", delegation_id: `delegation_${state.boardSummaries}_${call}` });
          this.emit({ type: "response.event", event: { type: "response.created" } });
          this.emit({
            type: "response.event",
            event: {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                call_id: `call_board_${state.boardSummaries}_${call}`,
                name: "view_whiteboard",
                arguments: JSON.stringify({ reason: "mock board check" }),
              },
            },
          });
          }
        }
        return;
      }

      if (message.type === "response.item.create") {
        const content = message.item?.content;
        if (
          Array.isArray(content) &&
          content.some((part) => part?.type === "input_image")
        ) {
          state.boardImages++;
        }
        if (message.item?.type === "function_call_output") {
          state.toolResults++;
        }
        return;
      }

      if (message.type === "response.create") {
        state.backendRuns++;
        if (state.boardSummaries > 0) {
          this.emit({ type: "response.event", event: { type: "response.completed" } });
          this.emitTranscript(
            "interviewer",
            "I can see the client feeding the API layer; tell me how the write path handles duplicates.",
            6500,
            8300
          );
        } else {
          this.emitTranscript("interviewer", "What scale are you assuming for reads and writes?", 4200, 5600);
        }
        return;
      }

      if (message.type === "session.instructions.append") {
        state.instructions++;
        return;
      }

      if (
        message.type === "session.input_audio.mute" ||
        message.type === "session.input_audio.unmute"
      ) {
        const key = message.type === "session.input_audio.unmute" ? "unmuteRequests" : "muteRequests";
        state[key] = (state[key] ?? 0) + 1;
        return;
      }

      if (message.type === "session.close") {
        state.closeRequests++;
        if (!options.omitCloseAck) setTimeout(() => this.emit({ type: "session.closed", reason: "ended" }), options.closeDelayMs ?? 0);
      }
    }

    close() {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      if (this.onclose) this.onclose();
    }
  }

  class FakePeerConnection extends EventTarget {
    constructor() {
      super();
      this.localDescription = null;
      this.remoteDescription = null;
      this.iceGatheringState = "complete";
      this.connectionState = "new";
      this.dataChannel = null;
      this.ontrack = null;
      this.onconnectionstatechange = null;
      this.signalingState = "stable";
      this.sctp = { maxMessageSize: 256 * 1024 };
    }

    createDataChannel(label) {
      this.dataChannel = new FakeDataChannel(this, label);
      return this.dataChannel;
    }

    addTrack() {
      state.tracksAdded++;
    }

    async createOffer() {
      return { type: "offer", sdp: "mock-webrtc-offer" };
    }

    async setLocalDescription(description) {
      this.localDescription = description;
    }

    async setRemoteDescription(description) {
      this.remoteDescription = description;
      state.remoteDescriptions.push(description.sdp);
      this.connectionState = "connected";
      state.emit = (event) => this.dataChannel?.emit(event);
      state.disconnect = () => {
        this.connectionState = "failed";
        this.onconnectionstatechange?.();
      };
      if (options.disconnectAfterMs != null) setTimeout(state.disconnect, options.disconnectAfterMs);
      if (options.omitSessionStart) return;
      setTimeout(() => {
        this.dataChannel?.emit({
          type: "session.started",
          session: { id: "browser_live_mock" },
        });
      }, options.startDelayMs ?? 10);
    }

    close() {
      if (this.connectionState === "closed") return;
      this.connectionState = "closed";
      state.peerConnectionsClosed++;
      state.peerClosedAt = performance.now();
      this.dataChannel?.close();
      if (this.onconnectionstatechange) this.onconnectionstatechange();
    }
  }

  Object.defineProperty(window, "RTCPeerConnection", {
    value: FakePeerConnection,
    configurable: true,
  });
  Object.defineProperty(window, "RTCDataChannel", {
    value: FakeDataChannel,
    configurable: true,
  });
}

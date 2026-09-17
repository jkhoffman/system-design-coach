import test from "node:test";
import assert from "node:assert/strict";
import { installLiveBrowserStub } from "../scripts/live-browser-stub.mjs";
import { GptLiveTransport } from "../src/lib/liveSession.ts";
import { LiveActivity } from "../src/lib/liveProtocol.ts";
import { interviewTransition } from "../src/lib/interviewState.ts";
import { persistFinalSession } from "../src/lib/sessionPersistence.ts";
import { deferred } from "./helpers.mjs";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
function browser(t, options = {}) {
  const properties = ["window", "document", "RTCPeerConnection", "RTCDataChannel", "__liveStub"];
  const originals = properties.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const media = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
  Object.defineProperty(globalThis, "document", { value: { createElement: () => ({ autoplay: false, srcObject: null }) }, configurable: true });
  installLiveBrowserStub(options);
  t.mock.method(globalThis, "fetch", async () => Response.json({ sdp: "mock-answer", ownerToken: "12345678-1234-4234-8234-123456789abc", generation: 1 }));
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    if (media) Object.defineProperty(navigator, "mediaDevices", media);
    else delete navigator.mediaDevices;
  });
  return globalThis.__liveStub;
}
function transport(events = {}, timing = {}) {
  return new GptLiveTransport("test-session", {
    onStatus() {}, onTranscript() {}, onStarted() {}, onUsageSeconds() {},
    onToolCall: async () => "{}", onEnded() {}, ...events,
  }, { startupMs: 100, closeMs: 100, toolMs: 100, ...timing });
}

test("microphone acquired after cancellation is stopped without creating a peer", async (t) => {
  const state = browser(t, { microphoneDelayMs: 30 });
  const live = transport();
  const controller = new AbortController();
  const connecting = live.connect(controller.signal);
  controller.abort();
  await assert.rejects(connecting, { name: "AbortError" });
  await wait(40);
  assert.equal(state.micTracksStopped, 1);
  assert.equal(state.dataChannelsCreated, 0);
  assert.equal(live.traceSnapshot().filter((e) => e.type === "teardown.complete").length, 1);
});

test("missing session start times out and releases media and listeners", async (t) => {
  const state = browser(t, { omitSessionStart: true });
  const live = transport({}, { startupMs: 30 });
  await assert.rejects(live.connect(), /timed out/);
  assert.equal(state.micTracksStopped, 1);
  assert.equal(state.peerConnectionsClosed, 1);
  state.emit({ type: "session.started" });
  await wait();
  assert.equal(live.sessionT0(), null);
});

test("every close caller awaits acknowledgment and completed teardown", async (t) => {
  const state = browser(t, { closeDelayMs: 25 });
  const live = transport();
  await live.connect();
  const first = live.close();
  const second = live.close();
  assert.equal(first, second);
  await wait(5);
  assert.equal(state.micTracksStopped, 1);
  assert.equal(state.peerConnectionsClosed, 0);
  await second;
  assert.equal(state.peerConnectionsClosed, 1);
  assert.equal(state.closeRequests, 1);
  const sends = state.sends;
  live.sendThinking("late board update");
  assert.equal(state.sends, sends);
});

test("close acknowledgment has a deadline", async (t) => {
  const state = browser(t, { omitCloseAck: true });
  const live = transport({}, { closeMs: 15 });
  await live.connect();
  await live.close();
  assert.equal(state.peerConnectionsClosed, 1);
  assert.ok(live.traceSnapshot().some((e) => e.type === "close.ack_timeout"));
});

test("overlapping tools preserve result/image pairing and continue once, including duplicate events", async (t) => {
  const state = browser(t, { overlappingToolCalls: 2 });
  const calls = [deferred(), deferred()];
  let count = 0;
  const live = transport({ onToolCall: () => calls[count++].promise });
  await live.connect();
  live.sendThinking("[whiteboard state]");
  await wait();
  state.emit({ type: "response.event", event: { type: "response.output_item.done", item: {
    type: "function_call", call_id: "call_board_1_0", name: "view_whiteboard" } } });
  calls[1].resolve({ output: "second", image: { dataUrl: "image-two", note: "two" } });
  await wait();
  assert.equal(state.toolResults, 0);
  calls[0].resolve({ output: "first", image: { dataUrl: "image-one", note: "one" } });
  await wait();
  assert.equal(count, 2);
  assert.equal(state.backendRuns, 1);
  const sends = state.sent.filter((event) => event.type.startsWith("response."));
  assert.deepEqual(sends.map((e) => e.callId ?? e.image ?? e.type), [
    "call_board_1_1", "image-two", "call_board_1_0", "image-one", "response.create",
  ]);
  await live.close(false);
});

test("tool timeout produces an error result and shutdown prevents late sends", async (t) => {
  const state = browser(t);
  let signal;
  const live = transport({ onToolCall: (_name, _args, s) => { signal = s; return new Promise(() => {}); } }, { toolMs: 15 });
  await live.connect();
  live.sendThinking("[whiteboard state]");
  await wait(25);
  assert.equal(signal.aborted, true);
  assert.equal(state.toolResults, 1);
  live.sendThinking("[whiteboard state]");
  await wait();
  await live.close(false);
  const sends = state.sends;
  await wait(25);
  assert.equal(state.sends, sends);
});

test("activity completion is idempotent and UI ending cannot return to live", () => {
  const activity = new LiveActivity();
  for (const id of ["one", "two"]) activity.observe({ type: "session.delegation.created", delegation_id: id });
  const done = { type: "session.delegation.completed", delegation_id: "one" };
  activity.observe(done); activity.observe(done);
  assert.equal(activity.pending, true);
  activity.observe({ type: "session.delegation.created", delegation_id: "one" });
  activity.observe({ type: "session.delegation.completed", delegation_id: "two" });
  assert.equal(activity.pending, false);
  assert.equal(interviewTransition("ending", "connected"), "ending");
  assert.equal(interviewTransition("ended", "connect"), "ended");
});

test("final-save retries use the same serialized snapshot", async (t) => {
  const payload = { kind: "finish", endedAt: 1, transcript: [], timeline: [] };
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(init.body);
    payload.endedAt = 2;
    return bodies.length === 1 ? Response.json({ error: "temporary" }, { status: 503 }) : Response.json({ status: "ended", outcome: "saved" });
  });
  await persistFinalSession("test", payload, new AbortController().signal);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

for (const failure of ["throwTrackStop", "throwChannelClose", "throwPeerClose"]) {
  test(`shutdown completes every cleanup after ${failure}`, async (t) => {
    const state = browser(t, { [failure]: true });
    const live = transport();
    await live.connect();
    await live.close(false);
    assert.equal(state.micTracksStopped, 1);
    assert.equal(state.peerConnectionsClosed, 1);
    assert.ok(live.traceSnapshot().some((event) => event.type === "teardown.error"));
    assert.ok(live.traceSnapshot().some((event) => event.type === "teardown.complete"));
  });
}

test("SDP failure cancels startup and confirmation is retried before announcing live", async (t) => {
  const state = browser(t);
  const remote = RTCPeerConnection.prototype.setRemoteDescription;
  t.mock.method(RTCPeerConnection.prototype, "setRemoteDescription", async () => { throw new Error("bad SDP"); });
  const actions = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body); actions.push(body.action ?? "create");
    return Response.json({ sdp: "answer", ownerToken: crypto.randomUUID(), generation: 1 });
  });
  await assert.rejects(transport().connect(), /bad SDP/);
  assert.deepEqual(actions, ["create", "cancel"]); assert.equal(state.micTracksStopped, 1);
  t.mock.method(RTCPeerConnection.prototype, "setRemoteDescription", remote);
  let confirms = 0, starts = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (JSON.parse(init.body).action === "confirm" && ++confirms === 1) return Response.json({}, { status: 503 });
    return Response.json({ sdp: "answer", ownerToken: crypto.randomUUID(), generation: 2 });
  });
  const live = transport({ onStarted() { starts++; } }, { startupMs: 1000 });
  await live.connect(); assert.equal(confirms, 2); assert.equal(starts, 1);
  await live.close(false);
});

test("final-save conflicts stop retries and preserve the caller's payload", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error: "ownership conflict" }, { status: 409 }); });
  const payload = { kind: "finish", transcript: [{ text: "local work" }] };
  await assert.rejects(persistFinalSession("test", payload, new AbortController().signal), /ownership conflict/);
  assert.equal(calls, 1); assert.equal(payload.transcript[0].text, "local work");
});

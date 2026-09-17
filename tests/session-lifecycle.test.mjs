import { activateSession, ownerFor, finishFields } from "./helpers.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseFixture, fakeClock, sessionInput, deferred } from "./helpers.mjs";

const { db } = await databaseFixture();
const commands = await import("../src/lib/sessionCommands.ts");
const { PATCH } = await import("../src/app/api/sessions/[id]/route.ts");
const { POST: connect } = await import("../src/app/api/live/session/route.ts");
const content = (text) => ({ transcript: [{ speaker: "candidate", startMs: 0, endMs: 1000, text }], timeline: [] });
function start() {
  const session = db.createSession(sessionInput);
  activateSession(commands, session.id);
  return session.id;
}

test("newer checkpoints win; finish freezes content across retries and late progress", () => {
  const id = start();
  assert.equal(commands.saveSessionProgress(id, { ...ownerFor(id), revision: 2, ...content("new") }), true);
  assert.equal(commands.saveSessionProgress(id, { ...ownerFor(id), revision: 1, ...content("old") }), false);
  assert.equal(db.getSession(id).transcript[0].text, "new");
  assert.equal(commands.finishSession(id, { ...finishFields(id), endedAt: Date.now(), ...content("final") }), "saved");
  assert.equal(commands.saveSessionProgress(id, { ...ownerFor(id), revision: 3, ...content("late") }), false);
  assert.equal(commands.finishSession(id, { ...finishFields(id), endedAt: Date.now(), ...content("retry") }), "ownership_conflict");
  assert.equal(db.getSession(id).transcript[0].text, "final");
});

test("a progress body arriving after finish cannot overwrite the saved transcript", async () => {
  const id = start();
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const ctx = { params: Promise.resolve({ id }) };
  const progress = PATCH(new Request("http://local", { method: "PATCH", body: stream, duplex: "half" }), ctx);
  await Promise.resolve();
  const finish = await PATCH(new Request("http://local", { method: "PATCH", body: JSON.stringify({ kind: "finish", ...finishFields(id), endedAt: Date.now(), ...content("final") }) }), ctx);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ kind: "progress", ...ownerFor(id), revision: 1, ...content("old") })));
  controller.close();
  assert.equal(finish.status, 200);
  assert.equal((await progress).status, 409);
  assert.equal(db.getSession(id).transcript[0].text, "final");
});

test("connection reservations reject duplicates and fence expired, released, or finished attempts", (t) => {
  const clock = fakeClock(t);
  const id = db.createSession(sessionInput).id;
  const old = commands.reserveSessionStart(id);
  assert.ok(old);
  assert.equal(commands.reserveSessionStart(id), null);
  clock.advance(commands.START_LEASE_MS + 1);
  commands.expireSessionStarts(id);
  const current = commands.reserveSessionStart(id);
  assert.ok(current);
  assert.equal(commands.completeSessionStart(id, old, "old_live"), false);
  commands.releaseSessionStart(id, old);
  assert.equal(commands.completeSessionStart(id, current, "current_live", false), true);
  assert.equal(commands.confirmSessionStart(id, commands.attemptOwner(id, current)), true);
  assert.equal(db.getSession(id).recordingStatus, "unavailable");
  commands.finishSession(id, { ...commands.attemptOwner(id, current), requestId: crypto.randomUUID(), endedAt: clock.now(), ...content("finished") });
  assert.equal(commands.completeSessionStart(id, current, "late_live"), false);
  assert.equal(db.getSession(id).liveSessionId, "current_live");
});

test("concurrent live-session requests perform one external create", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "mock-key";
  t.after(() => { if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey; });
  const id = db.createSession(sessionInput).id;
  const response = deferred();
  const entered = deferred();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; entered.resolve(); return response.promise; });
  const request = () => new Request("http://local", { method: "POST", body: JSON.stringify({ ownerToken: crypto.randomUUID(), sessionId: id, sdp: "offer" }) });
  const first = connect(request());
  await entered.promise;
  const second = await connect(request());
  assert.equal(second.status, 409);
  response.resolve(Response.json({ id: "live_once", transport: { sdp: "answer" } }));
  assert.equal((await first).status, 200);
  assert.equal(calls, 1);
});

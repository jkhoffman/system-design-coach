import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { databaseFixture, activateSession, finishFields, fakeClock, sessionInput, deferred } from "./helpers.mjs";
import { gradeReport } from "../scripts/mock-fixtures.mjs";
import { HistoricalGradeSchema, readStoredGrade } from "../src/lib/legacyContracts.ts";
import { GradeReportSchema } from "../src/lib/schemas.ts";
import { SnapshotBudget } from "../src/lib/snapshotBudget.ts";
import { captureFinalPayload } from "../src/lib/finalCapture.ts";
import { OWNER_LEASE_MS } from "../src/lib/ownership.ts";

const { db, directory } = await databaseFixture();
const commands = await import("../src/lib/sessionCommands.ts");
const jobs = await import("../src/lib/sessionJobs.ts");
const { getDb } = await import("../src/lib/database.ts");
const artifacts = await import("../src/lib/artifacts.ts");
const { downloadRecording, retryAfterMs } = await import("../src/lib/downloadRecording.ts");
const { reconcileConnections, connectionBlocker } = await import("../src/lib/connectionCleanup.ts");
const { POST: connect } = await import("../src/app/api/live/session/route.ts");
const { POST: connectionCommand } = await import("../src/app/api/sessions/[id]/connection/route.ts");
const { POST: recover } = await import("../src/app/api/sessions/[id]/recover/route.ts");
const { GET: status } = await import("../src/app/api/sessions/[id]/status/route.ts");
const { getReviewSession } = await import("../src/lib/sessionQueries.ts");
const context = (id) => ({ params: Promise.resolve({ id }) });
const request = (body) => new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });
const content = (text) => ({ transcript: [{ speaker: "candidate", startMs: 0, endMs: 1, text }], timeline: [] });
function ended() {
  const id = db.createSession(sessionInput).id;
  activateSession(commands, id);
  assert.equal(commands.finishSession(id, { ...finishFields(id), endedAt: Date.now(), ...content("final") }), "saved");
  return id;
}
function wav() { const data = Buffer.alloc(48); data.write("RIFF"); data.write("WAVE", 8); return data; }
function providerKey(t) {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  t.after(() => { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; });
}


test("prepared sessions stay retryable; cancellation hangs up known upstream sessions and fences late callbacks", async (t) => {
  providerKey(t);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    return String(url).endsWith("/hangup") ? Response.json({}) : Response.json({ id: "live_prepared", transport: { sdp: "answer" } });
  });
  const id = db.createSession(sessionInput).id;
  const response = await connect(request({ sessionId: id, ownerToken: crypto.randomUUID(), sdp: "offer" }));
  const owner = await response.json();
  assert.equal(response.status, 200); assert.equal(db.getSession(id).status, "created");
  assert.equal((await connectionCommand(request({ action: "cancel", ...owner }), context(id))).status, 200);
  assert.ok(calls.some((url) => url.endsWith("/live_prepared/hangup")));
  const token = commands.reserveSessionStart(id);
  assert.ok(token);
  commands.releaseSessionStart(id, owner.ownerToken);
  assert.equal(commands.confirmSessionStart(id, owner), false);
  assert.equal(commands.completeSessionStart(id, token, "new_provider"), true);
  const current = commands.attemptOwner(id, token);
  assert.equal(commands.confirmSessionStart(id, current), true);
  assert.equal(commands.confirmSessionStart(id, current), true, "lost confirmation acknowledgments are retryable");
  assert.equal(commands.ownsSession(id, current), true);
});

test("abort after provider create retains identity and performs independent cleanup", async (t) => {
  providerKey(t);
  const controller = new AbortController(); let cleanup = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/hangup")) { cleanup++; assert.equal(init.signal.aborted, false); return Response.json({}); }
    controller.abort();
    return Response.json({ session: { id: "live_aborted" }, transport: { sdp: "answer" } });
  });
  const id = db.createSession(sessionInput).id;
  const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ sessionId: id, ownerToken: crypto.randomUUID(), sdp: "offer" }), signal: controller.signal });
  const response = await connect(req);
  assert.notEqual(response.status, 200); assert.equal(cleanup, 1);
  assert.ok(commands.reserveSessionStart(id));
});

test("failed hang-up blocks replacement until reconciliation succeeds; missing IDs stay explicit", async (t) => {
  const id = db.createSession(sessionInput).id;
  const token = commands.reserveSessionStart(id);
  commands.completeSessionStart(id, token, "orphan"); commands.releaseSessionStart(id, token);
  t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 403 }));
  await reconcileConnections(id);
  assert.match(connectionBlocker(id), /could not be closed/);
  assert.equal(commands.reserveSessionStart(id), null);
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await reconcileConnections(id);
  assert.equal(connectionBlocker(id), null);
  const unknown = commands.reserveSessionStart(id);
  commands.markUnknownStart(id, unknown); commands.releaseSessionStart(id, unknown);
  assert.match(connectionBlocker(id), /did not return a session ID/);
  assert.equal(commands.reserveSessionStart(id), null);
});

test("expired startup cannot confirm and its known provider identity is reconciled before reuse", async (t) => {
  const clock = fakeClock(t);
  const id = db.createSession(sessionInput).id;
  const token = commands.reserveSessionStart(id);
  commands.completeSessionStart(id, token, "expired");
  clock.advance(commands.START_LEASE_MS + 1);
  assert.equal(commands.confirmSessionStart(id, commands.attemptOwner(id, token)), false);
  let hangups = 0;
  t.mock.method(globalThis, "fetch", async () => { hangups++; return Response.json({}); });
  await reconcileConnections(id);
  assert.equal(hangups, 1); assert.ok(commands.reserveSessionStart(id));
});

test("stale-tab recovery cannot finish a healthy owner and consumes latest server checkpoint after expiry", async (t) => {
  const clock = fakeClock(t);
  const id = db.createSession(sessionInput).id;
  const owner = activateSession(commands, id);
  commands.saveSessionProgress(id, { ...owner, revision: 1, ...content("older checkpoint") });
  const recoveryId = crypto.randomUUID();
  assert.equal((await recover(request({ requestId: recoveryId, ...content("stale page props") }), context(id))).status, 409);
  clock.advance(60_000); assert.equal(commands.renewSessionOwner(id, owner), true);
  clock.advance(90_000); assert.equal(commands.recoverSession(id, recoveryId), "ownership_conflict");
  assert.equal(commands.saveSessionProgress(id, { ...owner, revision: 2, ...content("latest checkpoint") }), true);
  clock.advance(OWNER_LEASE_MS);
  assert.equal(commands.recoverSession(id, recoveryId), "saved");
  assert.equal(commands.recoverSession(id, recoveryId), "already_saved_by_this_request");
  assert.equal(db.getSession(id).transcript[0].text, "latest checkpoint");
  assert.equal(commands.saveSessionProgress(id, { ...owner, revision: 3, ...content("late") }), false);
  assert.equal(commands.finishSession(id, { ...owner, requestId: crypto.randomUUID(), endedAt: clock.now(), ...content("stale finish") }), "ownership_conflict");
});

test("only an identical final request is acknowledged as an idempotent save", () => {
  const id = db.createSession(sessionInput).id;
  const owner = activateSession(commands, id);
  const payload = { ...owner, requestId: crypto.randomUUID(), endedAt: Date.now(), ...content("accepted") };
  assert.equal(commands.finishSession(id, payload), "saved");
  assert.equal(commands.finishSession(id, payload), "already_saved_by_this_request");
  assert.equal(commands.finishSession(id, { ...payload, ...content("different content") }), "ownership_conflict");
  assert.equal(commands.finishSession(id, { ...payload, requestId: crypto.randomUUID() }), "ownership_conflict");
  assert.equal(db.getSession(id).transcript[0].text, "accepted");
});

test("legacy evidence remains readable; malformed grades retain their original through failed replacement", () => {
  const old = gradeReport(); old.overall.summary = "x".repeat(25_000);
  old.dimensions[0].moments = [{ startMs: -50, note: "old evidence" }]; delete old.drills;
  assert.equal(GradeReportSchema.safeParse(old).success, false);
  const read = HistoricalGradeSchema.parse(old);
  assert.equal(read.overall.summary.length, 25_000); assert.equal(read.dimensions[0].moments[0].startMs, null);
  assert.deepEqual(read.drills, []);
  assert.equal(readStoredGrade("{broken").state, "unreadable");
  const id = ended();
  getDb().prepare("UPDATE interview_sessions SET status = 'graded', grade = '{broken', grade_readable = 0, grading_status = 'done' WHERE id = ?").run(id);
  assert.match(getReviewSession(id).gradeReadError, /cannot be read/);
  assert.equal(jobs.getSessionJobStatus(id).grade.status, "failed");
  assert.equal(jobs.claimJob(id, "grade"), null);
  const first = jobs.claimJob(id, "grade", true); assert.ok(first);
  jobs.failJob(first, "transient failure");
  assert.equal(getDb().prepare("SELECT grade FROM interview_sessions WHERE id = ?").get(id).grade, "{broken");
  const second = jobs.claimJob(id, "grade", true);
  assert.equal(jobs.finishGrading(second, gradeReport()), true);
  assert.ok(getReviewSession(id).grade); assert.equal(getReviewSession(id).gradeReadError, undefined);
});

test("relocated images and both recording names resolve locally; missing-file GETs preserve references", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYVkAAAAASUVORK5CYII=";
  const id = ended();
  const imageReference = await artifacts.saveFinalImage(id, png);
  assert.equal(path.isAbsolute(imageReference), false);
  getDb().prepare("UPDATE interview_sessions SET final_image_path = ? WHERE id = ?").run(`/old/location/${imageReference}`, id);
  assert.ok(await artifacts.readFinalImage(id));
  for (const name of [`${id}.wav`, `${id}-${crypto.randomUUID()}.wav`]) {
    await fs.writeFile(path.join(directory, "recordings", name), wav());
    const oldPath = `/old/location/recordings/${name}`;
    getDb().prepare("UPDATE interview_sessions SET recording_status = 'done', recording_path = ? WHERE id = ?").run(oldPath, id);
    const file = await artifacts.availableRecording(id); assert.ok(file);
    const response = await artifacts.serveRecording(file, new Request("http://local", { headers: { range: "bytes=0-11" } }));
    assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 12);
    await fs.rm(file);
    for (let i = 0; i < 2; i++) {
      const result = await (await status(new Request("http://local"), context(id))).json();
      assert.equal(result.recording.status, "failed");
      assert.equal(getDb().prepare("SELECT recording_path FROM interview_sessions WHERE id = ?").get(id).recording_path, oldPath);
    }
  }
  getDb().prepare("UPDATE interview_sessions SET final_image_path = '/outside/secret.png', final_image = ? WHERE id = ?").run(png, id);
  assert.ok(await artifacts.readFinalImage(id));
});

test("advancing downloads outlive the old budget with renewable leases; ownership loss cannot renew", async (t) => {
  const clock = fakeClock(t);
  const id = ended(); const attempt = jobs.claimJob(id, "recording");
  let stream;
  const response = new Response(new ReadableStream({ start(c) { stream = c; c.enqueue(wav()); } }));
  const pending = artifacts.publishRecording(response, attempt, new AbortController().signal);
  clock.advance(60_000); assert.equal(jobs.renewJob(attempt), true);
  clock.advance(60_000); assert.equal(jobs.ownsJob(attempt), true);
  stream.close(); await pending; assert.ok(await artifacts.availableRecording(id));
  assert.equal(jobs.renewJob(attempt), false);
});

test("job renewal aborts on lost ownership and idle transfers clean private files", async (t) => {
  const id = ended(); const attempt = jobs.claimJob(id, "recording");
  const entered = deferred();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const running = jobs.runOwnedJob(attempt, async (signal) => {
    entered.resolve();
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  await entered.promise;
  getDb().prepare("UPDATE interview_sessions SET recording_attempt = 'other' WHERE id = ?").run(id);
  const rejected = assert.rejects(running, /ownership/);
  t.mock.timers.tick(20_000); await rejected;
  t.mock.timers.reset();
  const idleId = ended(); const idleAttempt = jobs.claimJob(idleId, "recording");
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(wav()); } }));
  await assert.rejects(artifacts.publishRecording(response, idleAttempt, new AbortController().signal, 10));
  assert.deepEqual((await fs.readdir(path.join(directory, "recordings"))).filter((name) => name.startsWith(idleId)), []);
});

test("recording retries network errors and retryable HTTP, but rejects permanent errors and invalid media", async (t) => {
  let calls = 0;
  const id = ended(); const attempt = jobs.claimJob(id, "recording");
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) throw new TypeError("temporary network failure");
    if (calls === 2) return new Response("busy", { status: 429, headers: { "Retry-After": "0" } });
    if (calls === 3) return new Response("busy", { status: 503, headers: { "Retry-After": "0" } });
    return new Response(wav());
  });
  await downloadRecording(attempt, "upstream", new AbortController().signal, { backoffMs: 0 });
  assert.equal(calls, 4); assert.ok(await artifacts.availableRecording(id));
  calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("denied", { status: 403 }); });
  await assert.rejects(downloadRecording(jobs.claimJob(ended(), "recording"), "upstream", new AbortController().signal), /403/);
  assert.equal(calls, 1);
  calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("not a wav file"); });
  await assert.rejects(downloadRecording(jobs.claimJob(ended(), "recording"), "upstream", new AbortController().signal), /WAV/);
  assert.equal(calls, 1); assert.equal(retryAfterMs("2", 1), 2000);
});

test("failed or empty exports do not spend snapshot capacity; optional scenes cannot lose final content", () => {
  const budget = new SnapshotBudget(2, 45_000);
  for (let i = 0; i < 15; i++) { assert.ok(budget.reserve(0)); assert.equal(budget.reserve(0), null); budget.release(); }
  const commit = budget.reserve(0); commit(); budget.release();
  assert.equal(budget.reserve(44_999), null);
  budget.reserve(45_000)(); budget.release(); assert.equal(budget.reserve(90_000), null);
  const core = { kind: "finish", ...finishFields(ended()), endedAt: Date.now(), ...content("keep this") };
  const cyclic = []; cyclic.push(cyclic);
  const saved = captureFinalPayload(core, () => cyclic);
  assert.equal(saved.finalScene, undefined);
  core.transcript[0].text = "later mutation";
  assert.equal(saved.transcript[0].text, "keep this");
  assert.equal(captureFinalPayload(core, () => { throw new Error("export failed"); }).transcript.length, 1);
});

test("missing provider IDs and interrupted creates remain durably unknown after startup expiry", async (t) => {
  providerKey(t);
  const clock = fakeClock(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ transport: { sdp: "answer-without-id" } }));
  const id = db.createSession(sessionInput).id;
  const response = await connect(request({ sessionId: id, ownerToken: crypto.randomUUID(), sdp: "offer" }));
  assert.equal(response.status, 502); assert.match(connectionBlocker(id), /session ID/);
  const crashed = db.createSession(sessionInput).id;
  const token = commands.reserveSessionStart(crashed);
  commands.markUnknownStart(crashed, token); // Process stops after sending the provider request.
  clock.advance(commands.START_LEASE_MS + 1);
  commands.expireSessionStarts(crashed);
  assert.equal(commands.reserveSessionStart(crashed), null);
  assert.match(connectionBlocker(crashed), /session ID/);
});

test("late provider response after lease loss is hung up without changing the newer attempt", async (t) => {
  providerKey(t);
  const clock = fakeClock(t);
  const id = db.createSession(sessionInput).id;
  const entered = deferred(); const providerResponse = deferred();
  let hangups = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/hangup")) { hangups++; return Response.json({}); }
    entered.resolve(); return providerResponse.promise;
  });
  const token = crypto.randomUUID();
  const pending = connect(request({ sessionId: id, ownerToken: token, sdp: "offer" }));
  await entered.promise;
  clock.advance(commands.START_LEASE_MS + 1);
  commands.expireSessionStarts(id);
  providerResponse.resolve(Response.json({ id: "late_live", transport: { sdp: "answer" } }));
  assert.equal((await pending).status, 409);
  assert.equal(hangups, 1);
  assert.equal(db.getSession(id).status, "created");
  const next = commands.reserveSessionStart(id);
  assert.ok(next); assert.notEqual(next, token);
});

test("grading retries transient API failures within its owned operation", async (t) => {
  providerKey(t);
  const { POST: grade } = await import("../src/app/api/sessions/[id]/grade/route.ts");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) return Response.json({ error: { message: "try again" } }, { status: 503, headers: { "retry-after-ms": "1" } });
    return Response.json({ id: "resp_test", object: "response", output: [{ type: "message", role: "assistant", content: [
      { type: "output_text", text: JSON.stringify(gradeReport()), annotations: [] },
    ] }] });
  });
  const id = ended();
  const response = await grade(request({}), context(id));
  assert.equal(response.status, 200); assert.equal(calls, 2);
  assert.equal(jobs.getSessionJobStatus(id).grade.status, "done");
});

test("a long owned operation stays alive beyond old recording and client deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_800_000_000_000 });
  const id = ended(); const attempt = jobs.claimJob(id, "recording");
  const release = deferred(); let operationSignal;
  const running = jobs.runOwnedJob(attempt, async (signal) => { operationSignal = signal; await release.promise; signal.throwIfAborted(); });
  // Advancing work is tested by streaming cases; here exercise the real total deadline and automatic renewer.
  for (let i = 0; i < 7; i++) {
    t.mock.timers.tick(20_000);
    assert.equal(operationSignal.aborted, false);
    assert.equal(jobs.ownsJob(attempt), true);
  }
  release.resolve(); await running;
});

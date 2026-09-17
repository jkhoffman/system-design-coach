import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { databaseFixture, fakeClock, sessionInput, deferred } from "./helpers.mjs";
const { db, directory } = await databaseFixture();
const { getDb } = await import("../src/lib/database.ts");
const commands = await import("../src/lib/sessionCommands.ts");
const jobs = await import("../src/lib/sessionJobs.ts");
const artifacts = await import("../src/lib/artifacts.ts");
const queries = await import("../src/lib/sessionQueries.ts");
const { readJsonBody } = await import("../src/lib/http.ts");
const { PATCH } = await import("../src/app/api/sessions/[id]/route.ts");
const { GET: image } = await import("../src/app/api/sessions/[id]/image/route.ts");
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYVkAAAAASUVORK5CYII=";
function started() {
  const session = db.createSession(sessionInput);
  commands.completeSessionStart(session.id, commands.reserveSessionStart(session.id), "test_live");
  return session.id;
}
function ended() {
  const id = started();
  commands.finishSession(id, { endedAt: Date.now(), transcript: [], timeline: [] });
  return id;
}
function wav(value = 1) {
  const bytes = Buffer.alloc(48, value);
  bytes.write("RIFF"); bytes.writeUInt32LE(40, 4); bytes.write("WAVE", 8);
  return bytes;
}

test("final images are externalized once and legacy inline boards still render", async () => {
  const id = started();
  const finish = (image) => PATCH(new Request("http://localhost", { method: "PATCH", body: JSON.stringify({
    kind: "finish", endedAt: Date.now(), transcript: [], timeline: [], finalImage: image,
  }) }), { params: Promise.resolve({ id }) });
  assert.equal((await finish(png)).status, 200);
  const raw = getDb().prepare("SELECT final_image, final_image_path FROM interview_sessions WHERE id = ?").get(id);
  assert.equal(raw.final_image, null);
  assert.ok(raw.final_image_path);
  assert.equal((await finish(png)).status, 200);
  assert.equal((await fs.readdir(path.join(directory, "snapshots", id))).length, 1);
  const session = queries.getReviewSession(id);
  assert.equal(session.finalImage, undefined);
  assert.equal(session.finalImageUrl, `/api/sessions/${id}/image`);
  const response = await image(new Request("http://localhost"), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const legacy = ended();
  getDb().prepare("UPDATE interview_sessions SET final_image = ? WHERE id = ?").run(png, legacy);
  assert.deepEqual((await artifacts.readFinalImage(legacy)).bytes, Buffer.from(png.split(",")[1], "base64"));
});

test("milestones validate content and paths and retain the first accepted image", async () => {
  const id = started();
  const name = await artifacts.saveSnapshot(id, 123, png);
  await artifacts.saveSnapshot(id, 123, png);
  assert.equal(name, "123.png");
  assert.ok((await artifacts.readSnapshot(id, name)).length > 8);
  assert.equal(await artifacts.readSnapshot(id, "../escape.png"), null);
  assert.throws(() => artifacts.decodeImage("data:image/png;base64,YmFk"), /content/);
});

test("cancelled recording streams expose no file and clean their temporary data", async () => {
  const id = ended();
  const attempt = jobs.claimJob(id, "recording");
  let stream;
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(wav()); } }));
  const controller = new AbortController();
  const saving = artifacts.publishRecording(response, attempt, controller.signal);
  assert.equal(await artifacts.availableRecording(id), null);
  controller.abort();
  await assert.rejects(saving, { name: "AbortError" });
  assert.equal(queries.getRecordingSession(id).recordingPath, undefined);
  assert.deepEqual((await fs.readdir(path.join(directory, "recordings"))).filter((file) => file.startsWith(id)), []);
  void stream;
});

test("a stale download cannot overwrite the published recording; seeking and missing-file recovery work", async (t) => {
  const clock = fakeClock(t);
  const id = ended();
  const old = jobs.claimJob(id, "recording");
  const ready = deferred();
  let stream;
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(wav(1)); ready.resolve(); } }));
  const late = artifacts.publishRecording(response, old, new AbortController().signal);
  await ready.promise;
  clock.advance(jobs.JOB_TIMING.recording.leaseMs + 1);
  const current = jobs.claimJob(id, "recording");
  await artifacts.publishRecording(new Response(wav(2)), current, new AbortController().signal);
  stream.close();
  await assert.rejects(late, /expired or superseded/);
  const file = await artifacts.availableRecording(id);
  assert.deepEqual(await fs.readFile(file), wav(2));
  assert.deepEqual((await fs.readdir(path.join(directory, "recordings"))).filter((file) => file.startsWith(id)), [path.basename(file)]);
  const responseRange = await artifacts.serveRecording(file, new Request("http://localhost", { headers: { range: "bytes=12-19" } }));
  assert.equal(responseRange.status, 206);
  assert.equal(responseRange.headers.get("content-range"), "bytes 12-19/48");
  assert.deepEqual(Buffer.from(await responseRange.arrayBuffer()), wav(2).subarray(12, 20));
  await fs.rm(file);
  assert.equal(await artifacts.availableRecording(id), null);
  assert.equal(jobs.getSessionJobStatus(id).recording.status, "idle");
});

test("lightweight queries do not parse unrelated interview content or include inline images", () => {
  const id = ended();
  const before = JSON.stringify(jobs.getSessionJobStatus(id));
  getDb().prepare("UPDATE interview_sessions SET final_image = ?, live_trace = 'bad JSON', final_scene = 'bad JSON' WHERE id = ?")
    .run(png.repeat(1000), id);
  assert.equal(JSON.stringify(jobs.getSessionJobStatus(id)), before);
  assert.ok(queries.getReviewSession(id));
  assert.ok(queries.getGradingSession(id));
  getDb().prepare("UPDATE interview_sessions SET transcript = 'bad JSON', timeline = 'bad JSON' WHERE id = ?").run(id);
  assert.ok(queries.getLiveSetup(id));
  assert.ok(queries.getRecordingSession(id));
});

test("JSON readers stop oversized streams at the limit and reject dishonest lengths", async () => {
  let pulls = 0, cancelled = false;
  const source = () => new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(16)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await assert.rejects(readJsonBody(new Request("http://localhost", { method: "POST", body: source(), duplex: "half", headers: { "content-length": "1" } }), 20), { status: 413 });
  assert.equal(pulls, 2); assert.equal(cancelled, true);
  pulls = 0; cancelled = false;
  await assert.rejects(readJsonBody(new Request("http://localhost", { method: "POST", body: source(), duplex: "half", headers: { "content-length": "100" } }), 20), { status: 413 });
  assert.equal(pulls, 0); assert.equal(cancelled, true);
  assert.deepEqual(await readJsonBody(new Request("http://localhost", { method: "POST", body: '{"ok":true}' }), 20), { ok: true });
});

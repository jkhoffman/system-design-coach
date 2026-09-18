import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { installLiveBrowserStub } from "./live-browser-stub.mjs";
import { startMockApp, waitFor } from "./mock-app.mjs";

const ROOT = process.cwd();

async function createSession(baseUrl) {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "library",
      briefing: { company: "Example", position: "Backend SWE", level: "L5" },
      promptId: "url-shortener",
      durationSec: 300,
    }),
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `session create failed: ${JSON.stringify(body)}`);
  assert.ok(body.session?.id, "session create returned no id");
  return body.session;
}

async function runFreeformPromptFlow(baseUrl, mock) {
  const expandResponse = await fetch(`${baseUrl}/api/prompts/expand`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: "Design a ledger service for a marketplace with exactly-once payouts.",
      level: "L5",
    }),
  });
  const expandBody = await expandResponse.json().catch(() => ({}));
  assert.equal(expandResponse.status, 200, `prompt expand failed: ${JSON.stringify(expandBody)}`);
  assert.ok(expandBody.prompt?.id, "expanded prompt has no saved ID");
  assert.equal(expandBody.prompt.factSheet, undefined, "public prompt exposed hidden fact sheet");

  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "freeform",
      briefing: { company: "", position: "", level: "L5" },
      promptId: expandBody.prompt.id,
      durationSec: 300,
    }),
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `freeform session create failed: ${JSON.stringify(body)}`);
  assert.equal(body.session?.mode, "freeform", "freeform session mode not persisted");
  assert.equal(mock.counts.promptResponses, 1, "expected exactly one prompt-spec generation call");
}

async function getSession(baseUrl, id) {
  const response = await fetch(`${baseUrl}/api/sessions/${id}`);
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `session fetch failed: ${JSON.stringify(body)}`);
  return body.session;
}

async function getDiagnostics(baseUrl, id) {
  const response = await fetch(`${baseUrl}/api/sessions/${id}/diagnostics`);
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `diagnostics fetch failed: ${JSON.stringify(body)}`);
  return body;
}

async function waitForSession(baseUrl, id, predicate, description) {
  return await waitFor(async () => {
    const session = await getSession(baseUrl, id);
    return predicate(session) ? session : null;
  }, description, 60_000);
}

function assertSortedTimeline(timeline) {
  for (let i = 1; i < timeline.length; i++) {
    assert.ok(
      timeline[i].startMs >= timeline[i - 1].startMs,
      `timeline out of order at ${i}: ${timeline[i - 1].startMs} -> ${timeline[i].startMs}`
    );
  }
}

async function joinMockInterview(page, baseUrl, sessionId) {
  await page.goto(`${baseUrl}/interview/${sessionId}`);
  await page.getByRole("button", { name: "Join interview" }).click();
  await page
    .locator("aside")
    .filter({ hasText: "Interviewer:" })
    .first()
    .waitFor({ timeout: 15_000 });
}

async function drawClientBox(page) {
  const canvas = page.locator("main canvas").last();
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  const box = await canvas.boundingBox();
  assert.ok(box, "whiteboard canvas did not render");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.keyboard.press("r");
  await page.mouse.move(cx - 180, cy - 100);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy - 20, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("t");
  await page.mouse.click(cx - 80, cy - 60);
  await page.keyboard.type("Client");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

async function runHappyPath(context, baseUrl, mock, pageErrors) {
  const session = await createSession(baseUrl);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`happy path: ${error}`));

  await joinMockInterview(page, baseUrl, session.id);
  await drawClientBox(page);

  await page.waitForFunction(
    () =>
      window.__liveStub?.boardSummaries >= 1 &&
      window.__liveStub?.boardImages >= 1 &&
      window.__liveStub?.toolCalls >= 1 &&
      window.__liveStub?.toolResults >= 1,
    undefined,
    { timeout: 20_000 }
  );

  await page.getByRole("button", { name: "End interview" }).click();
  const stub = await waitFor(
    async () => {
      const value = await page.evaluate(() => window.__liveStub);
      return value?.peerConnectionsClosed >= 1 && value?.micTracksStopped >= 1 ? value : null;
    },
    "browser transport teardown",
    20_000
  );
  await page.waitForURL("**/review", { timeout: 30_000 });

  const finished = await waitForSession(
    baseUrl,
    session.id,
    (value) => value.status === "graded" && value.recordingStatus === "done" && value.hasRecording,
    "graded session and downloaded recording"
  );

  assert.equal(finished.gradeStatus, "done");
  assert.equal(finished.grade?.overall?.signal, "lean_hire");
  assert.equal(finished.grade?.overall?.score, 4);
  assert.equal(finished.grade?.dimensions?.length, 6);
  assert.ok(finished.endedAt, "endedAt was not persisted");
  assert.ok(finished.finalImageUrl, "final image was not persisted");
  const finalImage = await fetch(`${baseUrl}${finished.finalImageUrl}`);
  assert.equal(finalImage.headers.get("content-type"), "image/png");
  assert.ok((await finalImage.arrayBuffer()).byteLength > 8, "final image is empty");
  assert.ok(finished.transcript.some((turn) => turn.speaker === "interviewer"));
  assert.ok(finished.transcript.some((turn) => turn.speaker === "candidate"));
  assert.ok(finished.timeline.some((event) => event.kind === "marker"));
  assert.ok(finished.timeline.some((event) => event.kind === "board"));
  assertSortedTimeline(finished.timeline);
  const snapshot = finished.timeline.find((event) => event.kind === "snapshot");
  assert.ok(snapshot, "no milestone snapshot was persisted");

  const snapshotResponse = await fetch(
    `${baseUrl}/api/sessions/${session.id}/snapshot?file=${encodeURIComponent(snapshot.file)}`
  );
  assert.equal(snapshotResponse.status, 200, "persisted snapshot was not served");
  assert.match(snapshotResponse.headers.get("content-type") ?? "", /image\/png/);

  const recordingResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/recording`);
  assert.equal(recordingResponse.status, 200, "recording was not served");
  assert.match(recordingResponse.headers.get("content-type") ?? "", /audio\/wav/);
  const rangeResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/recording`, {
    headers: { Range: "bytes=0-99" },
  });
  assert.equal(rangeResponse.status, 206, "recording range request was not served");

  const diagnostics = await getDiagnostics(baseUrl, session.id);
  assert.ok(diagnostics.analysis.eventCount > 20, "live trace was not persisted");
  assert.equal(diagnostics.analysis.counts.in > 0, true);
  assert.equal(diagnostics.analysis.counts.out > 0, true);
  assert.equal(diagnostics.analysis.counts.local > 0, true);
  const stage = (name) => diagnostics.analysis.stages.find((s) => s.name === name);
  assert.equal(stage("delegation_to_response_created").status, "ok");
  assert.equal(stage("tool_call_to_tool_result").status, "ok");
  assert.equal(stage("tool_result_to_continuation").status, "ok");
  assert.equal(stage("continuation_to_response_completed").status, "ok");
  assert.ok(
    diagnostics.analysis.appendLatencies.some((l) => l.type === "session.thinking.append"),
    "thinking append acknowledgment was not traced"
  );
  assert.ok(
    diagnostics.analysis.turnGaps.some((gap) => gap.durationMs >= 2_000),
    "interviewer response gap was not analyzed"
  );
  const diagnosticsJson = JSON.stringify(diagnostics);
  assert.doesNotMatch(diagnosticsJson, /data:image|base64,|RIFF|WAVE/, "diagnostics exposed raw media");

  await page.getByRole("heading", { name: "Scorecard" }).waitFor({ timeout: 10_000 });
  await page.locator("audio").waitFor({ timeout: 10_000 });

  assert.equal(mock.counts.liveCreate, 1, "mock live session was not created exactly once");
  assert.equal(mock.counts.gradeResponses, 1, "mock grading was not requested exactly once");
  assert.equal(mock.counts.recordingGet, 1, "mock recording was not downloaded exactly once");
  assert.ok(stub.getUserMediaCalls >= 1, "mock microphone was not acquired");
  assert.ok(stub.boardSummaries >= 1, "board summary was not sent to the transport");
  assert.equal(stub.boardImages, 1, "routine board sync unexpectedly queued extra images");
  assert.ok(stub.toolCalls >= 1, "view_whiteboard tool call was not exercised");
  assert.ok(stub.toolResults >= 1, "view_whiteboard tool result was not returned");
  assert.ok(stub.peerConnectionsClosed >= 1, "peer connection was not closed");
  assert.ok(stub.micTracksStopped >= 1, "microphone track was not stopped");

  const toolResultIndex = stub.sent.findIndex(
    (message) => message.itemType === "function_call_output"
  );
  const imageIndex = stub.sent.findIndex(
    (message, index) => index > toolResultIndex && message.hasImage
  );
  const backendRunIndex = stub.sent.findIndex(
    (message, index) => index > imageIndex && message.type === "response.create"
  );
  assert.ok(toolResultIndex >= 0, "view_whiteboard tool result was not sent");
  assert.ok(imageIndex > toolResultIndex, "board image was not sent after the tool result");
  assert.ok(backendRunIndex > imageIndex, "backend run was not requested after the board image");
  assert.ok(
    stub.received.some((message) => message.innerType === "response.created"),
    "delegation did not emit nested response.created"
  );
  assert.ok(
    stub.received.some((message) => message.innerType === "response.completed"),
    "delegation did not complete through response.completed"
  );
  assert.ok(
    stub.received.some((message) => message.type === "session.thinking.appended"),
    "thinking append was not acknowledged"
  );
  const closeIndex = stub.sent.findIndex((message) => message.type === "session.close");
  const sessionClosed = stub.received.find((message) => message.type === "session.closed");
  assert.ok(closeIndex >= 0, "session.close was not sent");
  assert.ok(sessionClosed, "session.closed was not received");
  assert.ok(
    stub.peerClosedAt >= sessionClosed.at,
    "peer connection closed before session.closed was acknowledged"
  );

  await page.close();
}

async function runCheckpointRecovery(context, baseUrl, dataDir, mock, pageErrors) {
  const session = await createSession(baseUrl);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`checkpoint recovery: ${error}`));

  await joinMockInterview(page, baseUrl, session.id);
  await page.waitForTimeout(6_500);
  await page.reload();
  // A reload cannot steal an active lease. Simulate its expiry without a three-minute wait.
  await page.getByRole("button", { name: "Review saved progress" }).click();
  await page.getByText(/active in another tab/).waitFor();
  const database = new DatabaseSync(path.join(dataDir, "app.db"));
  database.prepare("UPDATE interview_sessions SET start_expires_at = 1 WHERE id = ?").run(session.id);
  database.close();
  await page.getByRole("button", { name: "Review saved progress" }).click();
  await page.waitForURL("**/review", { timeout: 30_000 });

  const finished = await waitForSession(
    baseUrl,
    session.id,
    (value) => value.status === "graded" && value.recordingStatus === "done",
    "recovered checkpoint to finish and grade"
  );
  assert.ok(finished.transcript.length >= 1, "checkpointed transcript was not recovered");
  assert.ok(finished.timeline.length >= 1, "checkpointed timeline was not recovered");
  assertSortedTimeline(finished.timeline);
  assert.equal(finished.gradeStatus, "done");
  assert.equal(finished.hasRecording, true);
  assert.equal(mock.counts.liveCreate, 2, "recovery unexpectedly created another live session");
  assert.equal(mock.counts.gradeResponses, 2, "recovered interview was not graded exactly once");
  assert.equal(mock.counts.recordingGet, 2, "recovered recording was not downloaded exactly once");

  const diagnostics = await getDiagnostics(baseUrl, session.id);
  assert.ok(diagnostics.analysis.eventCount > 10, "checkpointed live trace was not persisted");
  assert.ok(
    diagnostics.analysis.eventTypes["session.started"] >= 1,
    "checkpointed trace did not include session.started"
  );

  await page.close();
}

async function runSaveRetry(context, baseUrl, pageErrors) {
  const session = await createSession(baseUrl);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`save retry: ${error}`));
  const payloads = [];
  let failedUploads = 0;
  await page.route(`**/api/sessions/${session.id}/snapshot`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    failedUploads++;
    await route.fulfill({ status: 503, json: { error: "mock upload failure" } });
  });
  await page.route(`**/api/sessions/${session.id}`, async (route) => {
    if (route.request().method() !== "PATCH" || route.request().postDataJSON()?.kind !== "finish") return route.continue();
    payloads.push(route.request().postData());
    if (payloads.length <= 4) return route.fulfill({ status: 503, json: { error: "mock save failure" } });
    return route.continue();
  });
  await joinMockInterview(page, baseUrl, session.id);
  await drawClientBox(page);
  await waitFor(() => failedUploads > 0, "failed board upload", 20_000);
  await page.getByRole("button", { name: "End interview" }).click();
  await page.getByRole("button", { name: "Retry save" }).waitFor({ timeout: 30_000 });
  assert.equal(payloads.length, 4);
  const stopped = await page.evaluate(() => window.__liveStub.micTracksStopped);
  assert.equal(stopped, 1, "microphone stayed active after failed save");
  await page.getByRole("button", { name: "Retry save" }).click();
  await page.waitForURL("**/review", { timeout: 30_000 });
  assert.equal(payloads.length, 5);
  assert.equal(new Set(payloads).size, 1, "final retry payload changed");
  const finished = await waitForSession(baseUrl, session.id,
    (row) => row.gradeStatus === "done" && row.recordingStatus === "done", "review after failed save");
  assert.ok(finished.finalImageUrl, "upload failure lost the final board");
  assert.ok(finished.transcript.length > 0);
  await page.close();
}

async function runExpiredJobs(context, baseUrl, dataDir, mock, pageErrors) {
  const session = await createSession(baseUrl);
  const connection = await fetch(`${baseUrl}/api/live/session`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerToken: crypto.randomUUID(), sessionId: session.id, sdp: "mock-expired-jobs-offer" }) });
  assert.equal(connection.status, 200);
  const { ownerToken, generation } = await connection.json();
  const owner = { ownerToken, generation };
  const confirmed = await fetch(`${baseUrl}/api/sessions/${session.id}/connection`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "confirm", ...owner }) });
  assert.equal(confirmed.status, 200);
  const finish = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "finish", ...owner, requestId: crypto.randomUUID(), endedAt: Date.now(), transcript: [], timeline: [] }) });
  assert.equal(finish.status, 200);
  const database = new DatabaseSync(path.join(dataDir, "app.db"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.prepare(`UPDATE interview_sessions SET grading_status = 'running', grading_attempt = 'expired-grade', grading_expires_at = 1,
      recording_status = 'running', recording_attempt = 'expired-recording', recording_expires_at = 1 WHERE id = ?`).run(session.id);
  } finally { database.close(); }
  const before = { ...mock.counts };
  const pages = await Promise.all([context.newPage(), context.newPage()]);
  for (const page of pages) page.on("pageerror", (error) => pageErrors.push(`expired jobs: ${error}`));
  await Promise.all(pages.map((page) => page.goto(`${baseUrl}/interview/${session.id}/review`)));
  await waitForSession(baseUrl, session.id, (row) => row.gradeStatus === "done" && row.recordingStatus === "done", "expired jobs recovered");
  for (const page of pages) await page.getByRole("heading", { name: "Scorecard" }).waitFor({ timeout: 15_000 });
  assert.equal(mock.counts.gradeResponses - before.gradeResponses, 1, "concurrent tabs duplicated grading");
  assert.equal(mock.counts.recordingGet - before.recordingGet, 1, "concurrent tabs duplicated recording download");
  await Promise.all(pages.map((page) => page.close()));
}

async function runStartupRetry(context, baseUrl, mock, pageErrors) {
  const session = await createSession(baseUrl);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`startup retry: ${error}`));
  await page.goto(`${baseUrl}/interview/${session.id}`);
  await page.evaluate(() => {
    const original = RTCPeerConnection.prototype.setRemoteDescription;
    let failed = false;
    RTCPeerConnection.prototype.setRemoteDescription = function (description) {
      if (!failed) { failed = true; return Promise.reject(new Error("Injected SDP failure")); }
      return original.call(this, description);
    };
  });
  const before = { ...mock.counts };
  await page.getByRole("button", { name: "Join interview" }).click();
  await page.getByText("Injected SDP failure").waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Join interview" }).waitFor();
  assert.equal(mock.counts.liveHangup - before.liveHangup, 1);
  await page.getByRole("button", { name: "Join interview" }).click();
  await page.getByRole("button", { name: "End interview" }).waitFor();
  assert.equal(mock.counts.liveCreate - before.liveCreate, 2);
  await page.getByRole("button", { name: "End interview" }).click();
  await page.waitForURL("**/review");
  await waitForSession(baseUrl, session.id, (row) => row.gradeStatus === "done" && row.recordingStatus === "done", "retried startup review");
  await page.close();
}

async function runStaleTabAndLegacyReview(context, baseUrl, dataDir, mock, pageErrors) {
  const session = await createSession(baseUrl);
  const active = await context.newPage();
  const stale = await context.newPage();
  for (const page of [active, stale]) page.on("pageerror", (error) => pageErrors.push(`stale tab: ${error}`));
  await joinMockInterview(active, baseUrl, session.id);
  await stale.goto(`${baseUrl}/interview/${session.id}`);
  await stale.getByRole("button", { name: "Review saved progress" }).click();
  await stale.getByText(/active in another tab/).waitFor();
  await active.evaluate(() => window.__liveStub.emit({ type: "session.input_transcript.delta", delta: "latest active-tab content", start_ms: 15_000, end_ms: 16_000 }));
  await active.getByText(/latest active-tab content/).waitFor();
  await active.getByRole("button", { name: "End interview" }).click();
  await active.waitForURL("**/review");
  const finished = await waitForSession(baseUrl, session.id, (row) => row.gradeStatus === "done" && row.recordingStatus === "done", "active tab saved");
  assert.ok(finished.transcript.some((turn) => turn.text.includes("latest active-tab content")));
  await stale.getByRole("button", { name: "Review saved progress" }).click();
  await stale.getByText(/already finalized/).waitFor();
  await active.close(); await stale.close();

  const ready = await context.newPage();
  ready.on("pageerror", (error) => pageErrors.push(`ready recording: ${error}`));
  let statusPolls = 0;
  await ready.route(`**/api/sessions/${session.id}/status`, (route) => { statusPolls++; return route.abort(); });
  await ready.goto(`${baseUrl}/interview/${session.id}/review`);
  await ready.locator("audio").waitFor();
  await ready.getByRole("heading", { name: "Scorecard" }).waitFor();
  await ready.waitForTimeout(500);
  assert.equal(statusPolls, 0, "ready recording unnecessarily polled status");
  await ready.close();

  const database = new DatabaseSync(path.join(dataDir, "app.db"));
  database.prepare("UPDATE interview_sessions SET grade = '{broken', grade_readable = 0 WHERE id = ?").run(session.id);
  database.close();
  const repair = await context.newPage();
  repair.on("pageerror", (error) => pageErrors.push(`legacy grade repair: ${error}`));
  const count = mock.counts.gradeResponses;
  await repair.goto(`${baseUrl}/interview/${session.id}/review`);
  await repair.getByText("Saved scorecard needs recovery").waitFor();
  assert.equal(mock.counts.gradeResponses, count, "unreadable grade was retried without an explicit action");
  await repair.getByRole("button", { name: "Retry grading" }).click();
  await repair.getByRole("heading", { name: "Scorecard" }).waitFor({ timeout: 20_000 });
  assert.equal(mock.counts.gradeResponses, count + 1);
  await repair.close();
}

async function runFinalConflict(context, baseUrl, pageErrors) {
  const session = await createSession(baseUrl);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`final conflict: ${error}`));
  let saves = 0;
  await page.route(`**/api/sessions/${session.id}`, async (route) => {
    if (route.request().method() !== "PATCH" || route.request().postDataJSON()?.kind !== "finish") return route.continue();
    saves++;
    return route.fulfill({ status: 409, json: { error: "Another tab finalized this interview" } });
  });
  await joinMockInterview(page, baseUrl, session.id);
  await page.getByRole("button", { name: "End interview" }).click();
  await page.getByText(/Another tab finalized/).waitFor();
  assert.equal(saves, 1, "ownership conflict was automatically retried");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export local work" }).click();
  const download = await downloading;
  const local = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  assert.ok(local.transcript.length > 0);
  assert.equal(local.ownerToken, undefined);
  assert.equal(await page.evaluate(() => window.__liveStub.micTracksStopped), 1);
  await page.close();
}

async function runLongRecordingClient(context, baseUrl, pageErrors) {
  const session = await createSession(baseUrl);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`long recording: ${error}`));
  await page.addInitScript(() => {
    // DOM-native AbortSignal timers are not controlled by Playwright's JS clock.
    AbortSignal.timeout = (ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    };
    const nativeFetch = window.fetch;
    window.fetch = (url, init) => {
      if (String(url).endsWith("/recording") && init?.method === "POST") window.__recordingSignal = init.signal;
      return nativeFetch(url, init);
    };
  });
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(`**/api/sessions/${session.id}/recording`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    entered(); await held; return route.continue();
  });
  await page.clock.install();
  await joinMockInterview(page, baseUrl, session.id);
  await page.getByRole("button", { name: "End interview" }).click();
  await page.waitForURL("**/review");
  await started;
  // Advance past the old 130-second POST deadline while the download is in flight.
  await page.clock.fastForward(131_000);
  assert.equal(await page.evaluate(() => window.__recordingSignal?.aborted), false, "healthy recording POST exceeded its client deadline");
  await page.getByText("Downloading the recording…").waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry recording" }).count(), 0);
  release();
  await page.locator("audio").waitFor({ timeout: 20_000 });
  await page.close();
}

async function runSetupRevision(context, baseUrl, pageErrors) {
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`setup revision: ${error}`));
  // Deliberately ignore cancellation so revision ownership, not fetch behavior, must discard the response.
  await page.addInitScript(() => {
    const nativeFetch = window.fetch;
    window.fetch = (url, init) => nativeFetch(url, String(url).includes("/api/prompts/") ? { ...init, signal: undefined } : init);
  });
  let release;
  let entered;
  const delayed = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  await page.route("**/api/prompts/expand", async (route) => {
    entered(); await delayed;
    await route.fulfill({ json: { prompt: { id: "gen-0000000000000000", title: "Outdated generated prompt", question: "old question" } } });
  });
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Describe your own" }).click();
  await page.getByLabel("Describe the interview you want").fill("Design the first service");
  await page.getByRole("button", { name: "Generate prompt", exact: true }).click();
  await started;
  await page.getByLabel("Describe the interview you want").fill("Design a different service");
  const received = page.waitForResponse("**/api/prompts/expand");
  release(); await received;
  await page.waitForTimeout(100);
  assert.equal(await page.getByText("Outdated generated prompt").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Start interview" }).isDisabled(), true);
  await page.getByRole("button", { name: "Prompt library" }).click();
  await page.getByRole("spinbutton").fill("");
  assert.equal(await page.getByRole("button", { name: "Start interview" }).isDisabled(), true);
  await page.getByRole("spinbutton").fill("20");
  assert.equal(await page.getByRole("button", { name: "Start interview" }).isEnabled(), true);
  await page.getByRole("spinbutton").fill("121");
  assert.equal(await page.getByRole("button", { name: "Start interview" }).isDisabled(), true);
  await page.getByRole("button", { name: "30 min", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Start interview" }).isEnabled(), true);
  await page.getByRole("button", { name: "Custom (job briefing)", exact: true }).click();
  await page.getByLabel("Company", { exact: true }).fill("Example");
  await page.getByLabel("Position", { exact: true }).fill("Backend SWE");
  const previewResponse = page.waitForResponse("**/api/prompts/generate");
  await page.getByRole("button", { name: "Generate prompt", exact: true }).click();
  const preview = await (await previewResponse).json();
  assert.deepEqual(Object.keys(preview.prompt).sort(), ["id", "question", "title"]);
  await page.getByRole("button", { name: "Start interview" }).click();
  await page.waitForURL(/\/interview\/[a-f0-9]{16}$/, { timeout: 15_000 });
  const id = page.url().split("/").pop();
  assert.equal((await getSession(baseUrl, id)).mode, "custom");
  await page.close();
}

async function assertPublicPromptBoundary(baseUrl) {
  const secret = "About 100M monthly active users";
  const html = await (await fetch(baseUrl)).text();
  assert.equal(html.includes(secret), false, "server props exposed the prompt fact sheet");
  const chunks = path.join(ROOT, ".next", "static", "chunks");
  for (const file of fs.readdirSync(chunks, { recursive: true }).filter((file) => String(file).endsWith(".js"))) {
    assert.equal(fs.readFileSync(path.join(chunks, String(file)), "utf8").includes(secret), false, `client bundle exposed hidden prompt in ${file}`);
  }
}

async function main() {
  const environment = await startMockApp();
  const { dataDir, mock, appUrl, appOutput } = environment;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addInitScript(installLiveBrowserStub);
    const pageErrors = [];

    await runHappyPath(context, appUrl, mock, pageErrors);
    await runCheckpointRecovery(context, appUrl, dataDir, mock, pageErrors);
    await runFreeformPromptFlow(appUrl, mock);
    await runSaveRetry(context, appUrl, pageErrors);
    await runExpiredJobs(context, appUrl, dataDir, mock, pageErrors);
    await runSetupRevision(context, appUrl, pageErrors);
    await runStartupRetry(context, appUrl, mock, pageErrors);
    await runStaleTabAndLegacyReview(context, appUrl, dataDir, mock, pageErrors);
    await runFinalConflict(context, appUrl, pageErrors);
    await runLongRecordingClient(context, appUrl, pageErrors);
    await assertPublicPromptBoundary(appUrl);
    assert.deepEqual(pageErrors, [], `browser page errors:\n${pageErrors.join("\n")}`);

    console.log("mock E2E passed");
    console.log(
      `mock OpenAI calls: live=${mock.counts.liveCreate}, grading=${mock.counts.gradeResponses}, recordings=${mock.counts.recordingGet}`
    );
  } catch (error) {
    if (appOutput.length) console.error(`\n--- Next server output ---\n${appOutput.join("")}`);
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await environment.close();
  }
}

await main();

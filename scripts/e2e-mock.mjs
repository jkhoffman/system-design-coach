import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { installLiveBrowserStub } from "./live-browser-stub.mjs";
import { startMockOpenAI } from "./mock-openai.mjs";

const ROOT = process.cwd();
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  assert.ok(port > 0, "could not allocate an app port");
  return port;
}

async function waitFor(check, description, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError}` : ""}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited) child.kill("SIGKILL");
}

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
  assert.ok(finished.finalImage?.startsWith("data:image/png"), "final image was not persisted");
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

async function runCheckpointRecovery(context, baseUrl, mock, pageErrors) {
  const session = await createSession(baseUrl);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`checkpoint recovery: ${error}`));

  await joinMockInterview(page, baseUrl, session.id);
  await page.waitForTimeout(6_500);
  await page.reload();
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

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "interview-e2e-data-"));
  const mock = await startMockOpenAI();
  const appPort = await freePort();
  const appUrl = `http://127.0.0.1:${appPort}`;
  const appOutput = [];
  const app = spawn(
    process.execPath,
    [NEXT_BIN, "start", "--hostname", "127.0.0.1", "-p", String(appPort)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        APP_DATA_DIR: dataDir,
        OPENAI_API_KEY: "mock-key",
        OPENAI_BASE_URL: mock.baseUrl,
        GRADING_MODEL: "mock-grader",
        LIVE_MODEL: "mock-live",
        LIVE_BACKEND_MODEL: "mock-backend",
        PROMPT_GEN_MODEL: "mock-prompt-gen",
        IMAGE_PUSH_MODE: "on",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const capture = (chunk) => {
    appOutput.push(String(chunk));
    if (appOutput.join("").length > 50_000) appOutput.splice(0, appOutput.length - 20);
  };
  app.stdout.on("data", capture);
  app.stderr.on("data", capture);
  app.once("exit", (code, signal) => {
    appOutput.push(`\n[next exited code=${code} signal=${signal}]\n`);
  });

  let browser;
  try {
    await waitFor(async () => {
      if (app.exitCode !== null) {
        throw new Error(`Next server exited early\n${appOutput.join("")}`);
      }
      const response = await fetch(`${appUrl}/api/sessions`);
      return response.ok;
    }, "Next production server");

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addInitScript(installLiveBrowserStub);
    const pageErrors = [];

    await runHappyPath(context, appUrl, mock, pageErrors);
    await runCheckpointRecovery(context, appUrl, mock, pageErrors);
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
    await stopProcess(app);
    await mock.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();

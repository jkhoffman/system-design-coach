import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:3000";
const VERIFY_RETRY = process.env.SMOKE_STARTUP_RETRY === "1";
async function json(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  assert.ok(response.ok, `${response.status}: ${body.error ?? "request failed"}`);
  return body;
}
const post = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function until(check, description, timeoutMs = 195_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const { session } = await json(`${BASE}/api/sessions`, post({
  mode: "library", briefing: { company: "Synthetic smoke test", position: "SWE", level: "L5" },
  promptId: "url-shortener", durationSec: 300,
}));
console.log(`Smoke session: ${session.id}`);
const browser = await chromium.launch({ headless: true });
let owner;
let success = false;
try {
  const context = await browser.newContext();
  const pageErrors = [];
  await context.addInitScript(({ verifyRetry }) => {
    const state = window.__smoke = { started: 0, closed: 0, stopped: 0, peerClosed: 0 };
    // Synthetic audio keeps the real WebRTC transport active without using a person's microphone.
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const destination = audio.createMediaStreamDestination();
      oscillator.frequency.value = 220; gain.gain.value = 0.02;
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      for (const track of destination.stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { stop(); state.stopped++; void audio.close(); };
      }
      return destination.stream;
    };
    const createChannel = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const channel = createChannel.apply(this, args);
      channel.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "session.started") state.started++;
        if (message.type === "session.closed") state.closed++;
      });
      return channel;
    };
    const close = RTCPeerConnection.prototype.close;
    RTCPeerConnection.prototype.close = function (...args) { state.peerClosed++; return close.apply(this, args); };
    if (verifyRetry) {
      let fail = true;
      const remote = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = function (description) {
        if (fail) { fail = false; return Promise.reject(new Error("Injected startup retry check")); }
        return remote.call(this, description);
      };
    }
  }, { verifyRetry: VERIFY_RETRY });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/live/session") && response.ok()) {
      const data = await response.json().catch(() => null);
      if (data) owner = { ownerToken: data.ownerToken, generation: data.generation };
    }
  });
  await page.goto(`${BASE}/interview/${session.id}`);
  await page.getByRole("button", { name: "Join interview" }).click();
  if (VERIFY_RETRY) {
    await page.getByText("Injected startup retry check").waitFor({ timeout: 60_000 });
    assert.equal((await json(`${BASE}/api/sessions/${session.id}`)).session.status, "created");
    await page.getByRole("button", { name: "Join interview" }).click();
  }
  try {
    await page.locator("aside").filter({ hasText: "Interviewer:" }).waitFor({ timeout: 65_000 });
  } catch (error) {
    console.error("Interview UI:", (await page.locator("body").innerText()).slice(-2000));
    throw error;
  }
  console.log(`Real WebRTC connected and interviewer transcript received${VERIFY_RETRY ? " after startup retry" : ""}`);
  const canvas = page.locator("main canvas").last();
  const box = await canvas.boundingBox();
  assert.ok(box, "whiteboard canvas missing");
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 160, box.y + 140); await page.mouse.down();
  await page.mouse.move(box.x + 360, box.y + 240, { steps: 8 }); await page.mouse.up();
  await page.keyboard.press("t"); await page.mouse.click(box.x + 260, box.y + 190);
  await page.keyboard.type("URL API + SQL storage"); await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await until(async () => {
    const current = (await json(`${BASE}/api/sessions/${session.id}`)).session;
    return current.timeline.some((event) => event.kind === "snapshot");
  }, "persisted board checkpoint", 45_000);
  await page.getByRole("button", { name: "End interview" }).click();
  await page.waitForURL("**/review", { timeout: 40_000 });
  const transport = await page.evaluate(() => window.__smoke);
  const expectedAttempts = VERIFY_RETRY ? 2 : 1;
  assert.ok(transport.started >= 1, "provider did not acknowledge session start");
  assert.ok(transport.closed >= 1, "provider did not acknowledge session.close");
  assert.equal(transport.stopped, expectedAttempts, "microphone teardown did not finish for every attempt");
  assert.equal(transport.peerClosed, expectedAttempts, "peer teardown did not finish for every attempt");
  console.log("Provider acknowledged close; media resources released");
  const finished = await until(async () => {
    const state = await json(`${BASE}/api/sessions/${session.id}/status`);
    for (const kind of ["grade", "recording"]) {
      assert.notEqual(state[kind].status, "failed", `${kind}: ${state[kind].error}`);
      assert.notEqual(state[kind].status, "unavailable", `${kind} unavailable`);
    }
    return state.grade.status === "done" && state.recording.status === "done" &&
      (await json(`${BASE}/api/sessions/${session.id}`)).session;
  }, "successful grade and recording download");
  assert.ok(finished.grade && finished.transcript.length && finished.finalImageUrl);
  await page.getByRole("heading", { name: "Scorecard" }).waitFor({ timeout: 15_000 });
  await page.locator("audio").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector("audio")?.readyState >= 1);
  const audioInfo = await page.locator("audio").evaluate(async (audio) => {
    audio.muted = true;
    const seekTarget = Math.min(1, audio.duration / 2);
    audio.currentTime = seekTarget;
    await audio.play();
    return { duration: audio.duration, seekTarget, paused: audio.paused };
  });
  assert.ok(Number.isFinite(audioInfo.duration) && audioInfo.duration > 0 && !audioInfo.paused);
  await page.waitForFunction((seekTarget) => {
    const audio = document.querySelector("audio");
    return audio && !audio.seeking && audio.currentTime > seekTarget + 0.1;
  }, audioInfo.seekTarget, { timeout: 15_000 });
  await page.locator("audio").evaluate((audio) => audio.pause());
  const range = await fetch(`${BASE}/api/sessions/${session.id}/recording`, { headers: { range: "bytes=0-43" }, signal: AbortSignal.timeout(10_000) });
  assert.equal(range.status, 206);
  const header = Buffer.from(await range.arrayBuffer());
  assert.equal(header.subarray(0, 4).toString(), "RIFF"); assert.equal(header.subarray(8, 12).toString(), "WAVE");
  assert.deepEqual(pageErrors, []);
  console.log(`Live smoke passed: grade=${finished.grade.overall.signal}, turns=${finished.transcript.length}, recording=${audioInfo.duration.toFixed(1)}s, seek/playback=passed`);
  success = true;
} finally {
  await browser.close().catch(() => {});
  if (!success && owner) {
    // Failure must not leave a billable provider session running.
    await json(`${BASE}/api/sessions/${session.id}/connection`, post({ action: "cancel", ...owner }))
      .catch((error) => console.error(`Cleanup needs inspection: ${error.message}`));
  }
}

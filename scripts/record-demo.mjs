import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { startMockApp, waitFor } from "./mock-app.mjs";
import { installLiveBrowserStub } from "./live-browser-stub.mjs";
import { demoBrowserOptions, demoGrade } from "./demo-fixtures.mjs";

const exec = promisify(execFile);
const args = new Set(process.argv.slice(2));
for (const arg of args) assert.ok(["--skip-build", "--fail-after-capture"].includes(arg), `Unknown option: ${arg}`);
const artifacts = path.resolve("artifacts/demo");
const output = path.resolve("docs/demo.gif");
const pending = path.resolve("docs/.demo.pending.gif");
const viewport = { width: 1280, height: 800 };
const scenes = [];
const pageErrors = [];
let environment, browser, context, page, cleanupPromise, videoStart, captureStart;

async function run(command, argv) {
  try { return await exec(command, argv, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }); }
  catch (error) { throw new Error(`${command} failed: ${error.stderr || error.message}`, { cause: error }); }
}

async function cleanup() {
  return cleanupPromise ??= (async () => {
    try { await context?.close(); }
    finally {
      try { await browser?.close(); }
      finally {
        try { await environment?.close(); }
        finally { await fs.rm(pending, { force: true }); }
      }
    }
  })();
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => void cleanup().finally(() => process.exit(code)));
}

async function scene(name, minimumMs, action) {
  console.log(`Demo scene: ${name}`);
  const start = Date.now();
  await action();
  await page.waitForTimeout(Math.max(0, minimumMs - (Date.now() - start)));
  await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  scenes.push({ name, startSec: (start - captureStart) / 1000, endSec: (Date.now() - captureStart) / 1000 });
}

async function drawDiagram() {
  const box = await page.locator("main canvas").last().boundingBox();
  assert.ok(box, "whiteboard canvas missing");
  const y = box.y + box.height * 0.42;
  const centers = [0.36, 0.60, 0.84].map((fraction) => box.x + box.width * fraction);
  const selectTool = async (name) => {
    const control = page.getByRole("radio", { name, exact: true });
    await control.locator("..").click();
    await waitFor(() => control.isChecked(), `${name} drawing tool`, 2000);
  };
  for (const [index, label] of ["Client", "API", "Database"].entries()) {
    const x = centers[index];
    await selectTool("Rectangle");
    await page.mouse.move(x - 70, y - 40);
    await page.mouse.down();
    await page.mouse.move(x + 70, y + 40, { steps: 16 });
    await page.mouse.up();
    await selectTool("Text");
    await page.mouse.click(x, y);
    const editor = page.locator("textarea.excalidraw-wysiwyg");
    await editor.waitFor({ state: "visible" });
    await editor.pressSequentially(label, { delay: 100 });
    assert.equal(await editor.inputValue(), label);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(450);
  }
  for (let index = 0; index < centers.length - 1; index++) {
    await selectTool("Arrow");
    await page.mouse.move(centers[index] + 72, y);
    await page.mouse.down();
    await page.mouse.move(centers[index + 1] - 72, y, { steps: 18 });
    await page.mouse.up();
    await page.keyboard.press("Escape");
  }
  // Clear the Excalidraw property panel without changing the drawing.
  await page.keyboard.press("v");
  await page.mouse.click(box.x + box.width * 0.6, y + 140);
}

async function main() {
  await fs.rm(artifacts, { recursive: true, force: true });
  await fs.mkdir(artifacts, { recursive: true });
  await run("ffmpeg", ["-version"]);
  await run("ffprobe", ["-version"]);
  if (!args.has("--skip-build")) {
    console.log("Building production app with Webpack…");
    await run(process.execPath, ["node_modules/next/dist/bin/next", "build", "--webpack"]);
  }
  environment = await startMockApp({ prefix: "interview-demo-", mockOptions: { grade: demoGrade(), recordingDurationSec: 45 } });
  await fs.writeFile(path.join(artifacts, "environment.json"), JSON.stringify({ appUrl: environment.appUrl, mockUrl: environment.mock.baseUrl, dataDir: environment.dataDir }));
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", colorScheme: "dark",
    recordVideo: { dir: artifacts, size: viewport },
  });
  await context.addInitScript(installLiveBrowserStub, demoBrowserOptions);
  videoStart = Date.now();
  page = await context.newPage();
  const video = page.video();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(environment.appUrl);
  await page.getByRole("heading", { name: "Mock system design interview" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  captureStart = Date.now();

  await scene("setup", 5500, async () => {
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: /^URL Shortener/ }).click();
    await page.getByLabel("Company (flavor)", { exact: true }).fill("Demo Company");
    await page.getByLabel("Position", { exact: true }).fill("Backend engineer");
    await page.getByRole("button", { name: "30 min", exact: true }).click();
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: "Start interview →" }).click();
    await page.getByRole("button", { name: "Join interview" }).waitFor();
  });
  const id = page.url().split("/").pop();
  await scene("interview", 12_000, async () => {
    await page.getByRole("button", { name: "Join interview" }).click();
    await page.locator("aside").filter({ hasText: "Interviewer:" }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1800);
    await drawDiagram();
  });
  await scene("board-response", 5000, async () => {
    await page.locator("aside").getByText(demoBrowserOptions.boardResponse).waitFor();
    await waitFor(async () => {
      const { session } = await fetch(`${environment.appUrl}/api/sessions/${id}`).then((res) => res.json());
      return session.timeline.some((event) => event.kind === "snapshot");
    }, "persisted demo whiteboard", 20_000);
    assert.ok(await page.evaluate(() => window.__liveStub.boardImages > 0), "interviewer never received the board");
  });
  await scene("scorecard", 6000, async () => {
    await page.getByRole("button", { name: "End interview" }).click();
    await page.waitForURL("**/review");
    await page.getByRole("heading", { name: "Scorecard", exact: true }).waitFor();
    const state = await page.evaluate(() => window.__liveStub);
    assert.equal(state.closeRequests, 1);
    assert.equal(state.micTracksStopped, 1);
    assert.equal(state.peerConnectionsClosed, 1);
    const { session } = await fetch(`${environment.appUrl}/api/sessions/${id}`).then((res) => res.json());
    assert.ok(session.grade && session.finalImageUrl && session.transcript.length >= 3);
    const db = new DatabaseSync(path.join(environment.dataDir, "app.db"), { readOnly: true });
    let elements;
    try { elements = JSON.parse(db.prepare("SELECT final_scene FROM interview_sessions WHERE id = ?").get(id).final_scene); }
    finally { db.close(); }
    for (const label of ["Client", "API", "Database"]) {
      assert.ok(elements.some((element) => !element.isDeleted && element.text === label), `saved diagram is missing ${label}`);
    }
    assert.equal(elements.filter((element) => !element.isDeleted && element.type === "rectangle").length, 3);
    assert.equal(elements.filter((element) => !element.isDeleted && element.type === "arrow").length, 2);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    // Give the finished scorecard reading time even if grading/polling took longer.
    await page.waitForTimeout(4000);
  });
  await scene("replay", 6500, async () => {
    await page.getByRole("heading", { name: "Replay", exact: true }).scrollIntoViewIfNeeded();
    const replay = page.locator("section").filter({ has: page.getByRole("heading", { name: "Replay", exact: true }) });
    await replay.locator("audio").waitFor();
    await page.waitForFunction(() => document.querySelector("audio")?.readyState >= 1);
    await replay.locator("audio").evaluate((audio) => { audio.muted = true; });
    await replay.getByRole("button").filter({ hasText: demoBrowserOptions.candidateText }).click();
    await page.waitForFunction(() => document.querySelector("audio")?.currentTime > 2.5);
    await replay.getByRole("button").filter({ has: page.getByRole("img", { name: /^whiteboard at/ }) }).first().click();
    await page.waitForFunction(() => {
      const audio = document.querySelector("audio");
      return audio && !audio.paused && !audio.seeking && audio.currentTime > 5;
    });
    assert.ok(await replay.locator("img").first().evaluate((img) => img.complete && img.naturalWidth > 0));
  });
  assert.deepEqual(pageErrors, []);
  const durationSec = (Date.now() - captureStart) / 1000;
  assert.ok(durationSec <= 45, `Walkthrough exceeded 45 seconds (${durationSec.toFixed(1)}s)`);
  await context.close(); context = undefined;
  await video.saveAs(path.join(artifacts, "demo.webm"));
  await fs.rm(await video.path(), { force: true });
  if (args.has("--fail-after-capture")) throw new Error("Injected failure after capture");
  const gif = path.join(artifacts, "demo.gif");
  await run("ffmpeg", ["-y", "-v", "error", "-ss", String((captureStart - videoStart) / 1000), "-i", path.join(artifacts, "demo.webm"), "-t", String(durationSec),
    "-filter_complex", "fps=12,scale=960:600:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle", "-loop", "0", gif]);
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height:format=duration,size", "-of", "json", gif]);
  const probe = JSON.parse(stdout);
  assert.equal(probe.streams[0].width, 960);
  assert.equal(probe.streams[0].height, 600);
  assert.ok(Number(probe.format.duration) >= 30 && Number(probe.format.duration) <= 45, "GIF duration outside 30–45 seconds");
  assert.ok(Number(probe.format.size) <= 5 * 1024 * 1024, "GIF exceeds 5 MiB");
  await run("ffmpeg", ["-v", "error", "-xerror", "-i", gif, "-f", "null", "-"]);
  const metadata = { durationSec: Number(probe.format.duration), bytes: Number(probe.format.size), width: 960, height: 600, fps: 12, scenes };
  await fs.writeFile(path.join(artifacts, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  await fs.copyFile(gif, pending);
  await fs.rename(pending, output);
  console.log(`Demo ready: ${metadata.durationSec.toFixed(1)}s, ${(metadata.bytes / 1024 / 1024).toFixed(2)} MiB`);
}

try { await main(); }
catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => {});
    await fs.writeFile(path.join(artifacts, "failure-page.txt"), await page.locator("body").innerText()).catch(() => {});
  }
  else await fs.copyFile(path.join(artifacts, "replay.png"), path.join(artifacts, "failure.png")).catch(() => {});
  await fs.writeFile(path.join(artifacts, "failure.txt"), `${error.stack}\n${environment?.appOutput.join("") ?? ""}`).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally { await cleanup(); }

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startMockOpenAI } from "./mock-openai.mjs";

export async function waitFor(check, description, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError}` : ""}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address()?.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.ok(port > 0, "could not allocate an app port");
  return port;
}

async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

/** A production app and local provider with no access to the user's interview data. */
export async function startMockApp({ mockOptions, prefix = "interview-e2e-" } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const appOutput = [];
  let mock, app, closing;
  const close = () => closing ??= (async () => {
    try { await stopProcess(app); }
    finally {
      try { await mock?.close(); }
      finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
    }
  })();
  try {
    mock = await startMockOpenAI(mockOptions);
    const port = await freePort();
    const appUrl = `http://127.0.0.1:${port}`;
    let spawnError;
    app = spawn(process.execPath, [path.resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "-p", String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env, APP_DATA_DIR: dataDir, OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: mock.baseUrl,
        GRADING_MODEL: "mock-grader", LIVE_MODEL: "mock-live", LIVE_BACKEND_MODEL: "mock-backend",
        PROMPT_GEN_MODEL: "mock-prompt-gen", IMAGE_PUSH_MODE: "on", NEXT_TELEMETRY_DISABLED: "1", TZ: "UTC",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (chunk) => {
      appOutput.push(String(chunk));
      if (appOutput.join("").length > 50_000) appOutput.splice(0, appOutput.length - 20);
    };
    app.stdout.on("data", capture);
    app.stderr.on("data", capture);
    app.once("error", (error) => { spawnError = error; });
    app.once("exit", (code, signal) => capture(`\n[next exited code=${code} signal=${signal}]\n`));
    await waitFor(async () => {
      if (spawnError) throw spawnError;
      if (app.exitCode !== null || app.signalCode !== null) throw new Error(`Next exited\n${appOutput.join("")}`);
      return (await fetch(`${appUrl}/api/sessions`, { signal: AbortSignal.timeout(1000) })).ok;
    }, "Next production server");
    return { dataDir, mock, appUrl, appOutput, close };
  } catch (error) {
    await close();
    throw error;
  }
}

import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:3000";
const HEADFUL = process.env.HEADFUL === "1";
const EXPECT_IMAGE = process.env.EXPECT_IMAGE !== "0";
const SENTINEL = "K7";

function normalizeToken(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function delegatedText(events) {
  const deltaText = events
    .filter((event) => event.dir === "in" && event.innerType === "response.output_text.delta")
    .map((event) => event.innerDelta ?? "")
    .join("");
  const itemText = events
    .filter((event) => event.dir === "in" && event.innerType === "response.output_item.done")
    .map((event) => {
      try {
        const content = JSON.parse(event.innerItemContent ?? "[]");
        return (Array.isArray(content) ? content : [])
          .filter((part) => part?.type === "output_text")
          .map((part) => part.text ?? "")
          .join("");
      } catch {
        return "";
      }
    })
    .join("\n");
  return `${deltaText}\n${itemText}`.trim();
}

async function drawStroke(page, points) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(x, y, { steps: 3 });
  }
  await page.mouse.up();
}

async function waitFor(check, description, timeoutMs = 60_000) {
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

const createResponse = await fetch(`${BASE}/api/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    mode: "library",
    briefing: { company: "Google", position: "SWE", level: "L5" },
    promptId: "url-shortener",
    durationSec: 1200,
  }),
});
const createBody = await createResponse.json().catch(() => ({}));
assert.equal(createResponse.status, 200, `session create failed: ${JSON.stringify(createBody)}`);
const session = createBody.session;
assert.ok(session?.id, "session create returned no id");
console.log("session:", session.id);

const liveEvents = [];
const consoleMessages = [];
const browser = await chromium.launch({ headless: !HEADFUL });

try {
  const context = await browser.newContext();
  await context.exposeFunction("__liveNetReport", (event) => {
    liveEvents.push(event);
  });

  await context.addInitScript(() => {
    const events = [];
    window.__liveNet = { events };
    const report = (event) => {
      events.push(event);
      window.__liveNetReport?.(event);
    };

    navigator.mediaDevices.getUserMedia = async (constraints) => {
      report({ dir: "local", type: "getUserMedia", constraints, at: performance.now() });
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      oscillator.frequency.value = 220;
      const gain = audio.createGain();
      gain.gain.value = 0.02;
      const destination = audio.createMediaStreamDestination();
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      return destination.stream;
    };

    const originalCreateDataChannel = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const dc = originalCreateDataChannel.apply(this, args);
      window.__liveDataChannel = dc;
      const originalSend = dc.send.bind(dc);

      dc.send = (data) => {
        try {
          const message = JSON.parse(data);
          const content = message.item?.content;
          const imagePart = Array.isArray(content)
            ? content.find((part) => part?.type === "input_image")
            : undefined;
          report({
            dir: "out",
            type: message.type,
            itemType: message.item?.type,
            hasImage: Boolean(imagePart),
            imageBytes: imagePart?.image_url?.length ?? 0,
            content:
              typeof message.content === "string" ? message.content.slice(0, 2_000) : undefined,
            bytes: new TextEncoder().encode(data).length,
            maxMessageSize: this.sctp?.maxMessageSize ?? null,
            at: performance.now(),
          });
        } catch (error) {
          report({ dir: "out", type: "send.parse_error", error: String(error), at: performance.now() });
        }
        try {
          return originalSend(data);
        } catch (error) {
          report({ dir: "out", type: "send.error", error: String(error), at: performance.now() });
          throw error;
        }
      };

      dc.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data);
          const inner = message.event;
          report({
            dir: "in",
            type: message.type,
            innerType: inner?.type,
            innerDelta: typeof inner?.delta === "string" ? inner.delta : undefined,
            innerItemType: inner?.item?.type,
            innerItemName: inner?.item?.name,
            innerItemContent: inner?.item?.content
              ? JSON.stringify(inner.item.content).slice(0, 4_000)
              : undefined,
            delegationId: message.delegation_id,
            responseId: inner?.response_id ?? inner?.response?.id,
            reason: message.reason,
            clientEventId: message.error?.client_event_id,
            error: message.error?.message ?? message.message,
            bytes: new TextEncoder().encode(event.data).length,
            at: performance.now(),
          });
        } catch (error) {
          report({ dir: "in", type: "message.parse_error", error: String(error), at: performance.now() });
        }
      });

      return dc;
    };

    const originalPeerClose = RTCPeerConnection.prototype.close;
    RTCPeerConnection.prototype.close = function (...args) {
      report({ dir: "local", type: "peer.close", at: performance.now() });
      return originalPeerClose.apply(this, args);
    };
  });

  const page = await context.newPage();
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "warning" || message.type() === "warn" || message.type() === "error") {
      consoleMessages.push({ type: message.type(), text });
      console.log(`[console.${message.type()}]`, text.slice(0, 300));
    }
  });
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 300)));
  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/api/live/session") || (url.includes("/api/sessions") && response.status() >= 400)) {
      const body = await response.text().catch(() => "");
      console.log(`[api] ${response.status()} ${url} ${body.slice(0, 300)}`);
    }
  });

  await page.goto(`${BASE}/interview/${session.id}`);
  await page.getByText("Join interview").click();
  console.log("clicked join — waiting for interviewer speech…");

  try {
    await page
      .locator("aside")
      .filter({ hasText: "Interviewer:" })
      .first()
      .waitFor({ timeout: 60_000 });
  } catch (error) {
    const body = await page.locator("body").innerText().catch(() => "");
    await page.screenshot({ path: "/tmp/live-smoke-debug-failure.png", fullPage: true }).catch(() => {});
    console.log("page at speech timeout:", body.slice(0, 1200));
    throw error;
  }

  const canvas = page.locator("main canvas").last();
  const box = await canvas.boundingBox();
  assert.ok(box, "whiteboard canvas did not render");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.keyboard.press("r");
  await page.mouse.move(cx - 220, cy - 140);
  await page.mouse.down();
  await page.mouse.move(cx - 80, cy - 70, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("t");
  await page.mouse.click(cx - 150, cy - 105);
  await page.keyboard.type("Client");
  await page.keyboard.press("Escape");

  await page.keyboard.press("r");
  await page.mouse.move(cx + 80, cy - 140);
  await page.mouse.down();
  await page.mouse.move(cx + 220, cy - 70, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("t");
  await page.mouse.click(cx + 150, cy - 105);
  await page.keyboard.type("API");
  await page.keyboard.press("Escape");

  await page.keyboard.press("a");
  await page.mouse.move(cx - 78, cy - 105);
  await page.mouse.down();
  await page.mouse.move(cx + 78, cy - 105, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press("Escape");

  // Visual-only sentinel: freedraw strokes are summarized only as `OTHER`, not OCRed as text.
  await page.keyboard.press("p");
  await drawStroke(page, [
    [cx - 75, cy + 50],
    [cx - 75, cy + 150],
  ]);
  await drawStroke(page, [
    [cx - 75, cy + 100],
    [cx + 10, cy + 50],
  ]);
  await drawStroke(page, [
    [cx - 75, cy + 100],
    [cx + 10, cy + 150],
  ]);
  await drawStroke(page, [
    [cx + 55, cy + 50],
    [cx + 145, cy + 50],
    [cx + 85, cy + 150],
  ]);
  await page.keyboard.press("Escape");
  console.log(`drew Client -> API plus a visual-only ${SENTINEL} sentinel`);

  await page.waitForTimeout(5_000);
  const boardSummary = liveEvents.find(
    (event) =>
      event.dir === "out" &&
      event.type === "session.thinking.append" &&
      typeof event.content === "string" &&
      event.content.includes("[whiteboard state")
  );
  assert.ok(boardSummary, "board summary was not sent before the visual probe");
  assert.ok(
    !normalizeToken(boardSummary.content).includes(normalizeToken(SENTINEL)),
    "visual sentinel leaked into the text summary"
  );

  const backendProbeSent = await page.evaluate(() => {
    const dc = window.__liveDataChannel;
    if (!dc || dc.readyState !== "open") return false;
    dc.send(
      JSON.stringify({
        type: "response.item.create",
        event_id: `debug_task_${Date.now()}`,
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Use view_whiteboard. The whiteboard image contains a handwritten two-character code. Reply with only that code.",
            },
          ],
        },
      })
    );
    dc.send(
      JSON.stringify({ type: "response.create", event_id: `debug_run_${Date.now()}` })
    );
    return true;
  });
  assert.ok(backendProbeSent, "live data channel was not open for the backend probe");

  try {
    await page.waitForFunction(
      (expectImage) => {
        const sent = window.__liveNet?.events?.filter((event) => event.dir === "out") ?? [];
        const resultIndex = sent.findIndex((event) => event.itemType === "function_call_output");
        const imageIndex = expectImage
          ? sent.findIndex((event, index) => index > resultIndex && event.hasImage)
          : resultIndex;
        const runIndex = sent.findIndex(
          (event, index) => index > imageIndex && event.type === "response.create"
        );
        const completed = window.__liveNet?.events?.some(
          (event) => event.dir === "in" && event.innerType === "response.completed"
        );
        return resultIndex >= 0 && imageIndex >= resultIndex && runIndex > imageIndex && completed;
      },
      EXPECT_IMAGE,
      { timeout: 45_000 }
    );
  } catch (error) {
    const transcript = await page.locator("aside").innerText().catch(() => "");
    console.log("transcript at protocol timeout:", transcript.slice(-1200));
    console.log("live events at protocol timeout:", JSON.stringify(liveEvents.slice(-100), null, 2));
    throw error;
  }
  console.log(
    EXPECT_IMAGE
      ? "observed tool result → image queue → backend run → response.completed"
      : "observed tool result → backend run → response.completed"
  );

  const secondProbeStart = liveEvents.length;
  const followupPrompt = EXPECT_IMAGE
    ? "Do not call tools. The whiteboard image already provided contains a handwritten two-character code. Reply with only that code."
    : "Do not call tools. Reply with only the word NO_IMAGE.";
  const followupSent = await page.evaluate((prompt) => {
    const dc = window.__liveDataChannel;
    if (!dc || dc.readyState !== "open") return false;
    dc.send(
      JSON.stringify({
        type: "response.item.create",
        event_id: `debug_followup_${Date.now()}`,
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      })
    );
    dc.send(
      JSON.stringify({ type: "response.create", event_id: `debug_followup_run_${Date.now()}` })
    );
    return true;
  }, followupPrompt);
  assert.ok(followupSent, "live data channel was not open for the follow-up image probe");

  try {
    await page.waitForFunction(
      (start) =>
        window.__liveNet?.events
          ?.slice(start)
          .some((event) => event.dir === "in" && event.innerType === "response.completed"),
      secondProbeStart,
      { timeout: 45_000 }
    );
  } catch (error) {
    console.log("live events at follow-up timeout:", JSON.stringify(liveEvents.slice(secondProbeStart), null, 2));
    throw error;
  }

  const backendOutput = delegatedText(liveEvents.slice(secondProbeStart));
  const expectedOutput = EXPECT_IMAGE ? SENTINEL : "NO_IMAGE";
  console.log("delegated backend output:", backendOutput || "(none)");
  if (!normalizeToken(backendOutput).includes(normalizeToken(expectedOutput))) {
    await page.screenshot({ path: "/tmp/live-smoke-debug-board.png", fullPage: true }).catch(() => {});
    console.log("transcript at image assertion:", await page.locator("aside").innerText().catch(() => ""));
    console.log("live events at image assertion:", JSON.stringify(liveEvents.slice(secondProbeStart), null, 2));
  }
  assert.ok(
    normalizeToken(backendOutput).includes(normalizeToken(expectedOutput)),
    `delegated backend did not report expected output ${expectedOutput}`
  );

  const transcript = await page.locator("aside").innerText();
  console.log("transcript after visual probe:", transcript.slice(-1200));

  await page.getByText("End interview").click();
  await page.waitForURL("**/review", { timeout: 30_000 });

  await waitFor(
    () => liveEvents.some((event) => event.dir === "local" && event.type === "peer.close"),
    "peer connection teardown",
    30_000
  );

  const sent = liveEvents.filter((event) => event.dir === "out");
  const received = liveEvents.filter((event) => event.dir === "in");
  const toolResultIndex = sent.findIndex((event) => event.itemType === "function_call_output");
  const imageIndex = EXPECT_IMAGE
    ? sent.findIndex((event, index) => index > toolResultIndex && event.hasImage)
    : -1;
  const backendRunIndex = sent.findIndex(
    (event, index) => index > Math.max(toolResultIndex, imageIndex) && event.type === "response.create"
  );
  const responseCompletedIndex = received.findIndex(
    (event) => event.innerType === "response.completed"
  );
  const closeIndex = sent.findIndex((event) => event.type === "session.close");
  const sessionClosedIndex = liveEvents.findIndex(
    (event) => event.dir === "in" && event.type === "session.closed"
  );
  const peerCloseIndex = liveEvents.findIndex(
    (event) => event.dir === "local" && event.type === "peer.close"
  );

  assert.ok(toolResultIndex >= 0, "view_whiteboard tool result was not sent");
  if (EXPECT_IMAGE) {
    assert.ok(imageIndex > toolResultIndex, "board image did not follow the tool result");
  }
  assert.ok(backendRunIndex > Math.max(toolResultIndex, imageIndex), "backend run did not follow the queued items");
  assert.ok(responseCompletedIndex >= 0, "response.completed was not received");
  assert.ok(closeIndex >= 0, "session.close was not sent");
  assert.ok(sessionClosedIndex >= 0, "session.closed was not received");
  assert.ok(peerCloseIndex > sessionClosedIndex, "peer connection closed before session.closed");
  assert.ok(
    sent.every(
      (event) =>
        !event.maxMessageSize || event.bytes <= event.maxMessageSize
    ),
    "an outgoing message exceeded the negotiated data-channel limit"
  );
  assert.ok(
    !consoleMessages.some((message) => /dropped|oversized/i.test(message.text)),
    `live transport reported a dropped message: ${JSON.stringify(consoleMessages)}`
  );

  const imageEvent = imageIndex >= 0 ? sent[imageIndex] : null;
  const closeEvent = sent[closeIndex];
  const closedEvent = liveEvents[sessionClosedIndex];
  if (imageEvent) {
    console.log(
      "image bytes=%d message bytes=%d max=%s",
      imageEvent.imageBytes,
      imageEvent.bytes,
      imageEvent.maxMessageSize ?? "unknown"
    );
  }
  console.log(
    "close acknowledged in %d ms",
    Math.max(0, Math.round(closedEvent.at - closeEvent.at))
  );

  const finished = await waitFor(async () => {
    const response = await fetch(`${BASE}/api/sessions/${session.id}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`session fetch failed: ${response.status}`);
    return body.session?.recordingStatus === "done" &&
      ["done", "failed"].includes(body.session?.gradeStatus)
      ? body.session
      : null;
  }, "recording download and terminal grade status", 120_000);

  console.log(
    "final: status=%s gradeStatus=%s recordingStatus=%s signal=%s",
    finished.status,
    finished.gradeStatus,
    finished.recordingStatus,
    finished.grade?.overall?.signal ?? "none"
  );
  console.log("live debug smoke passed");
} finally {
  await browser.close().catch(() => {});
}

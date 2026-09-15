import { chromium } from "playwright";

const BASE = "http://localhost:3000";

const res = await fetch(`${BASE}/api/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    mode: "library",
    briefing: { company: "Google", position: "SWE", level: "L5" },
    promptId: "url-shortener",
    durationSec: 1200,
  }),
});
const { session } = await res.json();
console.log("session:", session.id);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
// Fake mic: quiet oscillator so the model hears a live input track.
await ctx.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = async () => {
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    osc.frequency.value = 220;
    const gain = ac.createGain();
    gain.gain.value = 0.02;
    const dest = ac.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    return dest.stream;
  };
});
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 250));
});
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
page.on("response", async (r) => {
  if (r.url().includes("/api/live/session"))
    console.log("live/session ->", r.status(), (await r.text()).slice(0, 300));
});

await page.goto(`${BASE}/interview/${session.id}`);
await page.getByText("Join interview").click();
console.log("clicked join — waiting for interviewer speech…");

// poll transcript until interviewer speaks or timeout
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(3000);
  const t = await page.locator("aside").innerText();
  if (/Interviewer:/.test(t)) {
    console.log(`interviewer speaking at ~${(i + 1) * 3}s:`);
    console.log(t.slice(0, 500));
    break;
  }
  if (i === 14) console.log("NO INTERVIEWER SPEECH after 45s. panel:", t.slice(0, 300));
}

// draw: rect + label + second rect + arrow
const box = await page.locator("main canvas").last().boundingBox();
if (box) {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.keyboard.press("r");
  await page.mouse.move(cx - 220, cy - 120);
  await page.mouse.down();
  await page.mouse.move(cx - 80, cy - 60, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("t");
  await page.mouse.click(cx - 150, cy - 90);
  await page.keyboard.type("Client");
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  await page.mouse.move(cx + 80, cy - 120);
  await page.mouse.down();
  await page.mouse.move(cx + 220, cy - 60, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("t");
  await page.mouse.click(cx + 150, cy - 90);
  await page.keyboard.type("API");
  await page.keyboard.press("Escape");
  await page.keyboard.press("a");
  await page.mouse.move(cx - 78, cy - 90);
  await page.mouse.down();
  await page.mouse.move(cx + 78, cy - 90, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
  console.log("drew Client -> API");
} else console.log("no canvas box found");

await page.waitForTimeout(14000); // let drawing pause fire + interviewer react
const t2 = await page.locator("aside").innerText();
console.log("transcript after drawing:", t2.slice(0, 800));
await page.screenshot({ path: "/tmp/interview_room.png" });

await page.getByText("End interview").click();
await page.waitForURL("**/review", { timeout: 20000 });
await page.waitForTimeout(4000);

const done = await fetch(`${BASE}/api/sessions/${session.id}`).then((r) => r.json());
console.log(
  "final: status=%s turns=%d timeline=%d grade=%s recording=%s",
  done.session.status,
  done.session.transcript.length,
  done.session.timeline.length,
  Boolean(done.session.grade),
  done.session.recordingPath ?? "none"
);
if (done.session.grade)
  console.log("signal:", done.session.grade.overall.signal, "score:", done.session.grade.overall.score);
await page.screenshot({ path: "/tmp/review.png", fullPage: true });
await browser.close();

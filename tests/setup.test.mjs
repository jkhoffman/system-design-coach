import test from "node:test";
import assert from "node:assert/strict";
import { LatestRequest } from "../src/lib/latestRequest.ts";
import { durationSeconds } from "../src/lib/duration.ts";
import { databaseFixture, deferred, sessionInput } from "./helpers.mjs";

test("input changes invalidate a late generation response even if fetch ignores abort", async () => {
  const requests = new LatestRequest();
  const old = requests.begin();
  const response = deferred();
  let installed = null;
  const pending = response.promise.then((value) => { if (old.isCurrent()) installed = value; });
  requests.invalidate();
  const current = requests.begin();
  response.resolve("stale prompt");
  await pending;
  assert.equal(installed, null);
  assert.equal(old.signal.aborted, true);
  assert.equal(current.isCurrent(), true);
  requests.invalidate();
  assert.equal(current.isCurrent(), false);
});

test("duration selection never retains a preset when custom text becomes invalid", () => {
  assert.equal(durationSeconds({ kind: "preset", seconds: 1200 }), 1200);
  for (const minutes of ["", "4", "121", "5.5", "invalid"]) {
    assert.equal(durationSeconds({ kind: "custom", minutes }), null);
  }
  for (const minutes of ["5", "20", "120"]) assert.equal(durationSeconds({ kind: "custom", minutes }), Number(minutes) * 60);
  assert.equal(durationSeconds({ kind: "preset", seconds: 2700 }), 2700);
});

const { db } = await databaseFixture();
test("generated specifications stay on the server and creation resolves only saved references", async () => {
  const { saveGeneratedPrompt, getGeneratedPrompt } = await import("../src/lib/generatedPrompts.ts");
  const { POST } = await import("../src/app/api/sessions/route.ts");
  const prompt = { ...sessionInput.prompt, id: "gen-1234567890abcdef" };
  const preview = saveGeneratedPrompt(prompt);
  assert.deepEqual(Object.keys(preview).sort(), ["id", "question", "title"]);
  db.closeDb();
  assert.deepEqual(getGeneratedPrompt(prompt.id), prompt);
  const create = (extra) => POST(new Request("http://localhost/api/sessions", { method: "POST", body: JSON.stringify({
    mode: "freeform", briefing: sessionInput.briefing, durationSec: 300, ...extra,
  }) }));
  assert.equal((await create({ prompt })).status, 400);
  assert.equal((await create({ promptId: "gen-0000000000000000" })).status, 400);
  const response = await create({ promptId: prompt.id, prompt: { ...prompt, factSheet: [] } });
  assert.equal(response.status, 200);
  const { session } = await response.json();
  assert.deepEqual(session.prompt, preview);
  assert.deepEqual(db.getSession(session.id).prompt, prompt);
});

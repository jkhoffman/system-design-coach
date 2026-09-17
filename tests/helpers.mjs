import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function fakeClock(t, initial = 1_800_000_000_000) {
  let now = initial;
  t.mock.method(Date, "now", () => now);
  return { now: () => now, advance: (ms) => { now += ms; } };
}

export async function databaseFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "interview-test-"));
  process.env.APP_DATA_DIR = directory;
  const db = await import("../src/lib/db.ts");
  after(async () => {
    if (db.closeDb) db.closeDb();
    else {
      globalThis.__appdb?.close();
      delete globalThis.__appdb;
      delete globalThis.__appdbSchemaVersion;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, directory };
}

export const sessionInput = {
  mode: "library",
  briefing: { company: "Example", position: "SWE", level: "L5" },
  prompt: { id: "test", title: "Test interview", question: "Design a service", context: "", factSheet: [{ q: "Scale?", a: "100 QPS" }], deepDiveAngles: ["Storage"] },
  durationSec: 300,
};

const owners = new Map();
export function activateSession(commands, id, liveId = "live_test", storageAllowed = true) {
  const token = commands.reserveSessionStart(id);
  if (!commands.completeSessionStart(id, token, liveId, storageAllowed)) throw new Error("Attempt did not prepare");
  const owner = commands.attemptOwner(id, token);
  if (!commands.confirmSessionStart(id, owner)) throw new Error("Attempt did not confirm");
  owners.set(id, owner);
  return owner;
}
export function ownerFor(id) { return owners.get(id); }
export function finishFields(id) { return { ...ownerFor(id), requestId: crypto.randomUUID() }; }
export const sampleOwner = { ownerToken: "12345678-1234-4234-8234-123456789abc", generation: 1 };

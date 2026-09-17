import assert from "node:assert/strict";
import { test } from "node:test";
import { watchJob } from "../src/lib/pollJob.ts";
import { deferred } from "./helpers.mjs";
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("poller recovers stale work, serializes requests, then stops at completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const work = deferred();
  let loads = 0, starts = 0, done = 0;
  const stop = watchJob({
    load: async () => (++loads === 1 ? { status: "running", stale: true } : { status: "done", stale: false }),
    start: async () => { starts++; await work.promise; },
    onState() {}, onError: assert.fail, onDone: () => { done++; }, pollMs: 10,
  });
  t.after(stop);
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(loads, 1);
  assert.equal(starts, 1);
  work.resolve();
  await flush();
  t.mock.timers.tick(10);
  await flush();
  assert.equal(done, 1);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(loads, 2);
});

test("poller aborts an in-flight request and never schedules work after disposal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  let signal, updates = 0;
  const stop = watchJob({
    load: async (s) => { signal = s; return pending.promise; },
    start: async () => assert.fail("started after cancellation"),
    onState: () => { updates++; }, onError: assert.fail, onDone: assert.fail,
  });
  stop();
  assert.equal(signal.aborted, true);
  pending.resolve({ status: "done", stale: false });
  await flush();
  t.mock.timers.tick(100_000);
  assert.equal(updates, 0);
});

test("failed jobs require explicit retry; unavailable jobs never start", async () => {
  for (const status of ["failed", "unavailable"]) {
    let starts = 0, errors = 0;
    const stop = watchJob({ load: async () => ({ status, stale: false }), start: async () => { starts++; }, onState() {}, onError: () => { errors++; } });
    await flush(); stop();
    assert.equal(starts, 0);
    assert.equal(errors, status === "failed" ? 1 : 0);
  }
  let starts = 0;
  const stop = watchJob({ load: async () => ({ status: "failed", stale: false }), start: async () => { starts++; }, onState() {}, onError: assert.fail, retryFailed: true });
  await flush(); stop();
  assert.equal(starts, 1);
});

test("network failures and prolonged running jobs have bounded polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let loads = 0, errors = 0;
  const stop = watchJob({ load: async () => { loads++; throw new Error("offline"); }, start: async () => assert.fail(), onState() {}, onError: () => { errors++; }, pollMs: 10 });
  t.after(stop);
  for (let i = 0; i < 5; i++) { await flush(); t.mock.timers.tick(100); }
  assert.equal(loads, 3);
  assert.equal(errors, 1);
  let polls = 0;
  const stopRunning = watchJob({ load: async () => { polls++; return { status: "running", stale: false }; }, start: async () => assert.fail(), onState() {}, onError: () => { errors++; }, pollMs: 10, maxPolls: 2 });
  t.after(stopRunning);
  for (let i = 0; i < 4; i++) { await flush(); t.mock.timers.tick(100); }
  assert.equal(polls, 2);
  assert.equal(errors, 2);
});

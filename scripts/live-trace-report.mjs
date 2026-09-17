import "./register-source.mjs";
import fs from "node:fs";
import path from "node:path";

const { analyzeLiveTrace } = await import("../src/lib/liveTraceAnalysis.ts");

function formatMs(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function usage() {
  console.error("usage: node scripts/live-trace-report.mjs <session-id|trace.json>");
  process.exit(2);
}

const target = process.argv[2];
if (!target) usage();

let session = null;
let events = null;

if (target.endsWith(".json") || fs.existsSync(target)) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(target), "utf8"));
  events = Array.isArray(parsed) ? parsed : parsed.liveTrace;
} else {
  const { getSessionDiagnostics } = await import("../src/lib/sessionQueries.ts");
  const { getSessionJobStatus } = await import("../src/lib/sessionJobs.ts");
  const diagnostics = getSessionDiagnostics(target);
  const jobs = getSessionJobStatus(target);
  session = diagnostics ? { ...diagnostics.session, gradeStatus: jobs?.grade.status, recordingStatus: jobs?.recording.status } : null;
  if (!session) {
    console.error(`session not found: ${target}`);
    process.exit(1);
  }
  events = diagnostics.trace;
  const { closeDb } = await import("../src/lib/database.ts");
  closeDb();
}

if (!Array.isArray(events)) {
  console.error("no live trace events found");
  process.exit(1);
}

const { sanitizeTrace } = await import("../src/lib/traceContracts.ts");
const report = analyzeLiveTrace(sanitizeTrace(events) ?? []);

if (session) {
  console.log(`session: ${session.id}`);
  console.log(`status: ${session.status}  grade: ${session.gradeStatus}  recording: ${session.recordingStatus}`);
  console.log(`live session: ${session.liveSessionId ?? "none"}`);
  console.log(`transcript turns: ${session.transcriptTurns}  timeline events: ${session.timelineEvents}`);
}
console.log(`trace events: ${report.eventCount} (${report.counts.in} in / ${report.counts.out} out / ${report.counts.local} local)`);
console.log(`trace duration: ${formatMs(report.durationMs)}`);

console.log("\nstages:");
for (const stage of report.stages) {
  if (stage.status === "ok") {
    console.log(`  ${stage.name}: ${formatMs(stage.durationMs)} (${formatMs(stage.startMs)} → ${formatMs(stage.endMs)})`);
  } else {
    console.log(`  ${stage.name}: missing`);
  }
}

console.log("\ncontext append acknowledgments:");
if (!report.appendLatencies.length) console.log("  none observed");
for (const latency of report.appendLatencies) {
  console.log(`  ${latency.type}: ${formatMs(latency.durationMs)}${latency.clientEventId ? ` (${latency.clientEventId})` : ""}`);
}

console.log("\ninterviewer response gaps:");
if (!report.turnGaps.length) console.log("  none above threshold");
for (const gap of report.turnGaps.slice(0, 10)) {
  console.log(`  ${formatMs(gap.durationMs)} at ${formatMs(gap.startMs)} → ${formatMs(gap.endMs)}`);
}

console.log("\nlargest trace gaps:");
if (!report.gaps.length) console.log("  none above threshold");
for (const gap of report.gaps.slice(0, 15)) {
  console.log(
    `  ${formatMs(gap.durationMs)} ${gap.classification} at ${formatMs(gap.startMs)} → ${formatMs(gap.endMs)}: ${gap.description}`
  );
}

console.log("\nmissing signals:");
console.log(report.missingSignals.length ? `  ${report.missingSignals.join(", ")}` : "  none");

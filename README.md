# System Design Coach

A voice-driven mock system design interview app. You draw on an Excalidraw
whiteboard while a GPT-Live-1 interviewer runs the session — delivers the
prompt, answers clarifying questions from a hidden fact sheet, probes your
design, and wraps on time. Afterwards you get a timestamped scorecard graded
against a FAANG-style rubric, the call recording, and a replayable transcript +
board timeline.

## Demo

![Mock system design interview demo](docs/demo.gif)

This walkthrough uses simulated interview responses and grading. It is refreshed
automatically in a reviewable pull request after relevant changes reach `main`.
To record it locally, install Playwright Chromium and FFmpeg, then run
`npm run demo:record`. See [Recording the demo](docs/demo-recording.md) for setup,
the walkthrough scenes, and failure diagnostics.

## How it works

- **Voice**: `gpt-live-1` over WebRTC. The browser sends an SDP offer to
  `POST /api/live/session`, which attaches the interviewer persona + fact sheet
  and forwards to `POST /v1/live/sessions` — the API key never leaves the server.
- **Interviewer brain**: the fact sheet lives in the live model's instructions
  (clarifying questions get instant answers). Deeper reasoning is delegated to a
  Responses model (`delegation.type: "responses"`) with a `view_whiteboard` tool
  and low reasoning effort for low-latency probes.
- **Whiteboard awareness**: on each drawing pause (~4s), a compact structural
  summary (labeled shapes + arrow bindings) is pushed silently via
  `session.thinking.append`. Capped PNG milestone snapshots are retained for
  grading; a JPEG capped at 1600 px is sent to the delegated backend only when
  its `view_whiteboard` tool requests a fresh look.
- **Timeline**: transcript fragments (`session.input/output_transcript.delta`)
  are grouped into turns and merged with board summaries, phase markers, and
  snapshot references on the session's ms timeline. Every five active minutes, a
  silent `[interview clock] elapsed MM:SS of MM:SS` context update is appended so
  the interviewer can pace the conversation without guessing elapsed time.
- **Recording**: sessions are created with `store: true`; the stereo WAV
  (candidate left / interviewer right) is downloaded after the interview and
  served on the review page.
- **Grading**: a vision-capable Responses model gets the rubric, the transcript,
  the board timeline, and milestone PNGs, and returns a structured scorecard
  including a mechanical trade-off audit (every architectural choice → was an
  alternative + reason stated?).

## Setup

Use Node.js **22.18 or newer**. The app uses Node's built-in SQLite module;
tests and maintenance scripts also use its module registration hooks. No separate
database server is required.

```bash
npm install
# create .env with:
#   OPENAI_API_KEY=sk-...        (project needs GPT-Live access + session storage enabled)
#   LIVE_MODEL=gpt-live-1        (optional)
#   LIVE_BACKEND_MODEL=gpt-5.6-terra
#   GRADING_MODEL=gpt-5.6-terra
#   PROMPT_GEN_MODEL=gpt-5.6-terra
#   IMAGE_PUSH_MODE=on           (on | off)
#   OPENAI_BASE_URL=https://api.openai.com/v1  (optional API/mock override)
npm run dev
```

Open http://localhost:3000 — pick a library prompt, generate one from a
company/role briefing, or describe the interview you want in your own words
(it gets expanded into a full prompt spec), then join with mic + speaker.

## Testing

```bash
npm run lint            # ESLint, including React lifecycle rules
npm run typecheck       # generate Next route types, then check TypeScript
npm test                # named deterministic Node test suites
npm run check:pure      # alias for the same deterministic suites
npm run test:e2e:mock   # no-cost browser E2E against a local OpenAI mock
npm run smoke:live      # real GPT-Live smoke test (paid/stateful)
npm run smoke:live:debug # instrumented GPT-Live protocol probe (paid/stateful)
```

The mocked E2E builds the app with Webpack, starts a temporary production server
and local OpenAI-compatible server, stubs the browser's WebRTC/microphone APIs with
Playwright, and uses a temporary SQLite directory. It does not call OpenAI or read
your saved interviews. It needs permission to spawn processes and bind local
ports, plus a Playwright Chromium installation (`npx playwright install chromium`
if it is missing). Webpack avoids Turbopack's subprocess port-binding restriction
in constrained environments.

Browser coverage includes completed interviews, checkpoint recovery, freeform and
briefing generation, failed board uploads and final-save retries, expired jobs
with concurrent review tabs, stale generation responses, duration selection, and
hidden prompt content. Deterministic suites cover migrations, atomic writes,
job leases, transport cancellation, schema validation, diagnostics, stream limits,
media publication, pacing, timeline ordering, and scene summaries. Each database
fixture and browser run closes its connections and removes its temporary data.

The live smoke requires a running app server configured with an OpenAI key. It uses
synthetic microphone input, waits for interviewer speech, saves a board checkpoint,
ends the interview, and asserts provider close, media teardown, grading, and recording
seek/playback. It creates a saved interview in that server's data directory; use an
isolated `APP_DATA_DIR` when starting the server to keep test data separate.

```bash
APP_URL=http://127.0.0.1:3000 SMOKE_STARTUP_RETRY=1 npm run smoke:live
```

`APP_URL` defaults to `http://127.0.0.1:3000`. `SMOKE_STARTUP_RETRY=1` additionally
fails the first browser SDP application and verifies Join succeeds on retry; this
creates a second billable provider session. The script fails on missing speech,
failed jobs, or unusable audio, and attempts provider cleanup after failure.

The live debug smoke also uses the real API. It records data-channel message order and byte sizes, verifies `response.completed` and `session.closed` arrive before teardown, draws a visual-only code, asserts the delegated backend reads that code from the image, and polls recording/grading to completion.

## Live diagnostics

Every GPT-Live transport keeps a bounded, redacted diagnostic trace while the
interview is running. Checkpoints and the final save persist the trace with the
session so stalls can be analyzed after the fact. The trace records event
direction/type, monotonic timestamps, response/delegation/tool IDs, byte counts,
and short text previews; it does not store raw audio, image payloads, SDP, or
OpenAI credentials. `src/lib/traceContracts.ts` defines the shared event and field
limits; unknown fields and malformed records are discarded at production and
ingestion. Invalid diagnostic data does not reject valid transcript/timeline
content. There are currently no tracing environment switches.

Analyze a saved session without an OpenAI key:

```bash
npm run trace:report -- <session-id>
# or analyze an exported/pasted trace JSON file:
npm run trace:report -- path/to/trace.json
```

The running app also exposes the same summary:

```text
GET /api/sessions/<session-id>/diagnostics
```

The report separates candidate turn-taking, delegation queueing, tool execution,
tool-result continuation, backend response completion, context-append
acknowledgment, and speech-output gaps. Missing signals are reported rather than
assumed to be the cause. This instrumentation is diagnostic-only; it does not
change prompts, models, timing, or retry behavior.

## Persistence and recovery

`APP_DATA_DIR` selects the storage directory (default: `data/`). It contains
`app.db`, `snapshots/`, and `recordings/`. Ordered transactional migrations use
SQLite's `user_version` and adopt existing databases automatically. Back up the
whole directory together. New media references are relative to that root; validated
legacy absolute filenames are resolved under the current root after relocation.

Session creation reserves a connection attempt before contacting the model. The
browser confirms SDP application and `session.started` before the interview becomes
live. A failed startup retires that attempt and hangs up its known provider session;
it can then retry the same interview. Failed provider cleanup is retained and retried
on server startup and before joining again.

A private owner token and generation fence checkpoints, snapshots, heartbeats, and
final saves. Ownership renews every 20 seconds with a three-minute lease, independently
of transcript changes. **Review saved progress** waits for the active lease to expire
and finalizes the latest checkpoint inside a database transaction. It cannot overwrite
a healthy tab's interview. Final saves use an immutable request identity: an identical
retry succeeds; a conflicting finish remains visible with **Export local work**.
Failed save/preparation actions retain the captured work and expose separate retries;
the microphone has already stopped.

An upstream create with no returned session ID has an **unknown outcome**, including
when the process exits during the request. Time passing cannot prove the provider
session was closed. Inspect these attempts locally with:

```bash
node scripts/reconcile-connections.mjs --list
# Retry known provider IDs (requires OPENAI_API_KEY):
node scripts/reconcile-connections.mjs --retry
# After locating the session in provider records, attach its ID and hang it up:
node scripts/reconcile-connections.mjs --attempt GENERATION --upstream-id PROVIDER_ID
# Only after verifying no upstream session remains:
node scripts/reconcile-connections.mjs --attempt GENERATION --confirm-no-upstream
```

Use the same `APP_DATA_DIR` as the app. No automatic provider lookup or idempotency
support is assumed for an unknown identifier.

The review page owns grading and recording requests. Both jobs renew a 75-second
lease every 20 seconds; an old worker cannot publish after ownership changes. Grading
has a three-minute total budget, including image preparation and up to two SDK retries
for transient API failures. Recording has a 30-minute total budget, 30-second response
header timeout, and 60-second transfer idle timeout. `RECORDING_BUDGET_MS` can lower
the total recording budget (1 second to 30 minutes). Advancing streams retain their
lease; interrupted transfers retry into a clean temporary file, up to four attempts.
The client request and polling limits accommodate these budgets.

Route `maxDuration` exports are deployment hints. Run this configuration on a server
that permits requests lasting at least 1,830 seconds. Platforms with shorter hard
limits require a durable worker implementation before using long recording transfers;
work must not be detached after sending a response.

Recordings stream to an attempt-specific `.part` file. Only a complete WAV owned by
the current attempt is published. Audio endpoints support byte ranges. Ready recordings
render immediately without status polling. GET/status requests never erase missing
artifact references; a replacement download requires explicit retry. Final board
images are served by URL, with fallback to older inline images. Session/status responses
exclude image bytes, traces, board scene JSON, and connection ownership tokens.

Historical reports preserve long evidence text and render unusable timestamps without
an evidence time. A malformed saved report exposes an explicit regrade action and
retains the original until replacement grading succeeds. New reports still use the
strict canonical write contract.

Library and generated prompt specifications stay on the server. Setup receives
only IDs, titles, and questions; generated specifications are saved in SQLite and
resolved by ID at session creation. Editing inputs cancels and invalidates pending
generation. Runtime contracts live in `schemas.ts` and `traceContracts.ts`; model
formats are derived with the SDK's Zod helper, stripping defaults and schema metadata
while preserving local validators and SDK parser helpers, following the
[Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs).

Live schema acceptance is separate from mock validation. To make two billable requests
using synthetic inputs and the configured `PROMPT_GEN_MODEL` and `GRADING_MODEL`:

```bash
node --env-file=.env scripts/probe-model-schemas.mjs --live
```

Without `--live`, the script makes no requests. The mock validates the serialized strict
schema profile but cannot establish provider acceptance. Omit `--env-file=.env` when
the key and model settings are already exported in your shell.

## Code organization

- `database.ts` / `migrations.ts`: connection ownership and schema upgrades.
- `db.ts`, `sessionQueries.ts`, `sessionCommands.ts`: repository reads and guarded writes.
- `sessionJobs.ts` / `pollJob.ts`: job ownership and client polling.
- `useInterviewController.ts` / `liveSession.ts`: UI lifecycle and transport resources.
- `artifacts.ts`: image validation, recording publication, and media serving.
- `usePromptGeneration.ts`: setup request ownership and cancellation.

The implementation sequence and acceptance criteria are recorded in
[the refactoring plan](docs/refactoring-plan.md) and
[review remediation plan](docs/review-remediation-plan.md).

## Notes

- Cost: ~$0.05/min for the voice layer (~$2.25 for 45 min) + backend/grading tokens.
- SQLite lives at `data/app.db`; snapshots and recordings under `data/`.
- Recordings require session storage enabled on the OpenAI project and expire in 30 days.
- 60-minute sessions are marked experimental — the Live duration cap is unverified
  (the old Realtime cap was 60 min); an `expired` close auto-ends and grades the session.

## License

MIT — see [LICENSE](LICENSE).

# System Design Coach

A voice-driven mock system design interview app. You draw on an Excalidraw
whiteboard while a GPT-Live-1 interviewer runs the session — delivers the
prompt, answers clarifying questions from a hidden fact sheet, probes your
design, and wraps on time. Afterwards you get a timestamped scorecard graded
against a FAANG-style rubric, the call recording, and a replayable transcript +
board timeline.

## Demo

![Mock system design interview demo](docs/demo.gif)

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

The live debug smoke uses the real API. It records data-channel message order and byte sizes, verifies `response.completed` and `session.closed` arrive before teardown, draws a visual-only code, asserts the delegated backend reads that code from the image, and polls recording/grading to completion.

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
whole directory together; paths and media references belong to that installation.

Session creation reserves a connection attempt before contacting the model.
Progress checkpoints carry increasing revisions, and the first accepted finish
freezes interview content. Delayed checkpoints and repeated finish requests cannot
replace finalized content. Reloading a live interview offers **Review saved
progress**. A failed final save leaves the captured payload in the current page
for **Retry save**; the microphone is already stopped.

The review page owns grading and recording requests. Each job has an attempt
token and an expiry; an interrupted attempt can be reclaimed, while its late
response cannot overwrite a newer result. Grading has a 110-second operation
deadline and a 150-second lease; recording has a 45-second deadline and a
75-second lease. Failed jobs require an explicit retry. Polling is cancellable,
bounded, and uses the small `/api/sessions/<id>/status` response.

Recordings stream to an attempt-specific `.part` file. Only a completed download
owned by the current attempt is published. Audio endpoints support byte ranges.
Final board images are served by URL; older inline images remain readable.
Session/status responses exclude image bytes, traces, and board scene JSON.

Library and generated prompt specifications stay on the server. Setup receives
only IDs, titles, and questions; generated specifications are saved in SQLite and
resolved by ID at session creation. Editing inputs cancels and invalidates pending
generation. Runtime contracts live in `schemas.ts` and `traceContracts.ts`; model
formats are derived with the SDK's Zod helper, following the
[Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs).

## Code organization

- `database.ts` / `migrations.ts`: connection ownership and schema upgrades.
- `db.ts`, `sessionQueries.ts`, `sessionCommands.ts`: repository reads and guarded writes.
- `sessionJobs.ts` / `pollJob.ts`: job ownership and client polling.
- `useInterviewController.ts` / `liveSession.ts`: UI lifecycle and transport resources.
- `artifacts.ts`: image validation, recording publication, and media serving.
- `usePromptGeneration.ts`: setup request ownership and cancellation.

The implementation sequence and acceptance criteria are recorded in
[the refactoring plan](docs/refactoring-plan.md).

## Notes

- Cost: ~$0.05/min for the voice layer (~$2.25 for 45 min) + backend/grading tokens.
- SQLite lives at `data/app.db`; snapshots and recordings under `data/`.
- Recordings require session storage enabled on the OpenAI project and expire in 30 days.
- 60-minute sessions are marked experimental — the Live duration cap is unverified
  (the old Realtime cap was 60 min); an `expired` close auto-ends and grades the session.

## License

MIT — see [LICENSE](LICENSE).

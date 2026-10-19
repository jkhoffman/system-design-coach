# Testing

Run `npm test` for the deterministic suites; the rest are listed here.

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


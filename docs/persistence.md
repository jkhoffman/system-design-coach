# Persistence and recovery

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


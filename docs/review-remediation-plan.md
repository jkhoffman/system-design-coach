# Review remediation plan

Based on [the branch review](../code-review-refactor-interview-lifecycle.md), reviewed against commit `fa930ea`. The seven implementation steps are now applied, and the authorized live provider checks passed on 2026-09-17; see the disposition table in the review for code and test references. The original plan below preserves the existing prompt content, model choices, interview URLs, atomic writes, and job fencing, with regression tests and separate, reviewable commits.

Findings 1–4 were merge blockers. All ten findings are now addressed within the documented provider recovery limits. Finding 2 has passed live API verification; finding 9 has injected-failure tests even though the review did not demonstrate a production failure.

1. **Make model schemas compatible with the API.** Finding 2.

   Scope: `modelFormats.ts`, `schemas.ts`, the model mock, and schema tests.

   The local schema inspection confirms that `PROMPT_FORMAT` contains `context.default: ""`; both formats include `$schema` and validation constraints. Do not assume that all these keywords are rejected: current official documentation supports numeric bounds and array lengths, with additional restrictions for fine-tuned models. The documentation does not settle the non-null-default claim. [Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs).

   Keep canonical Zod contracts for local validation. Add a narrowly scoped conversion for model-facing schemas: remove defaults and schema metadata, retain the documented constraints supported by the configured models, and preserve required properties, closed objects, enums, and nullable fields. Do not maintain a second hand-written prompt/report shape or weaken persistence validation.

   Make the mock reject schemas outside the explicitly supported profile instead of dispatching solely on format name. Test the actual serialized request formats, including nested schemas, and retain malformed-output tests. Prepare an opt-in integration probe with synthetic inputs for both prompt and grading formats, using the configured models. A successful prompt request alone does not verify the grading format. Keep live acceptance marked unverified until those probes run; no paid requests are part of this planning task.

2. **Give connection attempts explicit ownership and recover failed startup.** Findings 1 and 10; foundation for finding 3.

   Scope: migrations, `sessionCommands.ts`, the live-session route, transport, controller, and lobby UI.

   Persist a connection-attempt record with an attempt ID, generation, opaque owner token, startup/confirmed state, lease, upstream session ID, and cleanup outcome. Keep ownership tokens out of shared session GET responses and server-rendered page props. An upstream create response is not confirmation that the browser joined: confirm the attempt after SDP application and `session.started`, through an idempotent server command. Only that attempt may establish the active session.

   Add owner-scoped startup-failure and cancellation commands. After a failed, unconfirmed attempt is retired, the same interview can retry and the lobby retains the error and Join action. A delayed failure or acknowledgment must not reset a newer attempt. Do not restore the unrestricted ability to start any row with `status='live'`. Confirmed interrupted interviews retain their saved progress and use the recovery command in step 3.

   Retain every known upstream ID before returning an error. Retire abandoned attempts with the documented `POST /live/sessions/{session_id}/hangup`, using a separate cleanup deadline rather than the cancelled startup signal. Record failed cleanup durably, retry it with bounds, reconcile it on startup and before a replacement attempt, and expose unresolved cleanup instead of silently creating another upstream session. [Hang-up API](https://developers.openai.com/api/reference/typescript/resources/live/subresources/sessions/methods/hangup).

   If the provider response never supplies an identifier, cleanup cannot be guaranteed by ID. Parse the documented response forms, retain an explicit unknown-outcome diagnostic, and investigate provider-supported reconciliation/idempotency before claiming that case is solved. Do not invent an endpoint or silently treat an untrackable connection as healthy.

   Tests: remote-description failure, missing start event, lost confirmation response, cancellation after upstream creation, expired startup lease, competing starts, cleanup failure/retry, missing ID, and late callbacks from an old attempt. Verify a failed startup can retry, all acquired tracks stop, known abandoned sessions are hung up, and the current attempt survives stale callbacks.

3. **Fence finalization and recover the latest checkpoint on the server.** Finding 3.

   Scope: session commands and PATCH contracts, checkpoint hook, final-save helper, recovery UI, and lifecycle migrations from step 2.

   Require the active generation and owner token for checkpoints and live finalization. Renew ownership through a small heartbeat, independently of transcript changes. Use a conservative expiry/grace period and test background-tab timing; missing one checkpoint must not authorize takeover. An old tab that loses ownership stops sending work and retains its captured data for explicit recovery.

   Replace the recovery tab's finish payload with a dedicated command that atomically claims an expired/released owner and finalizes the latest persisted checkpoint. The server reads the content inside that transaction; it never finalizes the transcript embedded in stale page props. A healthy owner's lease blocks recovery from another tab and produces an actionable message. Migrate pre-ownership live rows into an explicit legacy recovery path.

   Give each final save a stable idempotency key and stored payload identity. Distinguish `saved`, `already_saved_by_this_request`, and `ownership_conflict`. Only the first two navigate to review. A different tab's finish must not look like a successful retry, even when HTTP transport succeeded. On conflict, preserve the local final payload and offer an export/recovery action; do not overwrite a committed report or automatically start grading the rejected payload.

   Tests: live tab A versus stale recovery tab B, recovery racing a checkpoint, recovery after expiry using a newer server checkpoint, same-request retry after lost acknowledgment, different-request finish, and an old generation finishing after takeover. Browser coverage must assert that A's active work cannot be silently replaced and conflicts remain visible.

4. **Keep historical grades readable and make unreadable grades recoverable.** Finding 4.

   Scope: `legacyContracts.ts`, review queries/page, `GradeGate`, status DTOs, and grading commands.

   Separate historical read compatibility from strict validation of newly generated reports. Preserve valid legacy text and scores, supply known missing arrays, and represent negative or otherwise unusable legacy timestamps as unavailable evidence links rather than discarding the entire report. Do not truncate historical evidence merely to satisfy new generation limits.

   Return an explicit grade-read result: absent, readable, or unreadable with a reason. The review page must never mount a generating spinner for an unreadable terminal report. Provide an explicit regrade action for that state. Preserve the original stored report while a replacement runs; authorize replacement through the job token and swap only on success. Make status and UI agree about whether a renderable report exists without parsing full session content on each poll.

   Tests: a report accepted by the former validator with negative timestamps, over-limit legacy strings, missing arrays, truly malformed fields, and a failed then successful regrade. Verify no endless refresh/spinner, historical data survives, and new malformed reports still fail before persistence.

5. **Make artifact references portable and reads side-effect free.** Findings 6 and 8.

   Scope: `artifacts.ts`, artifact references/migrations, status and media routes, review queries, replay, and the polling hook.

   Store new media references relative to `APP_DATA_DIR`. Add one resolver that understands current relative references and validated legacy filenames, including both `<id>.wav` and attempt-specific recording names. For an old absolute reference, look for the corresponding session-scoped file under the current data root; do not access arbitrary paths or rewrite the record until a replacement has been verified. Retain the old reference when no valid local file is found.

   Handle invalid paths and missing files within the resolver. A final-image path failure should try the legacy inline image before returning a controlled missing-artifact result. Remove `resetMissingRecording` from GET/status reads. Missing media should be visible and recoverable through an explicit command, without deleting the stored reference or automatically discarding evidence that might still be recoverable locally.

   Seed the recording UI from server-confirmed artifact availability and job state. A ready recording renders immediately with no job poll; an unavailable recording also needs no poll. Missing or active work uses the shared watcher. An audio-load error can expose a recheck/recovery action. Transient status failures must not hide an already available recording.

   Tests: copy a populated data directory to a different path and render images/play ranged audio without provider calls; resolve both legacy filename patterns; handle missing/out-of-root paths and inline fallback; verify repeated GETs leave database references unchanged; render ready audio when `/status` is unavailable and assert zero recording-job polling requests.

6. **Use transfer-aware deadlines and renewable job leases.** Finding 5.

   Scope: recording download/service, `sessionJobs.ts`, grading retry handling, route duration settings, client request deadlines, and polling limits.

   Separate provider-readiness retries, response-header timeout, download idle timeout, and total transfer budget. Catch transient network exceptions as well as retryable HTTP responses; use bounded backoff and honour `Retry-After`. Stop on permanent failures. Retry interrupted downloads into a fresh temporary file unless the provider's range/resume semantics are verified.

   Use a configurable total recording budget suitable for long interviews (initial local-server target: 30 minutes), a 60-second idle limit, and renewable ownership. Renew the current token's lease periodically; immediately abort and remove temporary data if renewal loses ownership. Keep final publication fenced. Align the browser POST deadline, polling budget, and route configuration with the transfer budget so a healthy transfer does not appear failed after 130 seconds. Next's `maxDuration` is a deployment hint, so document actual hosting limits; a host with a shorter hard limit needs durable worker execution, not fire-and-forget work after a response.

   Apply a small, explicit retry policy to transient grading failures within a documented operation budget, accounting for image reads and backoff. Extend or renew the grading lease consistently. Keep schema/validation errors terminal and manual retry available; do not retry permanent errors or expired owners.

   Tests with fake time and throttled streams: an advancing transfer lasting beyond 45 seconds succeeds; an idle transfer times out; lease renewal supports a long transfer; ownership loss aborts it; a transient connection failure or 429/503 recovers within bounds; all permanent failures clean temporary files. Test the corresponding browser state beyond the former client deadline without waiting in real time.

7. **Make board accounting and finalization resilient, then close the review.** Findings 7 and 9, plus verified minor cleanups.

   Scope: board sync/export, transport shutdown, controller finalization, and integration tests.

   Reserve a pending snapshot slot to prevent overlapping exports, but count a completed milestone and start its cooldown only after successful publication. Release the reservation on null export, timeout, cancellation, or upload failure. Keep export errors from blocking final save. Replace the duplicate export deadlines with one owner of the timeout and abort signal.

   Make teardown attempt every cleanup even when one callback, track stop, channel close, or peer close throws. Attach rejection handling when close starts, not only after awaiting board work. Keep final transcript/timeline capture independent of optional scene/image export and transport cleanup. Explicitly serialize the supported payload fields; retain an immutable retry payload once captured. If preparation itself fails, show a retry-preparation action instead of a Save button with no payload. Resource-release errors must not leave an unhandled rejection or permanent ending overlay.

   Remove the unused recording-row reread. Check snapshot session existence/status before reading a large body and recheck the lifecycle condition before accepting it. Keep the final board summary in the saved timeline; if the upstream session is already closing, do not claim the message was delivered. Verify callers before removing any alleged unused mapper or helper. Profile trace validation before optimizing it; do not include the review's refuted findings as repair work.

   Tests: repeated failed/empty exports leave snapshot capacity and cooldown intact; concurrent attempts respect the cap; each teardown operation can throw independently while the others still run; a non-serializable optional scene does not lose the transcript; preparation and save retries both complete; no unhandled promise rejection or stuck ending UI remains.

**Order and completion criteria**

Implement steps 1–4 first to resolve the merge blockers. Steps 2 and 3 share the ownership design and should be specified together, even if committed separately. Step 5 precedes transfer work so retries preserve valid artifact references. Add regressions alongside each fix, then run lint, route type generation/type checking, deterministic tests, the Webpack production build, and all original and expanded mock browser scenarios.

Update the review with each finding's disposition, code/test references, and any remaining provider uncertainty. Keep the previous successful tests intact. Record live schema-probe outcomes separately from mock results. Completion requires that no active tab loses its final content silently, failed startup can retry safely, historical grades and relocated artifacts remain usable, long transfers retain ownership, and every ending state either completes or exposes a working recovery action.


**Implementation verification — 2026-09-17**

All seven steps are implemented. Type checking, ESLint, 71 deterministic tests, the Webpack production build, and the full mock browser suite pass. Browser regressions cover failed SDP retry, stale-tab recovery, final-save conflict/export, legacy-grade replacement, ready audio without polling, and recording requests past the former client deadline. All provider calls in those checks use the local mock.

Separate authorized live verification also passed: both `prompt_spec` and `grade_report` were accepted and validated using the configured `gpt-5.6-terra` model. A short real `gpt-live-1` interview recovered from an injected SDP failure, received interviewer speech, saved a whiteboard checkpoint, received `session.closed`, released media resources, and produced a grade and playable, seekable recording. The retired first attempt's persisted cleanup state was `done`. This used synthetic input and an isolated data directory; it does not validate long-session behavior or interview quality. Unknown provider session IDs still require explicit reconciliation as documented in README.

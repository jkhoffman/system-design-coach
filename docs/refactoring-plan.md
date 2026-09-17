# Refactoring plan

Preserve the existing interview experience, prompt content, model settings, review URLs, and saved sessions. Make the changes below as separate, reviewable commits. Keep each commit green; add the regression tests for a behavior in the same commit as its fix.

The order prioritizes data preservation and resource ownership, then simplifies contracts and presentation. Keep the existing pure pacing, timeline, and scene-summary modules as the basis for the refactored application.

1. **Establish the test harness and baseline.**

   Scope: `scripts/check-pure.mjs`, `scripts/e2e-mock.mjs`, `scripts/live-browser-stub.mjs`, `scripts/mock-openai.mjs`, and `package.json`.

   - Split the deterministic checks into named suites for persistence, contracts, grading, timeline, pacing, and diagnostics, using Node's test runner.
   - Extract fixtures for temporary SQLite databases, fake clocks, deferred requests, and deterministic model responses. Close databases and remove temporary files after each suite.
   - Make the browser stub configurable for delayed microphone acquisition, missing session-start events, disconnects, delayed close acknowledgments, and overlapping tool calls.
   - Add an independent type-check command using Next's route type generation and TypeScript. Declare and document a Node version compatible with SQLite and the chosen test execution path.
   - Preserve the existing mock end-to-end scenarios for a completed interview, checkpoint recovery, and freeform prompt generation.

   Acceptance: the current deterministic scenarios pass under named suites; lint and type checking pass; mocked browser tests run using a temporary database and local model server. Establish a successful browser baseline on a host that permits the required subprocesses and local listeners.

2. **Make session lifecycle writes atomic.**

   Scope: `src/lib/db.ts`, the live-session and session PATCH routes, and `useInterviewCheckpoint.ts`.

   - Separate connection/migration code from session repository operations. Replace exception-driven column discovery with persisted, ordered schema migrations.
   - Introduce explicit commands for starting a session, saving progress, and finishing. Put status and revision conditions in the SQL update itself.
   - Add a monotonically increasing checkpoint revision. An older checkpoint must never replace newer progress or finalized content.
   - Make finish idempotent: the first accepted finish freezes interview content; retries return the saved result. Grading and recording state remain independently mutable.
   - Reserve and identify a connection attempt before the external session-creation request. Prevent duplicate requests or late responses from replacing an active session ID or reopening an ended session.
   - Return small acknowledgments from writes and surface checkpoint failures instead of silently treating every HTTP response as success.

   Acceptance: reproduce the delayed-checkpoint/final-save interleaving and prove final content survives. Test reordered checkpoints, duplicate finish requests, duplicate starts, and late connection responses. Run migration tests against a representative existing database and verify saved interviews remain readable.

3. **Centralize grading and recording job ownership.**

   Scope: database claim helpers, grading/recording routes, `GradeGate.tsx`, and `ReplayScrubber.tsx`.

   - Extract a small session-job service with explicit attempt tokens, lease expiry, and terminal states.
   - Require the current attempt token for completion and failure writes. A previous attempt cannot modify a newer attempt or its completed result.
   - Set explicit operation deadlines and retry limits consistent with the lease duration. Use lease renewal if an operation legitimately outlives that duration.
   - Add a lightweight status query/DTO exposing job state, errors, and whether a lease is stale.
   - Extract shared polling mechanics with one active request, timer cleanup, cancellation, bounded retries, and explicit stale-job recovery. Keep grading and recording behavior in their respective services.
   - Give one review controller responsibility for requesting each job. Remove the redundant recording kickoff from interview navigation once the review flow owns it.

   Acceptance: simulate an expired attempt, a new claim, and late success/failure from the old attempt. Verify only the current owner can finish. Test recovery after interruption, concurrent review tabs, unavailable recordings, manual retry, and unmounting during a request. Preserve one model/download request per successful job attempt.

4. **Extract the live interview controller and resource lifecycle.**

   Scope: `InterviewRoom.tsx`, `liveSession.ts`, `useBoardSync.ts`, and `useInterviewCheckpoint.ts`.

   - Define legal UI lifecycle transitions separately from transport activity such as thinking. Late callbacks cannot transition an ending interview back to live.
   - Extract `useInterviewController` to own connection, pacing, shutdown, recovery, and final-save orchestration. Keep `InterviewRoom` focused on rendering and user actions.
   - Extract board image export behind a small adapter used by board sync and the whiteboard tool handler.
   - Make transport shutdown awaitable by all callers. Stop a microphone acquired after cancellation immediately, clean up listeners/timers, and bound waits for session startup and shutdown.
   - Track tool/delegation work by IDs so duplicate completion events and concurrent calls do not corrupt activity state or image/result ordering.
   - Serialize checkpoint/finalization work where appropriate and bound board-upload flushes. Freeze one final payload for retries and preserve the existing recovery flow.

   Acceptance: no active media tracks or listeners after cancellation/unmount; all close callers observe completed teardown; missing startup events produce a recoverable error; finishing remains possible after board-upload failure; concurrent protocol events preserve tool-result/image/continuation order. Re-run completed-interview and recovery browser scenarios.

5. **Normalize diagnostics and consolidate data contracts.**

   Scope: `schemas.ts`, `types.ts`, `rubric.ts`, `promptGen.ts`, `liveTrace.ts`, and `liveTraceAnalysis.ts`.

   - Define canonical runtime schemas for prompts, grading reports, session commands, and trace records. Derive TypeScript types and compatible structured-output JSON schemas from those contracts.
   - Keep structural grade parsing separate from rubric checks and weighted-score calculation. Validate every field consumed by the review UI.
   - Make session-creation input a discriminated union so each mode requires the correct prompt reference.
   - Centralize trace field limits and sanitization at production and ingestion. Parse diagnostic data separately so malformed diagnostics cannot reject otherwise valid interview content.
   - Normalize timestamps onto a consistent clock and match acknowledgments using the IDs actually emitted. Exclude unsent messages from successful-send latency measurements.
   - Preserve readability of existing persisted sessions and traces through explicit legacy normalization where needed.

   Acceptance: oversized trace errors cannot prevent saving; exported traces satisfy their persistence contract; reordered acknowledgments match the correct sends; mixed pre-start/session timestamps produce correct durations; malformed grading reports fail before persistence or rendering. Check generated model schemas against the SDK's supported structured-output form.

6. **Make prompt ownership explicit and simplify setup state.**

   Scope: `prompts.ts`, prompt-generation routes, session creation, `page.tsx`, and `SetupForm.tsx`.

   - Keep full library prompt specifications in a server-only module. Pass only public summaries to the setup UI.
   - Persist generated prompt specifications server-side and return an ID plus public preview. Resolve that ID when creating the interview.
   - Extract prompt generation into a hook that associates responses with the input revision. Abort or discard stale responses after mode, description, or briefing changes.
   - Reuse one briefing-fields component and model custom duration selection explicitly so editing an invalid value cannot silently retain an unrelated valid selection.

   Acceptance: fact sheets are absent from client bundles, serialized page props, and public prompt responses. Library, briefing-generated, and freeform flows still work. Changing inputs during generation cannot install an outdated prompt. Test the duration boundaries and switching between preset/custom durations.

7. **Separate session content from media and lightweight reads.**

   Scope: session queries/DTOs, snapshot/recording/grading routes, and the review page.

   - Introduce purpose-specific reads for status, history, recovery, review, and grading. Avoid parsing transcript, trace, scene, and grade JSON for callers that only need status metadata.
   - Extract artifact operations for saving snapshots, reading grading images, downloading recordings, and serving media. Centralize path validation and content checks.
   - Stream recording downloads to an attempt-specific temporary file. Publish atomically only while the attempt still owns the job; clean up failed or superseded files.
   - Serve final images by URL and keep base64 image data out of normal session JSON. Provide a compatible reader or migration for existing inline images.
   - Move JSON body limits into bounded stream reading and choose limits appropriate to metadata versus image uploads.

   Acceptance: polling payload size stays independent of interview length and image size; existing final images still render; audio seeking and snapshot retrieval still work; interrupted downloads expose no partial recording; concurrent stale attempts cannot overwrite the current recording; oversized request bodies stop at the configured limit.

8. **Finish shared utilities, documentation, and integration verification.**

   - Move time formatting out of the grading module into a small shared utility, preserving intentional rounding differences between clocks and evidence timestamps.
   - Consolidate repeated API error parsing and session lookup without hiding route-specific behavior.
   - Remove obsolete update helpers and duplicate types after their callers have migrated. Keep module boundaries tied to responsibilities established in the earlier changes.
   - Update README instructions for runtime requirements, test commands, persistence, job recovery, and diagnostics.
   - Run lint, route type generation/type checking, deterministic suites, production build, and all mocked browser flows. Add final end-to-end coverage for retrying a failed save, recovering an expired job, and discarding stale prompt generation.

   Acceptance: all checks pass, original mock scenarios retain their assertions, and the new failure scenarios pass without contacting the live model service.

**Dependencies and completion criteria**

Follow the order above. Atomic session writes provide the foundation for job ownership and controller extraction. Canonical contracts precede the prompt API changes; artifact publication reuses the job ownership guarantees. Add regression coverage with each phase rather than deferring it to the final verification pass.

The cleanup is complete when final interview content cannot be overwritten by stale work, every asynchronous operation has a clear owner and cleanup path, public data excludes hidden prompt content, diagnostics cannot block persistence, existing saved sessions remain usable, and the full local mock workflow passes.

**Baseline from the review**

Deterministic checks, ESLint, and standalone TypeScript checking passed. Temporary local probes reproduced the checkpoint overwrite, stale grading worker, late microphone acquisition, trace-schema rejection, incomplete grade validation, and trace-correlation/clock issues. The mocked browser suite was blocked before execution by Turbopack's subprocess port-binding restriction in the review environment, including on retry. Record a successful build/browser baseline in a suitable environment before relying on those tests as a regression gate. Paid live smoke tests are an optional separate integration check.

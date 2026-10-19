# How it works

- **Voice**: the Live model (default `gpt-live-1`, set by `LIVE_MODEL`) over WebRTC. The browser sends an SDP offer to
  `POST /api/live/session`, which attaches the interviewer persona + fact sheet
  and forwards to `POST /v1/live/sessions`. The API key never leaves the server.
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
  silent `[interview clock] elapsed MM:SS of MM:SS` context update is appended.
  Duration-aware clarification, architecture, deep-dive, coverage, and summary
  milestones are delivered at quiet opportunities and tracked through their Live
  append acknowledgements.
- **Recording**: sessions are created with `store: true`; the stereo WAV
  (candidate left / interviewer right) is downloaded after the interview and
  served on the review page.
- **Grading**: a vision-capable Responses model gets the rubric, the transcript,
  the board timeline, and milestone PNGs, and returns a structured scorecard
  including a mechanical trade-off audit (for every architectural choice, was an
  alternative and a reason stated?).

## Code organization

- `database.ts` / `migrations.ts`: connection ownership and schema upgrades.
- `db.ts`, `sessionQueries.ts`, `sessionCommands.ts`: repository reads and guarded writes.
- `sessionJobs.ts` / `pollJob.ts`: job ownership and client polling.
- `useInterviewController.ts` / `liveSession.ts`: UI lifecycle and transport resources.
- `artifacts.ts`: image validation, recording publication, and media serving.
- `usePromptGeneration.ts`: setup request ownership and cancellation.

The implementation sequence and acceptance criteria are recorded in
[the refactoring plan](refactoring-plan.md) and
[review remediation plan](review-remediation-plan.md).

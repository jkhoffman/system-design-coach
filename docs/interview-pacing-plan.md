# GPT-Live interview pacing implementation plan

## Objective

Make interview pacing explicit, measurable, and reliable without replacing the
current GPT-Live + Responses delegation architecture. Preserve the existing
ownership, recovery, recording, grading, and whiteboard behavior.

The plan follows the current GPT-Live guidance for
[prompt structure](https://developers.openai.com/api/docs/guides/live-prompting),
[session context](https://developers.openai.com/api/docs/guides/live-conversations),
and [Responses delegation](https://developers.openai.com/api/docs/guides/live-delegation).
In particular:

- behavioral commands use `session.instructions.append`;
- factual clock and UI state use `session.thinking.append`;
- `session.commentary.append` is reserved for verified information that should
  be spoken;
- append acknowledgements are correlated through `event_id` / `client_event_id`;
- images continue to go to the vision-capable Responses backend, not the Live
  voice frontend;
- transcript gaps alone are never treated as proof of silence.

## Non-goals

- Do not migrate from Responses delegation to client delegation.
- Do not add Realtime-only VAD fields to the GPT-Live configuration.
- Do not increase backend reasoning effort globally without evaluation data.
- Do not routinely extend an interview beyond its selected duration.
- Do not infer a completed conversational turn from transcript fragments.
- Do not change grading weights or the saved-session URL/DTO contracts.

## Phase 1: Establish a pacing baseline

Before changing behavior, extend the existing trace report to summarize:

- join click to `session.started`;
- `session.started` to the first interviewer transcript;
- candidate transcript end to the next interviewer transcript;
- delegation queue, tool execution, continuation, backend response, and speech
  output latency;
- append send-to-ack latency and append failures by type;
- interviewer/candidate speaking time and turn count in five-minute buckets;
- whiteboard-summary and `view_whiteboard` call counts;
- when each pacing milestone became due, was sent, and was acknowledged.

Keep transcript timing caveats visible: fragments are uneven and do not provide
a definitive turn-completed event. New metrics must be described as estimates.

### Acceptance criteria

- `live-trace-report` can explain opening latency and every pacing append.
- Existing stored traces remain readable.
- Missing events produce `missing`/`unknown`, not invented zero-duration stages.
- Deterministic trace fixtures cover reordered and missing acknowledgements.

## Phase 2: Align the Live prompt and opening sequence

Restructure `buildInterviewerInstructions` with explicit sections:

1. **Conversation style** — short, natural, unhurried speech.
2. **Backchannel policy** — occasional short acknowledgements that do not
   compete with candidate speech.
3. **Interruption policy** — stop speaking and listen when the candidate begins.
4. **Delegation policy** — concrete backend capabilities and positive/negative
   delegation conditions.
5. **Silence policy** — keep listening while the candidate thinks or draws;
   ignore coughs and unrelated background speech.
6. **Interview procedure** — clarification, architecture, deep dive, coverage,
   summary, and close.

The delegation policy should delegate when a question depends on the current
diagram or careful architectural reasoning. It should not delegate for the
greeting, fact-sheet clarifications, brief acknowledgements, or scheduled pacing
commands.

After `session.started` and ownership confirmation, replace the current opening
`session.commentary.append` with one `session.instructions.append` that tells the
interviewer to greet, deliver the question, invite clarifications, then listen.
Keep microphone input active throughout.

### Delivery semantics

- A definite local send failure or explicit provider rejection may be retried
  once.
- An acknowledgement timeout is an ambiguous outcome. Do not blindly repeat the
  greeting, because it may already have been spoken.
- Surface the ambiguous outcome in the trace and UI while continuing to accept
  audio; never tear down an otherwise healthy session solely because the
  acknowledgement is late.

### Acceptance criteria

- Prompt snapshot tests contain all documented policy headings and unambiguous
  delegate/do-not-delegate rules.
- The mock browser suite observes exactly one opening
  `session.instructions.append`, never an opening commentary append.
- The opening event carries `delegation_id: null` and a unique event ID.
- The client correlates its acknowledgement or explicit error.
- Lost acknowledgements cannot produce a duplicate spoken greeting.

## Phase 3: Add an acknowledgement-aware append API

Replace the fire-and-forget transport surface with an append abstraction that
distinguishes local send, provider acceptance, rejection, and ambiguous timeout.
A target shape is:

```ts
interface AppendReceipt {
  eventId: string;
  kind: "instructions" | "thinking" | "commentary";
  sent: boolean;
  accepted: Promise<
    | { outcome: "acknowledged"; startMs?: number; endMs?: number }
    | { outcome: "rejected"; message: string }
    | { outcome: "unknown"; message: string }
  >;
}
```

Implementation requirements:

- Store pending appends by event ID.
- Extend the parsed Live event contract with `client_event_id`, `start_ms`, and
  `end_ms` for append acknowledgements and correlated errors.
- Resolve only the matching pending append.
- Apply a bounded timeout and remove timers/listeners on every terminal path.
- On shutdown, settle every pending receipt as `unknown`; do not leak promises.
- Preserve trace recording for successful, dropped, rejected, late, and
  unmatched events.
- Enforce the documented 500-token append budget before sending. Use a
  conservative local character/token estimate or an explicit short-content
  contract; never truncate a behavioral instruction silently.

### Acceptance criteria

- Concurrent appends with reordered acknowledgements pair correctly.
- Duplicate acknowledgements are harmless.
- Acknowledgements after timeout are traced but cannot settle a newer append.
- Closing with pending appends leaves no timer, listener, or unhandled rejection.
- Existing board updates remain non-blocking.

## Phase 4: Replace two warnings with a duration-aware phase schedule

Keep the monotonic session clock anchored to `session.started`. Replace the
current fixed late warnings with pure, duration-derived milestones.

Recommended proportions, subject to evaluation:

| Milestone | Target elapsed time | Purpose |
| --- | ---: | --- |
| Clarification complete | 12–15%, capped at 7 min | Summarize requirements and begin architecture |
| Architecture established | 40–45% | Ensure an end-to-end design exists |
| Deep dive | 50–55% | Select at most two design-specific deep dives |
| Coverage check | 75–80% | Address scale, failure modes, and missing trade-offs |
| Final summary | 88–92% | Stop opening topics and request a concise synthesis |
| Hard close | 100% | Gracefully close the Live session |

For very short interviews, merge milestones rather than scheduling them seconds
apart. The pure scheduler must guarantee strictly increasing times and no
duplicate semantic phases for every supported duration from 5 to 120 minutes.

Continue sending five-minute clock facts with `session.thinking.append`. Send
behavioral phase transitions with `session.instructions.append`.

### Acceptance criteria

- Table-driven tests cover 5, 8, 10, 15, 20, 30, 45, 60, 90, and 120 minutes.
- Every schedule is ordered, bounded, and leaves useful time for the requested
  final summary.
- The 45-minute schedule includes an explicit deep-dive transition near the
  midpoint rather than only ten- and five-minute warnings.
- A delayed browser timer marks overdue milestones due in order without sending
  duplicates.

## Phase 5: Deliver phase transitions at safe opportunities

An instructions append can affect or interrupt speech in progress. Separate a
milestone becoming **due** from it being **sent**.

Use the best available signals, while treating them as heuristics:

- recent candidate and interviewer transcript activity;
- Live/delegation activity state;
- active whiteboard tool execution;
- connection/data-channel readiness;
- a bounded maximum deferral.

Do not claim that a transcript gap proves silence. Prefer a short quiet debounce,
then send; force delivery after a bounded deferral so a continuously speaking
candidate cannot suppress the final-summary instruction indefinitely.

State progression should be explicit:

```text
pending -> due -> sent -> acknowledged
                    \-> rejected
                    \-> unknown
```

Only one phase append may be in flight. Coalesce obsolete transitions after a
heavily delayed/backgrounded tab: send the latest useful phase instruction and
record earlier milestones as skipped, rather than rapidly injecting several
instructions.

### Acceptance criteria

- A threshold crossed during candidate or interviewer transcript activity is
  deferred.
- A transition is eventually sent after the maximum deferral.
- Background-tab timer jumps do not emit a burst of stale instructions.
- Definite failures retry once; ambiguous outcomes do not cause uncontrolled
  duplicate speech.
- The hard deadline still follows the existing graceful `session.close` path and
  waits for `session.closed` within its bounded deadline.

## Phase 6: Reduce redundant whiteboard context

Preserve the four-second drawing-pause debounce and structural scene summary.
Add semantic deduplication:

- Normalize and retain the last successfully sent summary.
- Skip unchanged summaries.
- Combine rapid changes into the latest complete state.
- Make removals and renamed labels explicit in the next summary.
- Keep full scene JSON and images out of Live context.
- Continue sending images only to the Responses backend when
  `view_whiteboard` requires them.

Set `delegation.responses.parallel_tool_calls` to `false` explicitly while the
backend has one whiteboard tool and the client waits for all active results before
one continuation. Retain the overlap-safe implementation as defensive protocol
handling.

### Acceptance criteria

- Identical scene summaries produce one append.
- Selection and viewport changes still produce no append.
- Add, rename, reconnect, and delete operations each produce an updated summary.
- The delegated image/tool-result pairing and single continuation regressions
  remain green.

## Phase 7: Record usage and evaluate quality

Keep `performance.now()` as the interview pacing clock. Separately persist or
summarize provider-reported usage for cost analysis:

- GPT-Live voice duration;
- backend input/output and cached tokens when available;
- delegation count and latency;
- whiteboard image/tool calls;
- failed, rejected, and ambiguous appends.

Create deterministic scripted interview scenarios:

1. candidate asks many clarification questions;
2. candidate draws silently for 60–90 seconds;
3. candidate speaks through a phase threshold;
4. candidate is far behind at the midpoint;
5. candidate reaches a strong design early;
6. backend tool call is slow or fails;
7. the tab is backgrounded across several milestones;
8. the final summary overlaps the nominal deadline.

Score each run for phase timing, interruption count, interviewer talk ratio,
delegation usefulness, first useful spoken latency, and whether the final summary
completed. Compare prompt/config variants on the same scenarios.

### Rollout gates

1. Deterministic unit and protocol tests.
2. Full local mock browser suite.
3. Recorded synthetic-audio evaluation with no paid API calls where possible.
4. A small paid GPT-Live canary set using isolated data and explicit cost limits.
5. Manual listening review before enabling the new pacing schedule by default.

## Implementation order

1. Baseline trace metrics.
2. Append receipt/correlation primitive.
3. Prompt policy structure and acknowledged opening instruction.
4. Pure duration-aware milestone scheduler.
5. Safe-opportunity delivery state machine.
6. Whiteboard deduplication and explicit sequential tool configuration.
7. Usage persistence, scripted evaluations, and staged rollout.

The append primitive precedes pacing changes so the application never adds more
critical instructions while still treating delivery as fire-and-forget. Each
phase should land with its tests and remain independently reviewable.

## Completion criteria

The work is complete when:

- the opening follows the documented GPT-Live instruction flow;
- the Live prompt has explicit backchannel, interruption, silence, and delegation
  policies;
- every critical pacing command has a durable trace outcome;
- all supported durations receive coherent, non-overlapping phases;
- phase instructions avoid active speech when practical and never burst after a
  timer jump;
- unchanged whiteboard state is not re-appended;
- recordings show that candidates can think and draw without premature takeover;
- final summaries usually finish before the hard deadline;
- latency, interview quality, and cost are evaluated together rather than
  optimizing any one metric in isolation.

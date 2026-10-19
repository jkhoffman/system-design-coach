# Live diagnostics

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


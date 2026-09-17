const trace = (seq, dir, sessionMs, type, extra = {}) => ({
  seq,
  dir,
  atPerfMs: sessionMs,
  sessionMs,
  type,
  ...extra,
});
export const sampleTrace = [
  trace(1, "in", 0, "session.started"),
  trace(2, "in", 1_000, "session.input_transcript.delta", { endMs: 1_500, speaker: "candidate" }),
  trace(3, "in", 4_000, "session.delegation.created"),
  trace(4, "in", 5_000, "response.event", { innerType: "response.created" }),
  trace(5, "in", 7_000, "response.event", {
    innerType: "response.output_item.done",
    itemType: "function_call",
    callId: "call_1",
    toolName: "view_whiteboard",
  }),
  trace(6, "local", 7_500, "tool.handler.start", { callId: "call_1" }),
  trace(7, "out", 8_000, "response.item.create", {
    itemType: "function_call_output",
    callId: "call_1",
    sent: true,
  }),
  trace(8, "out", 8_500, "response.create", { sent: true }),
  trace(9, "in", 12_000, "response.event", { innerType: "response.completed" }),
  trace(10, "in", 14_000, "session.output_transcript.delta", {
    startMs: 14_500,
    speaker: "interviewer",
  }),
  trace(11, "out", 15_000, "session.thinking.append", { clientEventId: "append_1", sent: true }),
  trace(12, "in", 15_500, "session.thinking.appended", { eventId: "append_1" }),
  trace(13, "in", 16_000, "session.closed"),
];

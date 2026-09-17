import type { LiveTraceDirection, LiveTraceEvent } from "./liveTrace";

export type LiveTraceGapClassification =
  | "turn_taking"
  | "delegation_queue"
  | "tool_execution"
  | "continuation_send"
  | "backend_response"
  | "speech_output"
  | "context_append"
  | "unknown";

export interface LiveTraceGap {
  startMs: number;
  endMs: number;
  durationMs: number;
  classification: LiveTraceGapClassification;
  fromType: string;
  toType: string;
  description: string;
}

export interface LiveTraceStage {
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: "ok" | "missing";
  detail?: string;
}

export interface LiveTraceAnalysis {
  eventCount: number;
  durationMs: number;
  counts: Record<LiveTraceDirection, number>;
  eventTypes: Record<string, number>;
  stages: LiveTraceStage[];
  appendLatencies: Array<{ type: string; durationMs: number; clientEventId?: string }>;
  turnGaps: LiveTraceGap[];
  gaps: LiveTraceGap[];
  missingSignals: string[];
}

const DEFAULT_GAP_THRESHOLD_MS = 2_000;

function eventMs(e: LiveTraceEvent): number {
  return e.sessionMs ?? e.atPerfMs;
}

function eventEndMs(e: LiveTraceEvent): number {
  return e.endMs ?? eventMs(e);
}

function eventStartMs(e: LiveTraceEvent): number {
  return e.startMs ?? eventMs(e);
}

function isCandidateDelta(e: LiveTraceEvent): boolean {
  return e.dir === "in" && e.type === "session.input_transcript.delta";
}

function isInterviewerDelta(e: LiveTraceEvent): boolean {
  return e.dir === "in" && e.type === "session.output_transcript.delta";
}

function isFunctionCall(e: LiveTraceEvent): boolean {
  return e.dir === "in" && e.innerType === "response.output_item.done" && e.itemType === "function_call";
}

function isToolResult(e: LiveTraceEvent): boolean {
  return (
    e.dir === "out" && e.sent !== false &&
    e.type === "response.item.create" &&
    e.itemType === "function_call_output"
  );
}

function isNestedResponseCreated(e: LiveTraceEvent): boolean {
  return e.dir === "in" && e.type === "response.event" && e.innerType === "response.created";
}

function isNestedResponseCompleted(e: LiveTraceEvent): boolean {
  return e.dir === "in" && e.type === "response.event" && e.innerType === "response.completed";
}

function appendAckFor(type: string): string | null {
  if (type === "session.thinking.append") return "session.thinking.appended";
  if (type === "session.instructions.append") return "session.instructions.appended";
  if (type === "session.commentary.append") return "session.commentary.appended";
  return null;
}

function appendSendFor(type: string): string | null {
  if (type === "session.thinking.appended") return "session.thinking.append";
  if (type === "session.instructions.appended") return "session.instructions.append";
  if (type === "session.commentary.appended") return "session.commentary.append";
  return null;
}

function label(e: LiveTraceEvent): string {
  return e.innerType ? `${e.type}/${e.innerType}` : e.type;
}

function classifyGap(from: LiveTraceEvent, to: LiveTraceEvent): LiveTraceGapClassification {
  const ackSend = appendSendFor(to.type);
  if (from.dir === "out" && to.dir === "in" && ackSend === from.type) return "context_append";
  if (isCandidateDelta(from) && (isInterviewerDelta(to) || to.type === "session.delegation.created")) {
    return "turn_taking";
  }
  if (from.type === "session.delegation.created" && isNestedResponseCreated(to)) return "delegation_queue";
  if (isFunctionCall(from) && isToolResult(to)) return "tool_execution";
  if (isToolResult(from) && to.dir === "out" && to.type === "response.create") return "continuation_send";
  if (
    (from.dir === "out" && from.type === "response.create" && isNestedResponseCompleted(to)) ||
    (from.type === "session.delegation.created" && isNestedResponseCompleted(to))
  ) {
    return "backend_response";
  }
  if (isNestedResponseCompleted(from) && isInterviewerDelta(to)) return "speech_output";
  return "unknown";
}

function describeGap(from: LiveTraceEvent, to: LiveTraceEvent): string {
  return `${label(from)} → ${label(to)}`;
}

function firstAfter<T extends LiveTraceEvent>(
  events: T[],
  startIndex: number,
  predicate: (e: T) => boolean
): { event: T; index: number } | null {
  for (let i = startIndex + 1; i < events.length; i++) {
    if (predicate(events[i])) return { event: events[i], index: i };
  }
  return null;
}

function makeStage(
  name: string,
  start: LiveTraceEvent | undefined,
  end: LiveTraceEvent | undefined,
  detail?: string,
  startMsOverride?: number,
  endMsOverride?: number
): LiveTraceStage {
  const startMs = startMsOverride ?? (start ? eventMs(start) : 0);
  const endMs = endMsOverride ?? (end ? eventMs(end) : 0);
  if (!start || !end) {
    return { name, startMs, endMs, durationMs: 0, status: "missing", detail };
  }
  return { name, startMs, endMs, durationMs: endMs - startMs, status: "ok", detail };
}

export function analyzeLiveTrace(
  events: readonly LiveTraceEvent[],
  options: { gapThresholdMs?: number } = {}
): LiveTraceAnalysis {
  const anchored = events.find((event) => event.type === "session.started")
    ?? events.find((event) => event.sessionMs !== undefined);
  const origin = anchored ? anchored.atPerfMs - (anchored.sessionMs ?? 0) : 0;
  const sorted = events.map((event) => ({ ...event, sessionMs: event.atPerfMs - origin }))
    .sort((a, b) => a.seq - b.seq || a.atPerfMs - b.atPerfMs);
  const threshold = options.gapThresholdMs ?? DEFAULT_GAP_THRESHOLD_MS;
  const counts: Record<LiveTraceDirection, number> = { in: 0, out: 0, local: 0 };
  const eventTypes: Record<string, number> = {};
  for (const e of sorted) {
    counts[e.dir]++;
    const key = label(e);
    eventTypes[key] = (eventTypes[key] ?? 0) + 1;
  }

  const durationMs = sorted.length ? eventMs(sorted[sorted.length - 1]) - eventMs(sorted[0]) : 0;

  const firstDelegationIndex = sorted.findIndex((e) => e.type === "session.delegation.created");
  const firstDelegation = firstDelegationIndex >= 0 ? sorted[firstDelegationIndex] : undefined;
  const nestedCreated = firstDelegation
    ? firstAfter(sorted, firstDelegationIndex, isNestedResponseCreated)?.event
    : undefined;
  const firstToolCallIndex = firstDelegation
    ? (firstAfter(sorted, firstDelegationIndex, isFunctionCall)?.index ?? -1)
    : -1;
  const firstToolCall = firstToolCallIndex >= 0 ? sorted[firstToolCallIndex] : undefined;
  const firstToolResultIndex = firstToolCall
    ? (firstAfter(
        sorted,
        firstToolCallIndex,
        (e) => isToolResult(e) && (!firstToolCall.callId || e.callId === firstToolCall.callId)
      )?.index ?? -1)
    : -1;
  const firstToolResult = firstToolResultIndex >= 0 ? sorted[firstToolResultIndex] : undefined;
  const firstContinuationIndex = firstToolResult
    ? (firstAfter(sorted, firstToolResultIndex, (e) => e.dir === "out" && e.sent !== false && e.type === "response.create")
        ?.index ?? -1)
    : -1;
  const firstContinuation = firstContinuationIndex >= 0 ? sorted[firstContinuationIndex] : undefined;
  const firstCompletionIndex = firstDelegation
    ? (firstAfter(sorted, firstDelegationIndex, isNestedResponseCompleted)?.index ?? -1)
    : -1;
  const firstCompletion = firstCompletionIndex >= 0 ? sorted[firstCompletionIndex] : undefined;
  const firstInterviewerAfterCompletion = firstCompletion
    ? firstAfter(sorted, firstCompletionIndex, isInterviewerDelta)?.event
    : undefined;

  let lastCandidateBeforeDelegation: LiveTraceEvent | undefined;
  if (firstDelegation) {
    for (let i = firstDelegationIndex - 1; i >= 0; i--) {
      if (isCandidateDelta(sorted[i])) {
        lastCandidateBeforeDelegation = sorted[i];
        break;
      }
      if (isInterviewerDelta(sorted[i])) break;
    }
  }

  const stages: LiveTraceStage[] = [
    makeStage(
      "candidate_end_to_delegation",
      lastCandidateBeforeDelegation,
      firstDelegation,
      undefined,
      lastCandidateBeforeDelegation ? eventEndMs(lastCandidateBeforeDelegation) : undefined
    ),
    makeStage("delegation_to_response_created", firstDelegation, nestedCreated),
    makeStage("delegation_to_tool_call", firstDelegation, firstToolCall),
    makeStage("tool_call_to_tool_result", firstToolCall, firstToolResult),
    makeStage("tool_result_to_continuation", firstToolResult, firstContinuation),
    makeStage("continuation_to_response_completed", firstContinuation, firstCompletion),
    makeStage("delegation_to_response_completed", firstDelegation, firstCompletion),
    makeStage(
      "response_completed_to_interviewer_transcript",
      firstCompletion,
      firstInterviewerAfterCompletion,
      undefined,
      undefined,
      firstInterviewerAfterCompletion ? eventStartMs(firstInterviewerAfterCompletion) : undefined
    ),
  ];

  const appendLatencies: LiveTraceAnalysis["appendLatencies"] = [];
  const matchedAcks = new Set<LiveTraceEvent>();
  for (let i = 0; i < sorted.length; i++) {
    const sent = sorted[i];
    if (sent.dir !== "out" || sent.sent === false) continue;
    const sentId = sent.eventId ?? sent.clientEventId;
    const ackType = appendAckFor(sent.type);
    if (!ackType) continue;
    const ack = firstAfter(
      sorted,
      i,
      (e) =>
        e.dir === "in" &&
        e.type === ackType &&
        !matchedAcks.has(e) &&
        (sentId ? (e.clientEventId ?? e.eventId) === sentId : !e.clientEventId && !e.eventId)
    )?.event;
    if (ack) {
      matchedAcks.add(ack);
      appendLatencies.push({
        type: sent.type,
        durationMs: eventMs(ack) - eventMs(sent),
        clientEventId: sentId,
      });
    }
  }

  const turnGaps: LiveTraceGap[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const interviewer = sorted[i];
    if (!isInterviewerDelta(interviewer)) continue;
    let candidate: LiveTraceEvent | undefined;
    for (let j = i - 1; j >= 0; j--) {
      if (isInterviewerDelta(sorted[j])) break;
      if (isCandidateDelta(sorted[j])) {
        candidate = sorted[j];
        break;
      }
    }
    if (!candidate) continue;
    const startMs = eventEndMs(candidate);
    const endMs = eventStartMs(interviewer);
    if (endMs > startMs && endMs - startMs >= threshold) {
      turnGaps.push({
        startMs,
        endMs,
        durationMs: endMs - startMs,
        classification: "turn_taking",
        fromType: label(candidate),
        toType: label(interviewer),
        description: "candidate transcript end → interviewer transcript start",
      });
    }
  }

  const gaps: LiveTraceGap[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1];
    const to = sorted[i];
    const startMs = eventMs(from);
    const endMs = eventMs(to);
    if (endMs - startMs < threshold) continue;
    gaps.push({
      startMs,
      endMs,
      durationMs: endMs - startMs,
      classification: classifyGap(from, to),
      fromType: label(from),
      toType: label(to),
      description: describeGap(from, to),
    });
  }
  gaps.sort((a, b) => b.durationMs - a.durationMs);

  const expectedSignals: Array<[string, (e: LiveTraceEvent) => boolean]> = [
    ["session.started", (e) => e.type === "session.started"],
    ["candidate transcript", isCandidateDelta],
    ["interviewer transcript", isInterviewerDelta],
    ["delegation", (e) => e.type === "session.delegation.created"],
    ["nested response.created", isNestedResponseCreated],
    ["tool result", isToolResult],
    ["continuation response.create", (e) => e.dir === "out" && e.sent !== false && e.type === "response.create"],
    ["nested response.completed", isNestedResponseCompleted],
    ["session.closed", (e) => e.type === "session.closed"],
  ];
  const missingSignals = expectedSignals
    .filter(([, predicate]) => !sorted.some((e) => predicate(e)))
    .map(([name]) => name);

  return {
    eventCount: sorted.length,
    durationMs,
    counts,
    eventTypes,
    stages,
    appendLatencies,
    turnGaps,
    gaps,
    missingSignals,
  };
}

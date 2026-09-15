import type { Briefing, PromptSpec, TimelineEvent, TranscriptTurn } from "./types";

export interface RubricDimension {
  key: string;
  label: string;
  weight: number;
  description: string;
  anchors: { low: string; mid: string; high: string };
}

/**
 * Dimensions compiled from published interviewer scorecards (FAANG-style loops).
 * Trade-off reasoning is weighted above equal share and additionally audited
 * mechanically (every architectural choice → was an alternative + reason stated).
 */
export const RUBRIC: RubricDimension[] = [
  {
    key: "scoping",
    label: "Requirements & Scoping",
    weight: 0.15,
    description:
      "Did the candidate clarify functional scope, scale, and constraints before designing? Did the answers actually change the design?",
    anchors: {
      low: "Started drawing immediately; questions asked didn't affect the design; unstated assumptions.",
      mid: "Asked several clarifying questions; used most answers; scoped to a few core features; stated assumptions.",
      high: "Questions changed design direction; negotiated scope explicitly ('I'll focus on X and Y, acknowledge Z exists'); identified the non-obvious requirement unprompted.",
    },
  },
  {
    key: "architecture",
    label: "High-Level Architecture",
    weight: 0.2,
    description:
      "Did they produce a coherent end-to-end design covering the core use case? Right components, sane boundaries, data flows that close the loop?",
    anchors: {
      low: "Boxes with no clear purpose; missing core path; hand-waved 'a database'.",
      mid: "Complete high-level flow (client → LB → services → storage); components justified at a surface level.",
      high: "Clean architecture drawn fast and early; every component has a stated job; flow covers the hardest requirement.",
    },
  },
  {
    key: "depth",
    label: "Technical Depth & Correctness",
    weight: 0.25,
    description:
      "Did the design actually work? Did they go beyond the surface on at least 1-2 components — real data models, protocols, failure modes?",
    anchors: {
      low: "Couldn't explain how their own components work; buzzwords without substance; design wouldn't function.",
      mid: "Solid working design; went deep on one component when prompted; reasonable data model.",
      high: "Proactively went deep on the hardest part; quantified (QPS, storage, bandwidth); addressed failure modes unprompted.",
    },
  },
  {
    key: "tradeoffs",
    label: "Trade-off Reasoning",
    weight: 0.2,
    description:
      "For every significant architectural choice, did they name an alternative AND give a reason? Named costs, not just benefits?",
    anchors: {
      low: "Choices asserted without alternatives; 'we'll use Kafka' with no justification.",
      mid: "Some choices defended when asked; named at least one real trade-off unprompted.",
      high: "Routinely stated 'X over Y because Z'; named the cost of their own choices; knew what they were giving up.",
    },
  },
  {
    key: "communication",
    label: "Communication & Driving",
    weight: 0.15,
    description:
      "Could the interviewer follow their reasoning in real time? Did the candidate drive the interview, think out loud, collaborate?",
    anchors: {
      low: "Long silent stretches with no narration; interviewer had to pull information; defensive under probing.",
      mid: "Explained most of what they drew; responded to probes; mostly drove but needed occasional steering.",
      high: "Narrated thinking continuously; treated the interviewer as a collaborator; self-corrected visibly.",
    },
  },
  {
    key: "pacing",
    label: "Time Management",
    weight: 0.05,
    description:
      "Did they allocate the clock sensibly — enough scoping, an early complete draft, a real deep dive?",
    anchors: {
      low: "Ran out of time before a complete design, or spent the whole interview on requirements.",
      mid: "Reached a complete design with at least a shallow deep dive.",
      high: "Deliberately paced: quick scope, early end-to-end draft, then deep on the highest-risk area.",
    },
  },
];

const LEVEL_BAR: Record<string, string> = {
  L4: "Bar for L4: a clean high-level architecture with reasonable choices is a pass. Deep dives can be interviewer-guided. Not expected: multi-region, deployment, monitoring, cost reasoning.",
  L5: "Bar for L5: must drive the interview independently, go deep on 1-2 components unprompted, discuss failure modes when asked, and defend choices with explicit alternatives.",
  L6: "Bar for L6: everything at L5 plus proactively surfacing operational concerns (monitoring, failure modes, rollout, cost) without being asked, and framing the problem in terms of what NOT to build.",
  Staff: "Bar for Staff: frames the problem in business terms, dictates scope negotiation, identifies the non-obvious requirement, and discusses multi-region/operational/cost concerns proactively.",
};

export function levelBar(level: string): string {
  return (
    LEVEL_BAR[level] ??
    "Bar for a general senior candidate: independent driving, one real deep dive, explicit trade-offs."
  );
}

export function buildGradingInput(input: {
  briefing: Briefing;
  prompt: PromptSpec;
  durationSec: number;
  transcript: TranscriptTurn[];
  timeline: TimelineEvent[];
}): string {
  const { briefing, prompt, durationSec, transcript, timeline } = input;
  const mins = Math.round(durationSec / 60);

  const transcriptText = transcript
    .map((t) => `[${fmtMs(t.startMs)}] ${t.speaker === "candidate" ? "CANDIDATE" : "INTERVIEWER"}: ${t.text}`)
    .join("\n");

  const boardEvents = timeline
    .filter((e) => e.kind === "board" || e.kind === "marker" || e.kind === "snapshot")
    .map((e) =>
      e.kind === "board"
        ? `[${fmtMs(e.startMs)}] WHITEBOARD: ${e.summary}`
        : `[${fmtMs(e.startMs)}] ${e.kind === "marker" ? `MARKER: ${e.label}` : `SNAPSHOT: ${e.label}`}`
    )
    .join("\n");

  return `You are grading a ${mins}-minute system design interview for a ${briefing.level} ${briefing.position} candidate at ${briefing.company || "a large tech company"}.

QUESTION ASKED: "${prompt.question}"
EXPECTED ANGLES: ${prompt.deepDiveAngles.join("; ")}

${levelBar(briefing.level)}

TIMELINE OF WHITEBOARD EVOLUTION (whiteboard state summaries as they changed, plus phase markers):
${boardEvents || "(no whiteboard activity recorded)"}

FULL TRANSCRIPT:
${transcriptText || "(no transcript recorded)"}

Attached images are snapshots of the candidate's actual whiteboard at milestones and at the end — use them to verify the diagram against the transcript claims.

GRADE using this rubric. For each dimension output a score 1-5 (1=strong no hire, 3=lean hire, 5=exceptional):
${RUBRIC.map((d) => `- ${d.key} ("${d.label}", weight ${d.weight}): ${d.description}\n  1-2: ${d.anchors.low}\n  3: ${d.anchors.mid}\n  4-5: ${d.anchors.high}`).join("\n")}

TRADE-OFF AUDIT (mechanical — do this literally):
Extract EVERY significant architectural choice the candidate made from the transcript+timeline (each component added, each technology/structure picked — e.g. "chose Redis cache", "chose fan-out-on-write", "added queue between API and workers"). For each, report whether the candidate stated an ALTERNATIVE and a REASON at or near the moment of the choice (within ~90s of it, or under direct probing). A choice defended only after repeated interviewer pressure counts as reason stated but mark it in the note. This audit feeds the tradeoffs score directly.

OUTPUT RULES:
- Cite evidence with timestamps (mm:ss) drawn from the bracketed times.
- Be calibrated: 3 is a pass, not an insult. Strong hire requires the "high" anchors, not just no mistakes.
- antiPatterns: concrete moments (timestamped where possible) that would appear in a real scorecard.
- strongHireWouldHave: 3-5 specific things a strong-hire candidate would have done differently for THIS question.
- drills: 2-4 concrete practice recommendations.`;
}

export function fmtMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const GRADE_SCHEMA = {
  type: "object",
  properties: {
    overall: {
      type: "object",
      properties: {
        score: { type: "number" },
        signal: {
          type: "string",
          enum: ["strong_no_hire", "no_hire", "lean_no_hire", "lean_hire", "hire", "strong_hire"],
        },
        summary: { type: "string" },
      },
      required: ["score", "signal", "summary"],
      additionalProperties: false,
    },
    dimensions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          score: { type: "number" },
          weight: { type: "number" },
          evidence: { type: "string" },
          moments: {
            type: "array",
            items: {
              type: "object",
              properties: { startMs: { type: "number" }, note: { type: "string" } },
              required: ["startMs", "note"],
              additionalProperties: false,
            },
          },
        },
        required: ["key", "label", "score", "weight", "evidence", "moments"],
        additionalProperties: false,
      },
    },
    tradeoffAudit: {
      type: "array",
      items: {
        type: "object",
        properties: {
          choice: { type: "string" },
          alternativeStated: { type: "boolean" },
          reasonStated: { type: "boolean" },
          startMs: { type: ["number", "null"] },
        },
        required: ["choice", "alternativeStated", "reasonStated", "startMs"],
        additionalProperties: false,
      },
    },
    strengths: { type: "array", items: { type: "string" } },
    antiPatterns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startMs: { type: ["number", "null"] },
          description: { type: "string" },
        },
        required: ["startMs", "description"],
        additionalProperties: false,
      },
    },
    strongHireWouldHave: { type: "array", items: { type: "string" } },
    drills: { type: "array", items: { type: "string" } },
  },
  required: [
    "overall",
    "dimensions",
    "tradeoffAudit",
    "strengths",
    "antiPatterns",
    "strongHireWouldHave",
    "drills",
  ],
  additionalProperties: false,
} as const;

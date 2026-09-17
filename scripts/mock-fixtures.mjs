import { RUBRIC } from "../src/lib/rubric.ts";

export function gradeReport() {
  return {
    overall: {
      score: 1,
      signal: "lean_hire",
      summary: "Mock scorecard: a coherent design was saved, graded, and replayed locally.",
    },
    dimensions: RUBRIC.map((dimension) => ({
      key: dimension.key,
      label: dimension.label,
      score: 4,
      weight: dimension.weight,
      evidence: "Deterministic mock evidence from the local E2E run.",
      moments: [{ startMs: 1000, note: "Mock evidence timestamp" }],
    })),
    tradeoffAudit: [
      {
        choice: "Client to API service",
        alternativeStated: true,
        reasonStated: true,
        startMs: 5000,
      },
    ],
    strengths: ["Reached a complete end-to-end mock design."],
    antiPatterns: [],
    strongHireWouldHave: ["Quantify scale and failure modes in more detail."],
    drills: ["Practice explaining one storage trade-off aloud."],
  };
}

export function promptSpec() {
  return {
    title: "Design a notification service",
    question: "Design a notification service that can deliver product, marketing, and security messages reliably.",
    context:
      "A product team needs one internal service that owns notification preferences, templating, scheduling, and multi-channel delivery.",
    factSheet: [
      { q: "What channels are in scope?", a: "Email, SMS, and mobile push; in-app inbox is explicitly out of scope." },
      { q: "What scale?", a: "20 million users, 5 million notifications per day, and bursts up to 2,000 sends per second." },
      { q: "What latency target?", a: "Security messages should be sent within 30 seconds; marketing messages can lag for hours." },
      { q: "What is the twist?", a: "A provider outage must not cause duplicate user-facing sends after retry." },
      { q: "Do we need exact once delivery?", a: "Effectively-once user delivery is required even though provider callbacks are at-least-once." },
      { q: "What is intentionally out of scope?", a: "Building the email/SMS/push providers themselves." },
    ],
    deepDiveAngles: ["deduplication and retries", "provider failover", "per-user preference consistency", "burst scheduling"],
  };
}


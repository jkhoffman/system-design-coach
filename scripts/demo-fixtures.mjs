import { gradeReport } from "./mock-fixtures.mjs";

export const demoBrowserOptions = {
  candidateDelayMs: 1200,
  candidateText: "I will draw Client → API → Database. SQL gives us unique short codes; a key-value store would make scaling writes easier.",
  boardResponse: "I can see the Client, API, and Database. How will you handle duplicate short codes and a database outage?",
};

export function demoGrade() {
  const report = gradeReport();
  const evidence = {
    scoping: "Identified the core URL creation and redirect flow.",
    architecture: "Drew a clear Client → API → Database request path.",
    depth: "Chose unique short codes; retries and outages need a deeper discussion.",
    tradeoffs: "Compared SQL uniqueness with the write scalability of a key-value store.",
    communication: "Explained the diagram and the storage choice aloud.",
    pacing: "Reached an end-to-end design before discussing failure modes.",
  };
  return {
    ...report,
    overall: { score: 4, signal: "hire", summary: "Simulated scorecard: a clear core design and an explicit storage trade-off. Next, explore retries and database failures." },
    dimensions: report.dimensions.map((dimension) => ({ ...dimension, evidence: evidence[dimension.key], moments: [{ startMs: 2400, note: "Core flow and SQL trade-off" }] })),
    tradeoffAudit: [{ choice: "SQL uniqueness over a key-value store", alternativeStated: true, reasonStated: true, startMs: 2400 }],
    strengths: ["Connected the client, API, and persistent storage.", "Named an alternative to SQL and explained the trade-off."],
    strongHireWouldHave: ["Quantify redirect traffic, then examine retries and database failover."],
    drills: ["Explain how to prevent short-code collisions under concurrent writes."],
  };
}

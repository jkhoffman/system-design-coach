// Explicitly opt in: this makes two billable requests with synthetic content only.
import "./register-source.mjs";
if (!process.argv.includes("--live")) {
  console.log("Not run. Pass --live with OPENAI_API_KEY to probe both configured model schemas.");
  process.exit(0);
}
const { createOpenAIClient } = await import("../src/lib/openai.ts");
const { PROMPT_FORMAT, GRADE_FORMAT } = await import("../src/lib/modelFormats.ts");
const { PromptSpecSchema, GradeReportSchema } = await import("../src/lib/schemas.ts");
const client = createOpenAIClient();
for (const [model, format, schema, input] of [
  [process.env.PROMPT_GEN_MODEL ?? "gpt-5.6-terra", PROMPT_FORMAT, PromptSpecSchema.omit({ id: true }), "Create a short synthetic system design prompt for a URL shortener."],
  [process.env.GRADING_MODEL ?? "gpt-5.6-terra", GRADE_FORMAT, GradeReportSchema, "Return a synthetic practice scorecard with all six dimensions: scoping, architecture, depth, tradeoffs, communication, pacing. The candidate proposed a URL shortener with a SQL database and discussed collisions."],
]) {
  const result = await client.responses.create({ model, input, text: { format }, max_output_tokens: 2500 }, { maxRetries: 0, timeout: 120_000 });
  schema.parse(JSON.parse(result.output_text));
  console.log(`${format.name}: accepted and validated (${model})`);
}

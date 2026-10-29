import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./process.mjs";
import { parseReview, promptFor, schema } from "./protocol.mjs";

export async function reviewWith(reviewer, context) {
  const { id, provider, model } = reviewer;
  const label = `${id} (${provider}${model ? `: ${model}` : ""})`;
  const prefix = join(context.directory, `${context.round}-${id}`);
  const prompt = promptFor(reviewer, context);
  writeFileSync(`${prefix}.prompt.txt`, prompt, { mode: 0o600 });
  const answer = `${prefix}.answer.json`;
  const modelArgs = model ? ["--model", model] : [];
  const args = provider === "claude"
    ? ["--print", "--agent", "reviewer", "--permission-mode", "plan", "--permission-prompts", "none",
      "--output-format", "json", "--json-schema", JSON.stringify(schema), ...modelArgs]
    : ["--ask-for-approval", "never", "exec", "--cd", context.root, "--sandbox", "read-only",
      "--color", "never", "--output-schema", context.schemaPath, "--output-last-message", answer, ...modelArgs,
      ...(model ? ["--config", `agents.default_subagent_model=${JSON.stringify(model)}`] : []), "-"];
  console.log(`Round ${context.round}: ${label} is reviewing...`);
  const raw = await run(provider, args, {
    cwd: context.root, input: prompt, timeoutMs: context.timeoutMs, log: prefix, progress: true,
  });
  const result = provider === "claude" ? claudeOutput(raw) : readFileSync(answer, "utf8");
  const review = parseReview(result, context.revision);
  writeFileSync(`${prefix}.review.json`, JSON.stringify(review, null, 2), { mode: 0o600 });
  console.log(`${label}: ${review.verdict}\n${review.review}\n`);
  return { agent: id, provider, ...(model ? { model } : {}), round: context.round, ...review };
}

function claudeOutput(raw) {
  const envelope = JSON.parse(raw);
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new Error(`Claude failed: ${envelope.result ?? envelope.subtype ?? "unknown result"}`);
  }
  if (envelope.permission_denials?.length) throw new Error("Claude could not complete the review: tool permissions were denied");
  if (!envelope.structured_output) throw new Error("Claude did not return structured output");
  return JSON.stringify(envelope.structured_output);
}

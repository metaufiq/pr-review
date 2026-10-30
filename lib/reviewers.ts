import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./process.js";
import { parseReview, promptFor, schema } from "./protocol.js";
import { providerFor } from "./providers.js";
import type { ReviewContext, Reviewer, ReviewRecord } from "./types.js";

export async function reviewWith(reviewer: Reviewer, context: ReviewContext): Promise<ReviewRecord> {
  const { id, provider, model } = reviewer;
  const providerConfig = providerFor(provider);
  const label = `${id} (${provider}${model ? `: ${model}` : ""})`;
  const prefix = join(context.directory, `${context.round}-${id}`);
  const prompt = promptFor(reviewer, context);
  writeFileSync(`${prefix}.prompt.txt`, prompt, { mode: 0o600 });
  const answer = `${prefix}.answer.json`;
  const args = providerConfig.args({ model, root: context.root, schemaPath: context.schemaPath, answer, schema,
    role: context.role, checkout: context.checkout });
  console.log(`Round ${context.round}: ${label} is ${context.role === "fix" ? "checking the review and fixing code" : "reviewing the PR"}...`);
  const raw = await run(providerConfig.command, args, {
    cwd: context.root, input: prompt, timeoutMs: context.timeoutMs, log: prefix,
    progress: { label: `Round ${context.round}: ${label}`, formatLine: providerConfig.progress },
  });
  const result = providerConfig.output({ raw, answer });
  const review = parseReview(result, context.revision);
  writeFileSync(`${prefix}.review.json`, JSON.stringify(review, null, 2), { mode: 0o600 });
  console.log(`${label}: ${review.verdict}\n${review.review}\n`);
  return { agent: id, provider, ...(model ? { model } : {}), round: context.round, role: context.role, ...review };
}

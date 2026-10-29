import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./process.mjs";
import { parseReview, promptFor, schema } from "./protocol.mjs";
import { providerFor } from "./providers.mjs";

export async function reviewWith(reviewer, context) {
  const { id, provider, model } = reviewer;
  const providerConfig = providerFor(provider);
  const label = `${id} (${provider}${model ? `: ${model}` : ""})`;
  const prefix = join(context.directory, `${context.round}-${id}`);
  const prompt = promptFor(reviewer, context);
  writeFileSync(`${prefix}.prompt.txt`, prompt, { mode: 0o600 });
  const answer = `${prefix}.answer.json`;
  const args = providerConfig.args({ model, root: context.root, schemaPath: context.schemaPath, answer, schema });
  console.log(`Round ${context.round}: ${label} is reviewing...`);
  const raw = await run(providerConfig.command, args, {
    cwd: context.root, input: prompt, timeoutMs: context.timeoutMs, log: prefix, progress: true,
  });
  const result = providerConfig.output({ raw, answer });
  const review = parseReview(result, context.revision);
  writeFileSync(`${prefix}.review.json`, JSON.stringify(review, null, 2), { mode: 0o600 });
  console.log(`${label}: ${review.verdict}\n${review.review}\n`);
  return { agent: id, provider, ...(model ? { model } : {}), round: context.round, ...review };
}

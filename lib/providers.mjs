import { readFileSync } from "node:fs";

export const providers = {
  claude: {
    command: "claude",
    args: ({ model, schema }) => [
      "--print", "--permission-mode", "plan", "--permission-prompts", "none",
      "--output-format", "json", "--json-schema", JSON.stringify(schema),
      ...(model ? ["--model", model] : []),
    ],
    output: ({ raw }) => claudeOutput(raw),
  },
  codex: {
    command: "codex",
    args: ({ model, root, schemaPath, answer }) => [
      "--ask-for-approval", "never", "exec", "--cd", root, "--sandbox", "read-only",
      "--color", "never", "--output-schema", schemaPath, "--output-last-message", answer,
      ...(model ? ["--model", model, "--config", `agents.default_subagent_model=${JSON.stringify(model)}`] : []), "-",
    ],
    output: ({ answer }) => readFileSync(answer, "utf8"),
  },
};

export function providerFor(name) {
  if (typeof name !== "string" || !Object.hasOwn(providers, name)) {
    throw new Error(`Unsupported reviewer provider ${JSON.stringify(name)}. Supported providers: ${Object.keys(providers).join(", ")}`);
  }
  return providers[name];
}

function claudeOutput(raw) {
  const envelope = JSON.parse(raw);
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new Error(`Claude failed: ${envelope.result ?? envelope.subtype ?? "unknown result"}`);
  }
  if (envelope.permission_denials?.length) throw new Error("Claude could not complete the review: tool permissions were denied");
  if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
    return JSON.stringify(envelope.structured_output);
  }
  if (typeof envelope.result !== "string" || !envelope.result.trim()) {
    throw new Error("Claude did not return structured output or a JSON result");
  }
  const result = envelope.result.trim();
  const fenced = result.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1] : result;
}

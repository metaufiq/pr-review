import { readFileSync } from "node:fs";
import type { schema as reviewSchema } from "./protocol.js";
import type { ProviderName } from "./types.js";

interface ProviderArguments {
  model?: string;
  root: string;
  schemaPath: string;
  answer: string;
  schema: typeof reviewSchema;
}

interface Provider {
  command: string;
  args: (options: ProviderArguments) => string[];
  output: (options: { raw: string; answer: string }) => string;
}

interface ClaudeEnvelope {
  is_error?: boolean;
  subtype?: string;
  result?: unknown;
  permission_denials?: unknown[];
  structured_output?: unknown;
}

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
} satisfies Record<string, Provider>;

export function providerFor(name: string): Provider {
  if (typeof name !== "string" || !Object.hasOwn(providers, name)) {
    throw new Error(`Unsupported reviewer provider ${JSON.stringify(name)}. Supported providers: ${Object.keys(providers).join(", ")}`);
  }
  return providers[name as ProviderName];
}

function claudeOutput(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude returned an invalid response envelope");
  }
  const envelope = parsed as ClaudeEnvelope;
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

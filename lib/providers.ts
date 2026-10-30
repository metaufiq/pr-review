import { readFileSync } from "node:fs";
import type { schema as reviewSchema } from "./protocol.js";
import type { ProviderName, Role } from "./types.js";

interface ProviderArguments {
  model?: string;
  root: string;
  schemaPath: string;
  answer: string;
  schema: typeof reviewSchema;
  role: Role;
  checkout: string;
}

interface Provider {
  command: string;
  args: (options: ProviderArguments) => string[];
  output: (options: { raw: string; answer: string }) => string;
  progress?: (line: string) => string[];
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
    args: ({ model, schema, role, checkout }) => [
      "--print", "--permission-mode", role === "fix" ? "acceptEdits" : "plan", "--permission-prompts", "none",
      "--output-format", "stream-json", "--verbose", "--json-schema", JSON.stringify(schema),
      "--add-dir", checkout,
      ...(role === "fix" ? ["--allowedTools", "Bash"] : []),
      ...(model ? ["--model", model] : []),
    ],
    output: ({ raw }) => claudeOutput(raw),
    progress: claudeProgress,
  },
  codex: {
    command: "codex",
    args: ({ model, root, schemaPath, answer, role, checkout }) => [
      "--ask-for-approval", "never", "exec", "--cd", root, "--sandbox", role === "fix" ? "workspace-write" : "read-only",
      ...(role === "fix" ? ["--add-dir", checkout, "--config", "sandbox_workspace_write.network_access=true"] : []),
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
  let envelope: ClaudeEnvelope | undefined;
  for (const line of raw.split(/\r?\n/).filter((line) => line.trim())) {
    const event = object(JSON.parse(line));
    if (!event) throw new Error("Claude returned an invalid response envelope");
    if (event.type === "result") envelope = event;
  }
  if (!envelope) throw new Error("Claude stream ended without a final result");
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

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function claudeProgress(line: string): string[] {
  let event: Record<string, unknown> | undefined;
  try { event = object(JSON.parse(line)); } catch { return []; }
  if (!event) return [];
  if (event.type === "system" && event.subtype === "init") return ["Session started."];
  if (event.type === "result") return ["Review response received."];
  const content = object(event.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((value: unknown) => {
    const block = object(value);
    if (event.type === "assistant" && block?.type === "tool_use" && typeof block.name === "string") {
      const name = block.name.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 100);
      return [`Using ${name}.`];
    }
    if (event.type === "user" && block?.type === "tool_result") {
      return [block.is_error ? "Tool reported an error." : "Tool completed."];
    }
    return [];
  });
}

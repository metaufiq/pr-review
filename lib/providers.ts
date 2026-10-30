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
      "--json", "--color", "never", "--output-schema", schemaPath, "--output-last-message", answer,
      ...(model ? ["--model", model, "--config", `agents.default_subagent_model=${JSON.stringify(model)}`] : []), "-",
    ],
    output: ({ answer }) => readFileSync(answer, "utf8"),
    progress: codexProgress,
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
  const event = progressEvent(line);
  if (!event) return [];
  if (event.type === "system" && event.subtype === "init") return ["Session started."];
  if (event.type === "result") return ["Review response received."];
  const content = object(event.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((value: unknown) => {
    const block = object(value);
    if (event.type === "assistant" && block?.type === "tool_use" && typeof block.name === "string") {
      const name = display(block.name).slice(0, 100);
      const command = object(block.input)?.command;
      if (block.name === "Bash" && typeof command === "string") return [`Bash: ${display(command)}`];
      return [`Using ${name}.`];
    }
    if (event.type === "user" && block?.type === "tool_result") {
      return [block.is_error ? "Tool reported an error." : "Tool completed."];
    }
    return [];
  });
}

function codexProgress(line: string): string[] {
  const event = progressEvent(line);
  if (!event) return [];
  if (event.type === "thread.started") return ["Session started."];
  if (event.type === "turn.completed") return ["Review response received."];
  if (event.type === "turn.failed") return [errorMessage("Review failed", object(event.error)?.message)];
  if (event.type === "error") return [errorMessage("CLI error", event.message)];
  const started = event.type === "item.started";
  const completed = event.type === "item.completed";
  const item = object(event.item);
  if (!item || (!started && !completed)) return [];
  if (item.type === "command_execution") {
    if (started) return [typeof item.command === "string" ? `Command: ${display(item.command)}` : "Running command."];
    const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
    const exit = typeof item.exit_code === "number" ? ` (exit ${item.exit_code})` : "";
    return [`Command ${failed ? "failed" : "completed"}${exit}.`];
  }
  if (item.type === "mcp_tool_call") {
    if (started) {
      const name = [item.server, item.tool].filter((value) => typeof value === "string").join(".");
      return [name ? `Using ${display(name)}.` : "Using tool."];
    }
    return [item.status === "failed" || item.error ? "Tool reported an error." : "Tool completed."];
  }
  if (item.type === "file_change" && completed) {
    if (item.status === "failed") return ["File update failed."];
    const paths = Array.isArray(item.changes) ? item.changes.flatMap((change: unknown) => {
      const path = object(change)?.path;
      return typeof path === "string" ? [display(path)] : [];
    }) : [];
    return [paths.length ? `Files updated: ${paths.join(", ")}.` : "Files updated."];
  }
  if (item.type === "web_search") {
    if (completed) return ["Web search completed."];
    return [typeof item.query === "string" ? `Searching web: ${display(item.query)}` : "Searching web."];
  }
  if (item.type === "error" && completed) return [errorMessage("Tool error", item.message)];
  return [];
}

function progressEvent(line: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(line)); } catch { return undefined; }
}

function errorMessage(label: string, message: unknown): string {
  return typeof message === "string" ? `${label}: ${display(message)}` : `${label}.`;
}

// Keep each event on one terminal line without interpreting command control characters.
function display(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../lib/process.js";
import { providerFor } from "../lib/providers.js";

for (const provider of ["claude", "codex"] as const) {
  test(`displays chunked ${provider} commands before exit and preserves the final result and raw log`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "pr-review-stream-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const release = join(directory, "release");
    const log = join(directory, provider);
    const answer = join(directory, "answer.json");
    const review = { head_sha: "a".repeat(40), base_sha: "b".repeat(40), verdict: "approve", review: "Verified", blockers: [] };
    const command = "printf 'café'\nprintf '%s' '$HOME'";
    const events = provider === "claude" ? [{ type: "assistant", message: { content: [
      { type: "tool_use", name: "Bash", input: { command, secret: "do not display other tool inputs" } },
      { type: "thinking", thinking: "do not display thinking" },
      { type: "text", text: "do not display commentary" },
    ] } }] : [
      { type: "item.completed", item: { type: "reasoning", text: "do not display thinking" } },
      { type: "item.completed", item: { type: "agent_message", text: "do not display commentary" } },
      { type: "item.started", item: { type: "command_execution", command, status: "in_progress" } },
      { type: "item.updated", item: { type: "command_execution", command, aggregated_output: "do not display command output" } },
    ];
    const activity = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    const result = JSON.stringify(provider === "claude"
      ? { type: "result", subtype: "success", structured_output: review } : { type: "turn.completed", usage: {} });
    const messages: string[] = [];
    let finished = false;
    const child = run(process.execPath, ["-e", `
      const { existsSync, writeFileSync } = require("node:fs");
      const data = Buffer.from(${JSON.stringify(activity)});
      const split = data.indexOf(Buffer.from("é")) + 1;
      process.stdout.write(data.subarray(0, split));
      setTimeout(() => process.stdout.write(data.subarray(split)), 20);
      const poll = setInterval(() => {
        if (existsSync(${JSON.stringify(release)})) {
          clearInterval(poll);
          writeFileSync(${JSON.stringify(answer)}, ${JSON.stringify(JSON.stringify(review))});
          process.stdout.write(${JSON.stringify(result)});
        }
      }, 10);
    `], { cwd: directory, log, timeoutMs: 3000,
      progress: { label: `Round 1: reviewer-1 (${provider})`, formatLine: providerFor(provider).progress } });
    const observed = new Promise<void>((resolve) => {
      t.mock.method(process.stderr, "write", (chunk: unknown) => {
        const message = String(chunk);
        messages.push(message);
        if (message.includes("printf 'café'")) {
          assert.equal(finished, false);
          writeFileSync(release, "");
          resolve();
        }
        return true;
      });
    });
    const raw = await child;
    finished = true;
    await observed;
    assert.equal(raw, activity + result);
    assert.equal(readFileSync(`${log}.stdout.log`, "utf8"), raw);
    assert.deepEqual(JSON.parse(providerFor(provider).output({ raw, answer })), review);
    assert.ok(messages.includes(`[Round 1: reviewer-1 (${provider})] ${provider === "claude" ? "Bash" : "Command"}: printf 'café'\\nprintf '%s' '$HOME'\n`));
    assert.match(messages.join(""), /Review response received\./);
    assert.doesNotMatch(messages.join(""), /do not display|structured_output/);
  });
}

test("stays silent without heartbeats and still terminates a hung CLI on timeout", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pr-review-silent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const messages: string[] = [];
  const intervals = t.mock.method(globalThis, "setInterval");
  t.mock.method(process.stderr, "write", (chunk: unknown) => { messages.push(String(chunk)); return true; });
  const child = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: directory, log: join(directory, "silent"), timeoutMs: 150,
    progress: { label: "Round 2: reviewer-2 (codex)" },
  });
  await assert.rejects(child, /timed out/);
  assert.equal(intervals.mock.callCount(), 0);
  assert.deepEqual(messages, []);
});

test("formats provider tool events and errors without displaying narration or terminal controls", () => {
  const claude = (event: unknown) => providerFor("claude").progress!(JSON.stringify(event));
  const codex = (event: unknown) => providerFor("codex").progress!(JSON.stringify(event));
  assert.deepEqual(claude({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Réader", input: { secret: "hidden" } },
    { type: "tool_use", name: "Bash", input: { command: "printf '\u001b[2J'\r\n\tend\u009b" } },
  ] } }), ["Using Réader.", "Bash: printf '\\u001b[2J'\\r\\n\\tend\\u009b"]);
  assert.deepEqual(claude({ type: "user", message: { content: [{ type: "tool_result", is_error: true }] } }), ["Tool reported an error."]);
  assert.deepEqual(codex({ type: "item.started", item: { type: "mcp_tool_call", server: "github", tool: "read_pr", arguments: { secret: "hidden" } } }), ["Using github.read_pr."]);
  assert.deepEqual(codex({ type: "item.completed", item: { type: "mcp_tool_call", status: "completed", result: { secret: "hidden" } } }), ["Tool completed."]);
  assert.deepEqual(codex({ type: "item.completed", item: { type: "mcp_tool_call", status: "failed" } }), ["Tool reported an error."]);
  assert.deepEqual(codex({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 1, aggregated_output: "hidden" } }), ["Command failed (exit 1)."]);
  assert.deepEqual(codex({ type: "item.completed", item: { type: "command_execution", status: "failed" } }), ["Command failed."]);
  assert.deepEqual(codex({ type: "item.completed", item: { type: "file_change", status: "completed", changes: [{ path: "lib/example.ts", kind: "update" }] } }), ["Files updated: lib/example.ts."]);
  assert.deepEqual(codex({ type: "item.completed", item: { type: "file_change", status: "failed" } }), ["File update failed."]);
  assert.deepEqual(codex({ type: "item.started", item: { type: "web_search", query: "CLI documentation" } }), ["Searching web: CLI documentation"]);
  assert.deepEqual(codex({ type: "item.completed", item: { type: "web_search" } }), ["Web search completed."]);
  assert.deepEqual(codex({ type: "turn.failed", error: { message: "Authentication failed\nRetry" } }), ["Review failed: Authentication failed\\nRetry"]);
  assert.deepEqual(codex({ type: "error", message: "Stream disconnected" }), ["CLI error: Stream disconnected"]);
  for (const provider of ["claude", "codex"] as const) {
    const progress = providerFor(provider).progress!;
    for (const line of ["not JSON", "null", "[]", "{}", '{"type":"future_event"}']) assert.deepEqual(progress(line), []);
  }
});

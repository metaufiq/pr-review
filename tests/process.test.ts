import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { run } from "../lib/process.js";
import { providerFor } from "../lib/providers.js";

test("displays chunked Claude activity before exit and preserves the final result and raw log", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pr-review-stream-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const release = join(directory, "release");
  const log = join(directory, "claude");
  const review = { head_sha: "a".repeat(40), base_sha: "b".repeat(40), verdict: "approve", review: "Verified", blockers: [] };
  const activity = JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Réader", input: { secret: "do not display tool inputs" } },
    { type: "thinking", thinking: "do not display thinking" },
  ] } }) + "\n";
  const result = JSON.stringify({ type: "result", subtype: "success", structured_output: review });
  const messages: string[] = [];
  let finished = false;
  const child = run(process.execPath, ["-e", `
    const { existsSync } = require("node:fs");
    const data = Buffer.from(${JSON.stringify(activity)});
    const split = data.indexOf(Buffer.from("é")) + 1;
    process.stdout.write(data.subarray(0, split));
    setTimeout(() => process.stdout.write(data.subarray(split)), 20);
    const poll = setInterval(() => {
      if (existsSync(${JSON.stringify(release)})) {
        clearInterval(poll);
        process.stdout.write(${JSON.stringify(result)});
      }
    }, 10);
  `], { cwd: directory, log, timeoutMs: 3000,
    progress: { label: "Round 1: reviewer-1 (claude)", formatLine: providerFor("claude").progress } });
  const observed = new Promise<void>((resolve) => {
    t.mock.method(process.stderr, "write", (chunk: unknown) => {
      const message = String(chunk);
      messages.push(message);
      if (message.includes("Using Réader.")) {
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
  assert.deepEqual(JSON.parse(providerFor("claude").output({ raw, answer: "" })), review);
  assert.match(messages.join(""), /Using Réader\./);
  assert.match(messages.join(""), /Review response received\./);
  assert.doesNotMatch(messages.join(""), /do not display|structured_output/);
});

test("emits heartbeats while a CLI is silent and stops them after timeout", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pr-review-heartbeat-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const messages: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => { messages.push(String(chunk)); return true; });
  await assert.rejects(run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: directory, log: join(directory, "silent"), timeoutMs: 150,
    progress: { label: "Round 2: reviewer-2 (codex)", intervalMs: 20 },
  }), /timed out/);
  assert.ok(messages.length > 0);
  assert.match(messages[0], /\[Round 2: reviewer-2 \(codex\)\] Still running; elapsed \d+s; last output \d+s ago; timeout in \d+s\./);
  const count = messages.length;
  await delay(60);
  assert.equal(messages.length, count);
});

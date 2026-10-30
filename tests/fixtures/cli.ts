#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import type { FixtureState, Scenario, ToolName } from "./types.js";

const tool = basename(process.argv[1]) as ToolName;
const args = process.argv.slice(2);
const input = readFileSync(0, "utf8");
if (!process.env.REVIEW_TEST_SCENARIO || !process.env.REVIEW_TEST_STATE) {
  throw new Error("Missing CLI test scenario or state path");
}
const scenario: Scenario = JSON.parse(process.env.REVIEW_TEST_SCENARIO);
const statePath = process.env.REVIEW_TEST_STATE;
const state: FixtureState = JSON.parse(readFileSync(statePath, "utf8"));
const index = state.calls.filter((call) => call.tool === tool).length;
const checkout = input.match(/dedicated checkout is (.+)\. Inspect the source there\./)?.[1];
const source = checkout && existsSync(join(checkout, "example.js")) ? readFileSync(join(checkout, "example.js"), "utf8") : undefined;
state.calls.push({ tool, args, input, cwd: process.cwd(), ...(source === undefined ? {} : { source }) });
writeFileSync(statePath, JSON.stringify(state));

function realGit(args: string[], cwd = process.cwd()): string {
  const result = spawnSync(process.env.REVIEW_TEST_GIT!, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

if (scenario.interrupt === tool) {
  process.kill(process.ppid, "SIGINT");
  setInterval(() => {}, 1000);
} else if (scenario.hang === tool) {
  setInterval(() => {}, 1000);
} else if (scenario.fail === tool) {
  console.error("Authentication failed");
  process.exitCode = 7;
} else if (tool === "gh") {
  if (args[0] === "repo" && args[1] === "clone") {
    if (scenario.realGit) realGit(["clone", "--no-checkout", process.env.REVIEW_TEST_LOCAL_REPOSITORY!, args[3]]);
    else {
      mkdirSync(args[3], { recursive: true });
      writeFileSync(join(args[3], "example.js"), "original code\n");
    }
  }
  else if (args[1] === "diff") console.log("diff --git a/example.js b/example.js\n+changed code");
  else {
    const count = state.calls.filter((call) => call.tool === "gh" && call.args[1] === "view").length - 1;
    const revisions = scenario.revisions ?? [{}];
    const revision = revisions[Math.min(count, revisions.length - 1)];
    const remote = process.env.REVIEW_TEST_LOCAL_REPOSITORY;
    const head = scenario.realGit ? realGit(["--git-dir", remote!, "rev-parse", "refs/heads/fixes"]).trim()
      : state.remoteHead ?? "a".repeat(40);
    console.log(JSON.stringify({ headRefOid: head, baseRefOid: process.env.REVIEW_TEST_INITIAL_HEAD ?? "b".repeat(40),
      state: "OPEN", headRefName: "fixes", headRepository: { nameWithOwner: "owner/repo" }, ...revision }));
  }
} else if (tool === "git") {
  if (scenario.gitFailure === args[0]) {
    console.error(`git ${args[0]} failed`);
    process.exitCode = 1;
  } else if (scenario.realGit) {
    if (args[0] === "push" && scenario.concurrentPush) {
      const otherCheckout = process.env.REVIEW_TEST_ORIGINAL_CHECKOUT!;
      writeFileSync(join(otherCheckout, "example.js"), "concurrent code\n");
      realGit(["add", "--all"], otherCheckout);
      realGit(["commit", "-m", "Concurrent update"], otherCheckout);
      realGit(["push", process.env.REVIEW_TEST_LOCAL_REPOSITORY!, "HEAD:refs/heads/fixes"], otherCheckout);
    }
    process.stdout.write(realGit(args));
  }
  else if (args[0] === "checkout") state.head = args.at(-1);
  else if (args[0] === "rev-parse") console.log(args[1] === "HEAD^" ? state.parent : state.head);
  else if (args[0] === "status") console.log(state.dirty ? " M example.js" : "");
  else if (args[0] === "commit") {
    state.parent = state.head;
    state.commits = (state.commits ?? 0) + 1;
    state.head = (11 + state.commits).toString(16).padStart(40, "0");
    state.dirty = false;
  } else if (args[0] === "push") state.remoteHead = args[2].split(":")[0];
} else {
  const fixing = input.includes("Your role is implementer:");
  const fixIndex = state.calls.filter((call) => call.input.includes("Your role is implementer:")).length - 1;
  const edit = fixing ? scenario.fixes?.[fixIndex] : scenario.reviewEdits ? "unexpected reviewer edit" : undefined;
  if (edit !== undefined && edit !== null) {
    if (!checkout) throw new Error("Fix prompt did not identify a checkout");
    writeFileSync(join(checkout, "example.js"), edit);
    if (scenario.newTestFile) writeFileSync(join(checkout, "example.test.js"), "regression coverage\n");
    state.dirty = true;
  }
  if (fixing && scenario.changeHead) state.head = "e".repeat(40);
  const configured = scenario[tool] ?? [{}];
  const entry = configured[Math.min(index, configured.length - 1)];
  const commits = input.match(/Review head ([a-f0-9]{40}) against base ([a-f0-9]{40})/);
  if (!commits) throw new Error("Review prompt did not identify the head and base commits");
  const review = { head_sha: commits[1], base_sha: commits[2], verdict: "approve", blockers: [],
    review: `${tool} full review ${index + 1}: verified`, ...entry };
  const raw = scenario.malformed === tool ? "not JSON" : JSON.stringify(review);
  if (tool === "claude") {
    const envelope: Record<string, unknown> = {
      type: "result", subtype: scenario.claudeError ? "error_max_turns" : "success", is_error: !!scenario.claudeError,
      permission_denials: scenario.denied ? [{}] : [], structured_output: review,
    };
    if (scenario.claudeFormat) {
      delete envelope.structured_output;
      envelope.result = scenario.claudeFormat === "json" ? raw
        : `\`\`\`${scenario.claudeFormat === "unlabeled" ? "" : "json"}\n${raw}\n\`\`\``;
      envelope.result = ` \n${envelope.result}\n `;
    }
    const events = scenario.claudeEvents ?? [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "example.js" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "original code" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git diff --stat" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "diff summary" }] } },
    ];
    for (const event of events) console.log(JSON.stringify(event));
    if (!scenario.missingClaudeResult) {
      console.log(scenario.malformed === tool ? raw : JSON.stringify({ ...envelope, ...scenario.claudeEnvelope }));
    }
  }
  else {
    const events = [
      { type: "thread.started", thread_id: "test-thread" },
      { type: "item.completed", item: { type: "reasoning", text: "private reasoning" } },
      { type: "item.completed", item: { type: "agent_message", text: "agent commentary" } },
      { type: "item.started", item: { id: "command-1", type: "command_execution", command: "git diff --stat", status: "in_progress" } },
      { type: "item.completed", item: { id: "command-1", type: "command_execution", command: "git diff --stat", status: "completed", exit_code: 0, aggregated_output: "diff summary" } },
      { type: "turn.completed", usage: {} },
    ];
    for (const event of events) console.log(JSON.stringify(event));
    if (!scenario.missingAnswer) writeFileSync(args[args.indexOf("--output-last-message") + 1], raw);
  }
}
if (scenario.interrupt !== tool && scenario.hang !== tool) writeFileSync(statePath, JSON.stringify(state));

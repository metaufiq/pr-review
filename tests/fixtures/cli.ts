#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
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
state.calls.push({ tool, args, input, cwd: process.cwd() });
writeFileSync(statePath, JSON.stringify(state));

if (scenario.interrupt === tool) {
  process.kill(process.ppid, "SIGINT");
  setInterval(() => {}, 1000);
} else if (scenario.hang === tool) {
  setInterval(() => {}, 1000);
} else if (scenario.fail === tool) {
  console.error("Authentication failed");
  process.exitCode = 7;
} else if (tool === "gh") {
  if (args[1] === "diff") console.log("diff --git a/example.js b/example.js\n+changed code");
  else {
    const count = state.calls.filter((call) => call.tool === "gh" && call.args[1] === "view").length - 1;
    const revisions = scenario.revisions ?? [{}];
    const revision = revisions[Math.min(count, revisions.length - 1)];
    console.log(JSON.stringify({ headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), state: "OPEN", ...revision }));
  }
} else {
  const configured = scenario[tool] ?? [{}];
  const entry = configured[Math.min(index, configured.length - 1)];
  const commits = input.match(/Review head ([a-f0-9]{40}) against base ([a-f0-9]{40})/);
  if (!commits) throw new Error("Review prompt did not identify the head and base commits");
  const review = { head_sha: commits[1], base_sha: commits[2], verdict: "approve", blockers: [],
    review: `${tool} full review ${index + 1}: verified`, ...entry };
  const raw = scenario.malformed === tool ? "not JSON" : JSON.stringify(review);
  if (tool === "claude") {
    const envelope: Record<string, unknown> = {
      subtype: scenario.claudeError ? "error_max_turns" : "success", is_error: !!scenario.claudeError,
      permission_denials: scenario.denied ? [{}] : [], structured_output: review,
    };
    if (scenario.claudeFormat) {
      delete envelope.structured_output;
      envelope.result = scenario.claudeFormat === "json" ? raw
        : `\`\`\`${scenario.claudeFormat === "unlabeled" ? "" : "json"}\n${raw}\n\`\`\``;
      envelope.result = ` \n${envelope.result}\n `;
    }
    console.log(scenario.malformed === tool ? raw : JSON.stringify({ ...envelope, ...scenario.claudeEnvelope }));
  }
  else if (!scenario.missingAnswer) writeFileSync(args[args.indexOf("--output-last-message") + 1], raw);
}

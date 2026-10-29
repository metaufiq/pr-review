import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..");
const url = "https://github.com/owner/repo/pull/123";
const changes = { verdict: "request_changes", blockers: ["Required fix"], review: "Do not approve; needs a required fix" };

function runReview(scenario, args = [], options = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "pr-review-test-"));
  const workspace = join(temporary, options.override ? "custom-workspace" : "dev");
  const toolRepository = join(temporary, "pr-review");
  const caller = join(temporary, "elsewhere");
  mkdirSync(caller);
  const bin = join(temporary, "cli-bin");
  mkdirSync(bin);
  cpSync(join(repository, "bin"), join(toolRepository, "bin"), { recursive: true });
  cpSync(join(repository, "lib"), join(toolRepository, "lib"), { recursive: true });
  const paths = { workspace, toolRepository, temporary };
  if (options.dotenv) writeFileSync(join(toolRepository, ".env"), options.dotenv(paths));
  for (const adapter of options.adapters ?? [".claude/agents/reviewer.md", ".codex/agents/reviewer.toml"]) {
    mkdirSync(dirname(join(workspace, adapter)), { recursive: true });
    writeFileSync(join(workspace, adapter), "test reviewer");
  }
  const fixture = join(bin, "cli.cjs");
  const source = readFileSync(join(here, "fixtures", "cli.cjs"), "utf8");
  writeFileSync(fixture, source.replace("#!/usr/bin/env node", `#!${process.execPath}`));
  chmodSync(fixture, 0o755);
  for (const tool of ["gh", "claude", "codex"]) symlinkSync(fixture, join(bin, tool));
  const statePath = join(temporary, "state.json");
  writeFileSync(statePath, '{"calls":[]}');
  try {
    const workspaceArgs = options.override === "flag" ? ["--dev-dir", workspace] : [];
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PR_REVIEW_")));
    const result = spawnSync(process.execPath, [join(toolRepository, "bin", "review-pr.mjs"), url, ...workspaceArgs, ...args], {
      cwd: caller, encoding: "utf8", timeout: 15000,
      env: { ...environment, PATH: `${bin}:${process.env.PATH}`, REVIEW_TEST_STATE: statePath,
        REVIEW_TEST_SCENARIO: JSON.stringify(scenario),
        ...(options.override === "environment" ? { PR_REVIEW_DEV_DIR: workspace } : {}),
        ...(options.override === "flag" ? { PR_REVIEW_DEV_DIR: join(temporary, "wrong-workspace") } : {}),
        ...options.environment?.(paths) },
    });
    assert.ifError(result.error);
    assert.equal(existsSync(join(toolRepository, "sessions")), false);
    const reports = options.reports ? options.reports(paths) : join(workspace, "sessions", "pr-reviews");
    const directory = existsSync(reports) ? readdirSync(reports)[0] : undefined;
    return { ...result, workspace: realpathSync(workspace), calls: JSON.parse(readFileSync(statePath, "utf8")).calls,
      reports, files: directory ? readdirSync(join(reports, directory)) : [],
      summary: directory ? JSON.parse(readFileSync(join(reports, directory, "summary.json"), "utf8")) : undefined };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("runs configured reviewers from dev and passes Claude's full review through stdin", () => {
  const fullReview = 'Optional nit: "quote" and $(touch /tmp/do-not-run) are review text';
  const result = runReview({ claude: [{ verdict: "approve_with_nits", review: fullReview }] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.status, "approved");
  assert.equal(result.summary.round, 1);
  assert.ok(result.calls.every((call) => call.cwd === result.workspace));
  const agents = result.calls.filter((call) => call.tool !== "gh");
  assert.deepEqual(agents.map((call) => call.tool), ["claude", "codex"]);
  assert.ok(agents[0].args.includes("reviewer"));
  assert.ok(agents[0].args.includes("plan"));
  assert.ok(agents[1].args.includes("read-only"));
  assert.equal(agents[1].args[agents[1].args.indexOf("--cd") + 1], result.workspace);
  assert.ok(agents.every((call) => call.input.includes(result.workspace)));
  assert.ok(agents[1].input.includes(JSON.stringify(fullReview)));
  assert.ok(agents[1].input.includes("configured reviewer agent"));
  assert.match(agents[1].input, /1-pr\.diff/);
});

test("feeds Codex's disagreement back to Claude and continues until both approve", () => {
  const result = runReview({ claude: [changes, {}], codex: [{ review: "Claude's finding is disproven at example.js:10" }, {}] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.round, 2);
  const claudeCalls = result.calls.filter((call) => call.tool === "claude");
  assert.match(claudeCalls[1].input, /finding is disproven/);
  assert.equal(result.summary.reviews.length, 4);
});

test("never treats approval words in a blocking review as consensus", () => {
  const result = runReview({ claude: [changes], codex: [changes] }, ["--max-rounds", "2"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.summary.status, "no_consensus");
  assert.equal(result.calls.filter((call) => call.tool === "codex").length, 2);
});

for (const field of ["headRefOid", "baseRefOid"]) {
  test(`discards approvals when ${field} changes after Codex and reviews the new revision`, () => {
    const revision = { [field]: "c".repeat(40) };
    const result = runReview({ revisions: [{}, {}, {}, revision] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary.round, 2);
    assert.equal(result.summary.reviews.length, 2);
    const claudeCalls = result.calls.filter((call) => call.tool === "claude");
    assert.match(claudeCalls[1].input, /either reviewer\):\n\[\]/);
    assert.equal(result.summary.revision[field], revision[field]);
  });
}

test("restarts before invoking Codex if the head changes during Claude's review", () => {
  const result = runReview({ revisions: [{}, {}, { headRefOid: "c".repeat(40) }] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.filter((call) => call.tool === "codex").length, 1);
  assert.equal(result.summary.round, 2);
});

const failures = [
  ["malformed Claude output", { malformed: "claude" }],
  ["malformed Codex output", { malformed: "codex" }],
  ["missing Codex final output", { missingAnswer: true }],
  ["Claude internal error", { claudeError: true }],
  ["Claude permission denial", { denied: true }],
  ["approval with blockers", { claude: [{ blockers: ["Still required"] }] }],
  ["rejection without blockers", { codex: [{ verdict: "request_changes" }] }],
  ["review of another commit", { claude: [{ head_sha: "d".repeat(40) }] }],
  ["unauthenticated GitHub", { fail: "gh" }],
  ["reviewer command failure", { fail: "claude" }],
  ["closed PR", { revisions: [{ state: "CLOSED" }] }],
];
for (const [name, scenario] of failures) {
  test(`fails closed on ${name}`, () => {
    const result = runReview(scenario);
    assert.equal(result.status, 1);
    assert.equal(result.summary.status, "error");
    assert.ok(result.summary.error);
  });
}

test("terminates a hung reviewer on timeout and records the failure", () => {
  const result = runReview({ hang: "claude" }, ["--timeout-seconds", "1"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /claude timed out/);
  assert.equal(result.calls.filter((call) => call.tool === "codex").length, 0);
});

test("interrupts the active reviewer and exits without launching Codex", () => {
  const result = runReview({ interrupt: "claude" });
  assert.equal(result.status, 130);
  assert.match(result.stderr, /Interrupted/);
  assert.equal(result.calls.filter((call) => call.tool === "codex").length, 0);
});

test("help and invalid arguments need no CLI authentication", () => {
  for (const [args, expected] of [[["--help"], 0], [[url, "--max-rounds", "0"], 1], [["not-a-pr"], 1]]) {
    const result = spawnSync(process.execPath, [join(repository, "bin", "review-pr.mjs"), ...args], { encoding: "utf8" });
    assert.equal(result.status, expected);
  }
});

for (const override of ["flag", "environment"]) {
  test(`runs reviewers in the workspace selected by ${override}`, () => {
    const result = runReview({}, [], { override });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.calls.every((call) => call.cwd === result.workspace));
    assert.match(result.workspace, /custom-workspace$/);
  });
}

test("loads workspace, reports, reviewer order, and models from the repository .env", () => {
  const reviewers = [{ provider: "codex", model: "codex-test-model" }, { provider: "claude", model: "sonnet" }];
  const result = runReview({}, [], {
    override: "dotenv",
    dotenv: () => `PR_REVIEW_DEV_DIR=../custom-workspace\nPR_REVIEW_REPORTS_DIR=../review-reports\nPR_REVIEW_REVIEWERS='${JSON.stringify(reviewers)}'\n`,
    reports: ({ temporary }) => join(temporary, "review-reports"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.every((call) => call.cwd === result.workspace));
  const agents = result.calls.filter((call) => call.tool !== "gh");
  assert.deepEqual(agents.map((call) => call.tool), ["codex", "claude"]);
  assert.deepEqual(agents.map((call) => call.args[call.args.indexOf("--model") + 1]), reviewers.map((reviewer) => reviewer.model));
  assert.ok(agents[0].args.includes('agents.default_subagent_model="codex-test-model"'));
  assert.match(agents[0].input, /including any delegated reviewer/);
  assert.match(agents[1].input, /codex full review/);
  assert.equal(result.summary.reviewers[0].model, "codex-test-model");
  assert.equal(result.summary.reviews[1].model, "sonnet");
});

test("exported variables override .env and --dev-dir overrides both", () => {
  const result = runReview({}, [], {
    override: "flag",
    dotenv: () => 'PR_REVIEW_DEV_DIR=../incorrect\nPR_REVIEW_REPORTS_DIR=../incorrect-reports\nPR_REVIEW_REVIEWERS=invalid\n',
    environment: ({ temporary }) => ({
      PR_REVIEW_DEV_DIR: join(temporary, "incorrect-export"),
      PR_REVIEW_REPORTS_DIR: join(temporary, "exported-reports"),
      PR_REVIEW_REVIEWERS: '[{"provider":"claude"},{"provider":"codex"}]',
    }),
    reports: ({ temporary }) => join(temporary, "exported-reports"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.every((call) => call.cwd === result.workspace));
  assert.ok(result.calls.filter((call) => call.tool !== "gh").every((call) => !call.args.includes("--model")));
});

for (const provider of ["claude", "codex"]) {
  test(`runs two ${provider} models without requiring the other adapter or overwriting reviews`, () => {
    const result = runReview({ [provider]: [changes, {}, {}, {}] }, [], {
      environment: () => ({ PR_REVIEW_REVIEWERS: JSON.stringify([
        { provider, model: "model-one" }, { provider, model: "model-two" },
      ]) }),
      adapters: [provider === "claude" ? ".claude/agents/reviewer.md" : ".codex/agents/reviewer.toml"],
    });
    assert.equal(result.status, 0, result.stderr);
    const agents = result.calls.filter((call) => call.tool !== "gh");
    assert.deepEqual(agents.map((call) => call.tool), Array(4).fill(provider));
    assert.deepEqual(result.summary.reviews.map((review) => review.agent), ["reviewer-1", "reviewer-2", "reviewer-1", "reviewer-2"]);
    assert.match(agents[1].input, /needs a required fix/);
    assert.match(agents[2].input, /full review 2/);
    assert.ok(result.files.includes("1-reviewer-1.review.json"));
    assert.ok(result.files.includes("1-reviewer-2.review.json"));
  });
}

for (const value of ["invalid", "[]", '[{"provider":"claude"}]', '[{"provider":"gemini"},{"provider":"codex"}]',
  '[{"provider":"claude","model":" "},{"provider":"codex"}]', '[{"provider":"claude","model":5},{"provider":"codex"}]',
  '[{"provider":"claude","modle":"opus"},{"provider":"codex"}]', '[null,{"provider":"codex"}]']) {
  test(`rejects invalid reviewer configuration before invoking CLIs: ${value}`, () => {
    const result = runReview({}, [], { environment: () => ({ PR_REVIEW_REVIEWERS: value }) });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.calls.length, 0);
    assert.match(result.stderr, /PR_REVIEW_REVIEWERS|reviewer model/);
  });
}

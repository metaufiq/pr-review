import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { FixtureState, Scenario, Summary } from "./fixtures/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..");
const url = "https://github.com/owner/repo/pull/123";
const changes = { verdict: "request_changes" as const, blockers: ["Required fix"], review: "Do not approve; needs a required fix" };

interface TestPaths {
  workspace: string;
  toolRepository: string;
  temporary: string;
}

interface TestOptions {
  override?: "flag" | "environment" | "dotenv";
  dotenv?: (paths: TestPaths) => string;
  environment?: (paths: TestPaths) => NodeJS.ProcessEnv;
  reports?: (paths: TestPaths) => string;
}

function runReview(scenario: Scenario, args: string[] = [], options: TestOptions = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "pr-review-test-"));
  const workspace = join(temporary, options.override ? "custom-workspace" : "dev");
  mkdirSync(workspace);
  const toolRepository = join(temporary, "pr-review");
  const caller = join(temporary, "elsewhere");
  mkdirSync(caller);
  const bin = join(temporary, "cli-bin");
  mkdirSync(bin);
  cpSync(join(repository, "bin"), join(toolRepository, "dist", "bin"), { recursive: true });
  cpSync(join(repository, "lib"), join(toolRepository, "dist", "lib"), { recursive: true });
  writeFileSync(join(toolRepository, "package.json"), '{"type":"module"}');
  const paths = { workspace, toolRepository, temporary };
  if (options.dotenv) writeFileSync(join(toolRepository, ".env"), options.dotenv(paths));
  const fixture = join(bin, "cli.mjs");
  const source = readFileSync(join(here, "fixtures", "cli.js"), "utf8");
  writeFileSync(fixture, source.replace("#!/usr/bin/env node", `#!${process.execPath}`));
  chmodSync(fixture, 0o755);
  for (const tool of ["gh", "claude", "codex", "git"]) symlinkSync(fixture, join(bin, tool));
  const statePath = join(temporary, "state.json");
  writeFileSync(statePath, '{"calls":[]}');
  const gitEnvironment: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: "Review test", GIT_AUTHOR_EMAIL: "review@example.com",
    GIT_COMMITTER_NAME: "Review test", GIT_COMMITTER_EMAIL: "review@example.com",
  };
  const localRepository = join(temporary, "remote.git");
  const localSource = join(temporary, "original-checkout");
  const realGit = scenario.realGit ? spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim() : "";
  function git(args: string[]): string {
    const result = spawnSync(realGit, args, { encoding: "utf8", env: { ...process.env, ...gitEnvironment,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  if (scenario.realGit) {
    git(["init", "--initial-branch=fixes", localSource]);
    writeFileSync(join(localSource, "example.js"), "original code\n");
    git(["-C", localSource, "add", "--all"]);
    git(["-C", localSource, "commit", "-m", "Initial PR"]);
    git(["clone", "--bare", localSource, localRepository]);
    Object.assign(gitEnvironment, { REVIEW_TEST_GIT: realGit, REVIEW_TEST_LOCAL_REPOSITORY: localRepository,
      REVIEW_TEST_ORIGINAL_CHECKOUT: localSource,
      REVIEW_TEST_INITIAL_HEAD: git(["-C", localSource, "rev-parse", "HEAD"]),
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  }
  try {
    const workspaceArgs = options.override === "flag" ? ["--dev-dir", workspace] : [];
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PR_REVIEW_")));
    const result = spawnSync(process.execPath, [join(toolRepository, "dist", "bin", "review-pr.js"), url, ...workspaceArgs, ...args], {
      cwd: caller, encoding: "utf8", timeout: 20000,
      env: { ...environment, PATH: `${bin}:${process.env.PATH}`, REVIEW_TEST_STATE: statePath,
        REVIEW_TEST_SCENARIO: JSON.stringify(scenario), ...gitEnvironment,
        ...(options.override === "environment" ? { PR_REVIEW_DEV_DIR: workspace } : {}),
        ...(options.override === "flag" ? { PR_REVIEW_DEV_DIR: join(temporary, "wrong-workspace") } : {}),
        ...options.environment?.(paths) },
    });
    assert.ifError(result.error);
    assert.equal(existsSync(join(toolRepository, "sessions")), false);
    const reports = options.reports ? options.reports(paths) : join(workspace, "sessions", "pr-reviews");
    const directory = existsSync(reports) ? readdirSync(reports)[0] : undefined;
    const state: FixtureState = JSON.parse(readFileSync(statePath, "utf8"));
    const summary: Summary | undefined = directory ? JSON.parse(readFileSync(join(reports, directory, "summary.json"), "utf8")) : undefined;
    return { ...result, workspace: realpathSync(workspace), calls: state.calls,
      reports, files: directory ? readdirSync(join(reports, directory)) : [],
      ...(scenario.realGit ? { remoteSource: git(["--git-dir", localRepository, "show", "refs/heads/fixes:example.js"]),
        remoteFiles: git(["--git-dir", localRepository, "ls-tree", "--name-only", "refs/heads/fixes"]),
        originalSource: readFileSync(join(localSource, "example.js"), "utf8"),
        checkoutSource: directory ? readFileSync(join(reports, directory, "checkout", "example.js"), "utf8") : undefined,
        commitCount: Number(git(["--git-dir", localRepository, "rev-list", "--count", "refs/heads/fixes"])) } : {}),
      summary };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("runs both CLIs without fixed agents and passes Claude's full review through stdin", () => {
  const fullReview = 'Optional nit: "quote" and $(touch /tmp/do-not-run) are review text';
  const result = runReview({ claude: [{ verdict: "approve_with_nits", review: fullReview }] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.summary);
  assert.equal(result.summary.status, "approved");
  assert.equal(result.summary.round, 1);
  assert.ok(result.calls.filter((call) => call.tool !== "git").every((call) => call.cwd === result.workspace));
  const agents = result.calls.filter((call) => ["claude", "codex"].includes(call.tool));
  assert.deepEqual(agents.map((call) => call.tool), ["claude", "codex"]);
  assert.ok(agents.every((call) => !call.args.includes("--agent")));
  assert.ok(agents.every((call) => !call.input.includes("configured reviewer agent")));
  assert.ok(agents[0].args.includes("plan"));
  assert.equal(agents[0].args[agents[0].args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(agents[0].args.includes("--verbose"));
  assert.match(result.stderr, /\[Round 1: reviewer-1 \(claude\)\] Session started\./);
  assert.match(result.stderr, /Using Read\./);
  assert.match(result.stderr, /Tool completed\./);
  assert.match(result.stderr, /Review response received\./);
  assert.doesNotMatch(result.stderr, /"type":"(?:system|assistant|result)"/);
  assert.ok(agents[1].args.includes("workspace-write"));
  assert.ok(agents[1].args.includes("sandbox_workspace_write.network_access=true"));
  assert.equal(agents[1].args[agents[1].args.indexOf("--cd") + 1], result.workspace);
  assert.ok(agents.every((call) => call.input.includes(result.workspace)));
  assert.ok(agents[1].input.includes(JSON.stringify(fullReview)));
  assert.match(agents[1].input, /1-pr\.diff/);
  assert.match(agents[0].input, /This is a review-only task/);
  assert.match(agents[1].input, /Do not just review again/);
  assert.equal(result.calls.some((call) => call.tool === "git" && call.args[0] === "push"), false);
});

for (const owner of ["owner", "contributor"]) {
  test(`resolves an empty head repository nameWithOwner using its owner: ${owner}`, () => {
    const result = runReview({ revisions: [{
      headRepository: { name: "repo", nameWithOwner: "" }, headRepositoryOwner: { login: owner },
    }] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary?.status, "approved");
    assert.equal(result.summary?.revision?.headRepository?.nameWithOwner, `${owner}/repo`);
    const clone = result.calls.find((call) => call.tool === "gh" && call.args[1] === "clone");
    assert.equal(clone?.args[2], `${owner}/repo`);
    const snapshots = result.calls.filter((call) => call.tool === "gh" && call.args[1] === "view");
    assert.ok(snapshots.every((call) => call.args[call.args.indexOf("--json") + 1].split(",").includes("headRepositoryOwner")));
  });
}

test("normalizes repository metadata before comparing PR revisions", () => {
  const result = runReview({ revisions: [
    { headRepository: { name: "repo", nameWithOwner: "" }, headRepositoryOwner: { login: "owner" } },
    { headRepository: { nameWithOwner: "owner/repo" } },
  ] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary?.round, 1);
  assert.equal(result.summary?.reviews.length, 2);
});

for (const headRepository of [null, { name: "repo", nameWithOwner: "" }]) {
  test(`rejects an unavailable head repository without cloning: ${JSON.stringify(headRepository)}`, () => {
    const result = runReview({ revisions: [{ headRepository, headRepositoryOwner: null }] });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /PR head repository is unavailable/);
    assert.equal(result.calls.some((call) => call.tool === "gh" && call.args[1] === "clone"), false);
    assert.equal(result.calls.some((call) => ["claude", "codex"].includes(call.tool)), false);
  });
}

for (const format of ["json", "fenced", "unlabeled"] as const) {
  test(`accepts Claude's ${format} JSON result when structured output is absent`, () => {
    const fullReview = 'Optional nit: "quotes", Unicode José, and a newline\nremain intact.';
    const result = runReview({ claudeFormat: format, claude: [{ verdict: "approve_with_nits", review: fullReview }] });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.summary);
    assert.equal(result.summary.status, "approved");
    assert.equal(result.summary.reviews[0].review, fullReview);
    const codex = result.calls.find((call) => call.tool === "codex");
    assert.ok(codex);
    assert.ok(codex.input.includes(JSON.stringify(fullReview)));
    assert.ok(result.files.includes("1-reviewer-1.review.json"));
  });
}

test("accepts a JSON result when Claude's structured output is null", () => {
  const result = runReview({ claudeFormat: "json", claudeEnvelope: { structured_output: null } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.summary);
  assert.equal(result.summary.status, "approved");
});

test("prefers Claude's structured output over its result text", () => {
  const result = runReview({ claudeEnvelope: { result: "This result text is not JSON" } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.summary);
  assert.equal(result.summary.status, "approved");
});

test("feeds Codex's disagreement back to Claude and continues until both approve", () => {
  const result = runReview({ claude: [changes, {}], codex: [{ review: "Claude's finding is disproven at example.js:10" }, {}] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.summary);
  assert.equal(result.summary.round, 2);
  const claudeCalls = result.calls.filter((call) => call.tool === "claude");
  assert.match(claudeCalls[1].input, /finding is disproven/);
  assert.equal(result.summary.reviews.length, 4);
});

test("publishes verified fixes to a real Git remote and requires the first LLM to review the updated PR", () => {
  const result = runReview({ realGit: true, newTestFile: true, claude: [changes, {}], fixes: ["fixed code\n"] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.summary);
  assert.equal(result.summary.round, 2);
  assert.equal(result.remoteSource, "fixed code");
  assert.equal(result.originalSource, "original code\n");
  assert.equal(result.commitCount, 2);
  assert.ok(result.remoteFiles?.split("\n").includes("example.test.js"));
  const agents = result.calls.filter((call) => ["claude", "codex"].includes(call.tool));
  assert.deepEqual(agents.map((call) => call.tool), ["claude", "codex", "claude", "codex"]);
  assert.equal(agents[2].source, "fixed code\n");
  assert.match(agents[2].input, /codex full review 1/);
  const reports = result.summary.reviews;
  assert.deepEqual(reports.map((review) => review.role), ["review", "fix", "review", "fix"]);
  assert.ok(reports[1].published_sha);
  assert.notEqual(reports[0].head_sha, reports[2].head_sha);
  assert.equal(reports[1].published_sha, reports[2].head_sha);
  assert.equal(result.summary.revision?.headRefOid, reports[2].head_sha);
  const pushes = result.calls.filter((call) => call.tool === "git" && call.args[0] === "push");
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].args, ["push", "origin", `${reports[1].published_sha}:refs/heads/fixes`]);
  assert.ok(result.files.includes("1-published.json"));
});

test("an ordinary push rejects a concurrent Git update and preserves the unpublished fix", () => {
  const result = runReview({ realGit: true, concurrentPush: true, fixes: ["fixed code\n"] });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.summary?.status, "error");
  assert.equal(result.remoteSource, "concurrent code");
  assert.equal(result.checkoutSource, "fixed code\n");
  assert.equal(result.commitCount, 2);
  assert.equal(result.calls.filter((call) => call.tool === "claude").length, 1);
});

test("never approves a newly fixed commit before the first LLM reviews it", () => {
  const result = runReview({ fixes: ["fixed code\n"] }, ["--max-rounds", "1"]);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.summary);
  assert.equal(result.summary.status, "no_consensus");
  assert.equal(result.summary.revision?.headRefOid, result.summary.reviews[1].published_sha);
});

test("repeats the fix and review cycle when the first LLM finds another required fix", () => {
  const result = runReview({ claude: [changes, changes, {}], fixes: ["first fix", "second fix"] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary?.round, 3);
  assert.equal(result.calls.filter((call) => call.tool === "git" && call.args[0] === "push").length, 2);
  const reviews = result.calls.filter((call) => call.tool === "claude");
  assert.equal(reviews[1].source, "first fix");
  assert.equal(reviews[2].source, "second fix");
});

test("supports fixes with the providers reversed and reports outside the workspace", () => {
  const result = runReview({ codex: [changes, {}], fixes: ["fixed code"] }, [], {
    environment: ({ temporary }) => ({ PR_REVIEW_REVIEWERS: '[{"provider":"codex"},{"provider":"claude"}]',
      PR_REVIEW_REPORTS_DIR: join(temporary, "outside-reports") }),
    reports: ({ temporary }) => join(temporary, "outside-reports"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary?.round, 2);
  const implementer = result.calls.find((call) => call.tool === "claude");
  assert.ok(implementer);
  assert.ok(implementer.args.includes("acceptEdits"));
  const checkout = implementer.args[implementer.args.indexOf("--add-dir") + 1];
  assert.ok(checkout.startsWith(result.reports));
});

test("does not push partial fixes when the implementer remains blocked", () => {
  const result = runReview({ codex: [{ verdict: "blocked", blockers: ["Tests unavailable"] }], fixes: ["partial fix"] });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Fixes are not ready to publish/);
  assert.equal(result.calls.some((call) => call.tool === "git" && call.args[0] === "push"), false);
});

test("preserves unpublished fixes when the PR changes during implementation", () => {
  const result = runReview({ fixes: ["local fix"], revisions: [{}, {}, {}, {}, { headRefOid: "c".repeat(40) }] });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /PR changed during fixes; unpublished work is preserved/);
  assert.equal(result.calls.some((call) => call.tool === "git" && call.args[0] === "push"), false);
});

test("rechecks the PR after committing and refuses to push against a changed revision", () => {
  const result = runReview({ fixes: ["local fix"], revisions: [{}, {}, {}, {}, {}, { baseRefOid: "c".repeat(40) }] });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /PR changed before publishing fixes; unpublished commit is preserved/);
  assert.equal(result.calls.some((call) => call.tool === "git" && call.args[0] === "commit"), true);
  assert.equal(result.calls.some((call) => call.tool === "git" && call.args[0] === "push"), false);
});

test("does not approve when GitHub's head does not match the pushed fix commit", () => {
  const result = runReview({ fixes: ["local fix"], revisions: [{}, {}, {}, {}, {}, {}, { headRefOid: "a".repeat(40) }] });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /PR head does not match the published fix commit/);
});

for (const command of ["commit", "push"]) {
  test(`records a ${command} failure without reporting success`, () => {
    const result = runReview({ fixes: ["local fix"], gitFailure: command });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.summary?.status, "error");
    assert.equal(result.calls.filter((call) => call.tool === "claude").length, 1);
  });
}

test("refuses to publish if an agent commits or switches checkout HEAD itself", () => {
  const result = runReview({ changeHead: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Agent changed checkout HEAD/);
  assert.equal(result.calls.some((call) => call.tool === "git" && call.args[0] === "push"), false);
});

test("refuses edits made by the first LLM during a read-only review", () => {
  const result = runReview({ reviewEdits: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /first LLM modified files/);
  assert.equal(result.calls.some((call) => call.tool === "codex"), false);
});

test("never treats approval words in a blocking review as consensus", () => {
  const result = runReview({ claude: [changes], codex: [changes] }, ["--max-rounds", "2"]);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.summary);
  assert.equal(result.summary.status, "no_consensus");
  assert.equal(result.calls.filter((call) => call.tool === "codex").length, 2);
});

const roundLimits = [
  { name: "the repository .env", dotenv: "2", expected: 2 },
  { name: "exported variables over .env", dotenv: "1", exported: "2", expected: 2 },
  { name: "--max-rounds over exported variables and .env", dotenv: "1", exported: "2", flag: "3", expected: 3 },
  { name: "the default when unset", expected: 5 },
];
for (const { name, dotenv, exported, flag, expected } of roundLimits) {
  test(`uses the round limit from ${name}`, () => {
    const result = runReview({ claude: [changes], codex: [changes] }, flag ? ["--max-rounds", flag] : [], {
      ...(dotenv === undefined ? {} : { dotenv: () => `PR_REVIEW_MAX_ROUNDS=${dotenv}\n` }),
      ...(exported === undefined ? {} : { environment: () => ({ PR_REVIEW_MAX_ROUNDS: exported }) }),
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.summary?.round, expected);
    assert.equal(result.calls.filter((call) => call.tool === "claude").length, expected);
    assert.equal(result.calls.filter((call) => call.tool === "codex").length, expected);
  });
}

for (const value of ["0", "-1", "1.5", "invalid", "", "9007199254740992"]) {
  test(`rejects invalid PR_REVIEW_MAX_ROUNDS before invoking CLIs: ${JSON.stringify(value)}`, () => {
    const result = runReview({}, [], { dotenv: () => `PR_REVIEW_MAX_ROUNDS=${value}\n` });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.calls.length, 0);
    assert.match(result.stderr, /Expected an integer/);
  });
}

for (const field of ["headRefOid", "baseRefOid"] as const) {
  test(`discards approvals when ${field} changes after Codex and reviews the new revision`, () => {
    const revision = { [field]: "c".repeat(40) };
    const result = runReview({ revisions: [{}, {}, {}, {}, revision] });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.summary);
    assert.equal(result.summary.round, 2);
    assert.equal(result.summary.reviews.length, 4);
    const claudeCalls = result.calls.filter((call) => call.tool === "claude");
    assert.match(claudeCalls[1].input, /older commits are context, never approval/);
    assert.match(claudeCalls[1].input, /claude full review 1/);
    assert.ok(result.summary.revision);
    assert.equal(result.summary.revision[field], revision[field]);
  });
}

test("restarts before invoking Codex if the head changes during Claude's review", () => {
  const result = runReview({ revisions: [{}, {}, {}, { headRefOid: "c".repeat(40) }] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.summary);
  assert.equal(result.calls.filter((call) => call.tool === "codex").length, 1);
  assert.equal(result.summary.round, 2);
});

const failures: [string, Scenario][] = [
  ["Claude stream without a final result", { missingClaudeResult: true }],
  ["Claude approval text outside a final result", { claudeEnvelope: { type: "assistant" } }],
  ["malformed Claude output", { malformed: "claude" }],
  ["malformed Codex output", { malformed: "codex" }],
  ["missing Codex final output", { missingAnswer: true }],
  ["Claude internal error", { claudeError: true }],
  ["Claude permission denial", { denied: true }],
  ["missing Claude output", { claudeEnvelope: { structured_output: null } }],
  ["non-string Claude result", { claudeEnvelope: { structured_output: null, result: {} } }],
  ["empty Claude result", { claudeEnvelope: { structured_output: null, result: " \n " } }],
  ["malformed Claude result", { claudeFormat: "json", claudeEnvelope: { result: "not JSON" } }],
  ["Claude result surrounded by prose", { claudeFormat: "fenced", claudeEnvelope: { result: 'Review follows:\n```json\n{}\n```' } }],
  ["invalid structured output with a valid JSON result", { claudeFormat: "json", claudeEnvelope: { structured_output: {} } }],
  ["Claude internal error with a valid JSON result", { claudeFormat: "json", claudeError: true }],
  ["Claude permission denial with a valid JSON result", { claudeFormat: "json", denied: true }],
  ["fallback approval with blockers", { claudeFormat: "fenced", claude: [{ blockers: ["Still required"] }] }],
  ["fallback review of another commit", { claudeFormat: "fenced", claude: [{ head_sha: "d".repeat(40) }] }],
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
    assert.ok(result.summary);
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
  const cases: [string[], number][] = [[["--help"], 0], [[url, "--max-rounds", "0"], 1], [["not-a-pr"], 1]];
  for (const [args, expected] of cases) {
    const result = spawnSync(process.execPath, [join(repository, "bin", "review-pr.js"), ...args], { encoding: "utf8" });
    assert.equal(result.status, expected);
  }
});

for (const override of ["flag", "environment"] as const) {
  test(`runs reviewers in the workspace selected by ${override}`, () => {
    const result = runReview({}, [], { override });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.calls.filter((call) => call.tool !== "git").every((call) => call.cwd === result.workspace));
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
  assert.ok(result.calls.filter((call) => call.tool !== "git").every((call) => call.cwd === result.workspace));
  const agents = result.calls.filter((call) => ["claude", "codex"].includes(call.tool));
  assert.deepEqual(agents.map((call) => call.tool), ["codex", "claude"]);
  assert.deepEqual(agents.map((call) => call.args[call.args.indexOf("--model") + 1]), reviewers.map((reviewer) => reviewer.model));
  assert.ok(agents[0].args.includes('agents.default_subagent_model="codex-test-model"'));
  assert.match(agents[0].input, /including any delegated agent/);
  assert.match(agents[1].input, /codex full review/);
  assert.ok(agents[0].args.includes("read-only"));
  assert.ok(agents[1].args.includes("acceptEdits"));
  assert.ok(agents[1].args.includes("Bash"));
  assert.ok(result.summary);
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
  assert.ok(result.calls.filter((call) => call.tool !== "git").every((call) => call.cwd === result.workspace));
  assert.ok(result.calls.filter((call) => ["claude", "codex"].includes(call.tool)).every((call) => !call.args.includes("--model")));
});

for (const provider of ["claude", "codex"] as const) {
  test(`runs two ${provider} models without overwriting reviews`, () => {
    const result = runReview({ [provider]: [changes, {}, {}, {}], fixes: ["fixed code"] }, [], {
      environment: () => ({ PR_REVIEW_REVIEWERS: JSON.stringify([
        { provider, model: "model-one" }, { provider, model: "model-two" },
      ]) }),
    });
    assert.equal(result.status, 0, result.stderr);
    const agents = result.calls.filter((call) => ["claude", "codex"].includes(call.tool));
    assert.deepEqual(agents.map((call) => call.tool), Array(4).fill(provider));
    assert.ok(result.summary);
    assert.deepEqual(result.summary.reviews.map((review) => review.agent), ["reviewer-1", "reviewer-2", "reviewer-1", "reviewer-2"]);
    assert.match(agents[1].input, /needs a required fix/);
    assert.match(agents[2].input, /full review 2/);
    assert.ok(result.files.includes("1-reviewer-1.review.json"));
    assert.ok(result.files.includes("1-reviewer-2.review.json"));
  });
}

const unsupportedProviders: [string, number][] = [["gemini", 0], ["gemini", 1], ["__proto__", 0], ["constructor", 0], ["toString", 0]];
for (const [provider, index] of unsupportedProviders) {
  test(`rejects unlisted provider ${provider} in slot ${index + 1} before invoking CLIs`, () => {
    const reviewers = [{ provider: "claude" }, { provider: "codex" }];
    reviewers[index].provider = provider;
    const result = runReview({}, [], {
      environment: () => ({ PR_REVIEW_REVIEWERS: JSON.stringify(reviewers) }),
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.calls.length, 0);
    assert.equal(result.summary, undefined);
    assert.ok(result.stderr.includes(`Unsupported reviewer provider ${JSON.stringify(provider)}`));
    assert.match(result.stderr, /Supported providers: claude, codex/);
  });
}

for (const value of ["invalid", "[]", '[{"provider":"claude"}]',
  '[{"provider":"claude","model":" "},{"provider":"codex"}]', '[{"provider":"claude","model":5},{"provider":"codex"}]',
  '[{"provider":"claude","modle":"opus"},{"provider":"codex"}]', '[null,{"provider":"codex"}]',
  '[{"provider":["claude"]},{"provider":"codex"}]', '[{"provider":null},{"provider":"codex"}]']) {
  test(`rejects invalid reviewer configuration before invoking CLIs: ${value}`, () => {
    const result = runReview({}, [], { environment: () => ({ PR_REVIEW_REVIEWERS: value }) });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.calls.length, 0);
    assert.match(result.stderr, /PR_REVIEW_REVIEWERS|reviewer model/);
  });
}

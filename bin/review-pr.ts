#!/usr/bin/env node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { run } from "../lib/process.js";
import { configuration } from "../lib/config.js";
import { approved, schema } from "../lib/protocol.js";
import { reviewWith } from "../lib/reviewers.js";
import { providers } from "../lib/providers.js";
import { hasChanges, prepareCheckout, publishFixes } from "../lib/checkout.js";
import type { ReviewContext, ReviewOptions, Revision, RunContext } from "../lib/types.js";

// This entry point runs from dist/bin; configuration stays at the repository root.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const help = `Usage: review-pr <https://github.com/owner/repo/pull/123> [options]

  --max-rounds <number>       Maximum review/fix rounds (env: PR_REVIEW_MAX_ROUNDS; default: 5)
  --timeout-seconds <number>  Timeout per agent (default: 1800)
  --dev-dir <path>            LLM workspace (default: sibling dev/)
  --help                     Show help

Loads .env from the tool repository; exported variables take precedence.
PR_REVIEW_DEV_DIR selects the workspace; --dev-dir takes precedence.
PR_REVIEW_REPORTS_DIR selects reports (default: <dev-dir>/sessions/pr-reviews/).
PR_REVIEW_MAX_ROUNDS sets the round limit; --max-rounds takes precedence (default: 5).
PR_REVIEW_REVIEWERS selects a reviewer, then an implementer, with optional models,
for example: [{"provider":"claude","model":"opus"},{"provider":"codex"}]
Supported providers: ${Object.keys(providers).join(", ")}.
Requires authenticated gh and the selected providers' CLIs.
Exit codes: 0 = both approve, 2 = no consensus, 1 = error, 130/143 = interrupted.
The second LLM verifies findings and fixes code. Validated fixes are committed and
pushed to the PR branch, then the first LLM reviews again. It does not merge PRs.
`;

function optionsFrom(args: string[]): { help: true } | ({ help: false } & ReviewOptions) {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { "max-rounds": { type: "string" },
      "timeout-seconds": { type: "string", default: "1800" },
      "dev-dir": { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) return { help: true };
  if (positionals.length !== 1) throw new Error(help);
  const match = positionals[0].match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?(?:[?#].*)?$/);
  if (!match) throw new Error("Provide a GitHub pull request URL, such as https://github.com/owner/repo/pull/123");
  const settings = configuration(repository, values);
  return { help: false, url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
    ...settings,
    label: `${match[1]}-${match[2]}-${match[3]}`,
    maxRounds: positiveInteger(values["max-rounds"] ?? process.env.PR_REVIEW_MAX_ROUNDS ?? "5"),
    timeoutMs: positiveInteger(values["timeout-seconds"], 2147483) * 1000 };
}

function positiveInteger(value: string | undefined, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`Expected an integer from 1 to ${maximum}, received ${value}`);
  }
  return number;
}

function sameRevision(left: Revision, right: Revision): boolean {
  return left.headRefOid === right.headRefOid && left.baseRefOid === right.baseRefOid
    && left.headRefName === right.headRefName && left.headRepository?.nameWithOwner === right.headRepository?.nameWithOwner;
}

async function snapshot(context: RunContext, label: string, full = false): Promise<Revision> {
  const fields = "url,state,headRefOid,baseRefOid,headRefName,headRepository,headRepositoryOwner"
    + (full ? ",title,body,files,comments,reviews,statusCheckRollup" : "");
  const raw = await github(context, ["pr", "view", context.url, "--json", fields], label);
  const revision: Record<string, unknown> = JSON.parse(raw);
  if (revision.state !== "OPEN") throw new Error(`PR is ${revision.state}; expected an open PR`);
  const { headRefOid, baseRefOid } = revision;
  if (typeof headRefOid !== "string" || !/^[a-f0-9]{40}$/.test(headRefOid)
      || typeof baseRefOid !== "string" || !/^[a-f0-9]{40}$/.test(baseRefOid)) {
    throw new Error("GitHub returned invalid head/base commit IDs");
  }
  const { headRefName, headRepositoryOwner } = revision;
  let { headRepository } = revision;
  // gh can return an empty nameWithOwner even when the head repository exists.
  if (headRepository && typeof headRepository === "object") {
    const repository = headRepository as Record<string, unknown>;
    if ((repository.nameWithOwner === undefined || repository.nameWithOwner === "")
        && typeof repository.name === "string" && headRepositoryOwner && typeof headRepositoryOwner === "object"
        && "login" in headRepositoryOwner && typeof headRepositoryOwner.login === "string") {
      headRepository = { ...repository, nameWithOwner: `${headRepositoryOwner.login}/${repository.name}` };
    }
  }
  if (typeof headRefName !== "string" || !headRefName || (headRepository !== null
      && (!headRepository || typeof headRepository !== "object" || !("nameWithOwner" in headRepository)
        || typeof headRepository.nameWithOwner !== "string"))) {
    throw new Error("GitHub returned invalid PR branch or repository metadata");
  }
  return { ...revision, headRefOid, baseRefOid, state: revision.state, headRefName,
    headRepository: headRepository as Revision["headRepository"] };
}

function github(context: RunContext, args: string[], label: string): Promise<string> {
  return run("gh", args, { cwd: context.root, timeoutMs: Math.min(context.timeoutMs, 60000),
    log: join(context.directory, `${context.round}-${label}`) });
}

async function confirmPublishedFix(context: RunContext, previous: Revision, commit: string): Promise<void> {
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    context.revision = await snapshot(context, attempt === 1 ? "after-push" : `after-push-${attempt}`);
    if (context.revision.headRefOid === commit) return;
    if (!sameRevision(previous, context.revision) || attempt === attempts) break;
    console.log(`GitHub still reports the previous PR revision after push; retrying in 1 second (${attempt}/${attempts - 1}).`);
    await delay(1000);
  }
  throw new Error("PR head does not match the published fix commit; rerun against the latest PR revision");
}

async function roundOfReviews(context: RunContext): Promise<boolean> {
  const revision = await snapshot(context, "before", true);
  context.revision = revision;
  const reviewContext: ReviewContext = { ...context, revision, role: "review",
    metadata: join(context.directory, `${context.round}-pr.json`),
    patch: join(context.directory, `${context.round}-pr.diff`) };
  writeFileSync(reviewContext.metadata, JSON.stringify(revision, null, 2), { mode: 0o600 });
  const patch = await github(context, ["pr", "diff", context.url, "--color", "never"], "diff");
  writeFileSync(reviewContext.patch, patch, { mode: 0o600 });
  if (!sameRevision(revision, await snapshot(context, "after-diff"))) return restart(context);
  await prepareCheckout(context, revision);
  if (!sameRevision(revision, await snapshot(context, "after-checkout"))) return restart(context);
  const review = await reviewWith(context.reviewers[0], reviewContext);
  context.history.push(review);
  if (await hasChanges(context, revision)) {
    throw new Error(`The first LLM modified files during review; work is preserved in ${context.checkout}`);
  }
  if (!sameRevision(revision, await snapshot(context, "after-reviewer-1"))) return restart(context);
  const implementation = await reviewWith(context.reviewers[1], { ...reviewContext, role: "fix" });
  context.history.push(implementation);
  const changed = await hasChanges(context, revision);
  if (!sameRevision(revision, await snapshot(context, "after-reviewer-2"))) {
    if (changed) throw new Error(`PR changed during fixes; unpublished work is preserved in ${context.checkout}`);
    return restart(context);
  }
  if (changed) {
    if (!approved(implementation)) {
      throw new Error(`Fixes are not ready to publish; see the implementer's blockers. Work is preserved in ${context.checkout}`);
    }
    implementation.published_sha = await publishFixes(context, revision, async () => {
      if (!sameRevision(revision, await snapshot(context, "before-push"))) {
        throw new Error(`PR changed before publishing fixes; unpublished commit is preserved in ${context.checkout}`);
      }
    });
    writeFileSync(join(context.directory, `${context.round}-published.json`), JSON.stringify(implementation, null, 2), { mode: 0o600 });
    await confirmPublishedFix(context, revision, implementation.published_sha);
    console.log(`Fixes pushed: ${implementation.published_sha}. A fresh review by the first LLM is required.`);
    return false;
  }
  return approved(review) && approved(implementation);
}

function restart(context: RunContext): false {
  console.log("PR head or base changed; earlier verdicts no longer count. Starting a fresh round with prior reports as context.");
  return false;
}

function finish(context: RunContext, status: "approved" | "no_consensus" | "error", error?: Error): void {
  const summary = { url: context.url, status, round: context.round, revision: context.revision, checkout: context.checkout, reviewers: context.reviewers,
    reviews: context.history, ...(error ? { error: error.message } : {}) };
  writeFileSync(join(context.directory, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(`Result: ${status}. Reports: ${context.directory}\nPR: ${context.url}`);
}

async function main(): Promise<void> {
  const options = optionsFrom(process.argv.slice(2));
  if (options.help) return console.log(help);
  const root = options.root;
  const parent = options.reports;
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, `${options.label}-`));
  const context: RunContext = { ...options, root, directory, checkout: join(directory, "checkout"),
    history: [], round: 0, schemaPath: join(directory, "schema.json") };
  writeFileSync(context.schemaPath, JSON.stringify(schema), { mode: 0o600 });
  console.log(`Reports: ${directory}`);
  try {
    for (context.round = 1; context.round <= context.maxRounds; context.round += 1) {
      if (await roundOfReviews(context)) return finish(context, "approved");
    }
    context.round = context.maxRounds;
    finish(context, "no_consensus");
    process.exitCode = 2;
  } catch (error) {
    finish(context, "error", error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
});

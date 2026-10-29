#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { run } from "../lib/process.mjs";
import { configuration } from "../lib/config.mjs";
import { approved, schema } from "../lib/protocol.mjs";
import { reviewWith } from "../lib/reviewers.mjs";
import { providers } from "../lib/providers.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const help = `Usage: review-pr <https://github.com/owner/repo/pull/123> [options]

  --max-rounds <number>       Maximum review rounds (default: 5)
  --timeout-seconds <number>  Timeout per reviewer (default: 1800)
  --dev-dir <path>            LLM workspace (default: sibling dev/)
  --help                     Show help

Loads .env from the tool repository; exported variables take precedence.
PR_REVIEW_DEV_DIR selects the workspace; --dev-dir takes precedence.
PR_REVIEW_REPORTS_DIR selects reports (default: <dev-dir>/sessions/pr-reviews/).
PR_REVIEW_REVIEWERS selects two ordered providers with optional models as JSON,
for example: [{"provider":"claude","model":"opus"},{"provider":"codex"}]
Supported providers: ${Object.keys(providers).join(", ")}.
Requires authenticated gh and the selected providers' CLIs and reviewer agents.
Exit codes: 0 = both approve, 2 = no consensus, 1 = error, 130/143 = interrupted.
This script reviews only; it does not fix, publish reviews, or merge the PR.
`;

function optionsFrom(args) {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { "max-rounds": { type: "string", default: "5" },
      "timeout-seconds": { type: "string", default: "1800" },
      "dev-dir": { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) return { help: true };
  if (positionals.length !== 1) throw new Error(help);
  const match = positionals[0].match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?(?:[?#].*)?$/);
  if (!match) throw new Error("Provide a GitHub pull request URL, such as https://github.com/owner/repo/pull/123");
  return { url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
    ...configuration(repository, values),
    label: `${match[1]}-${match[2]}-${match[3]}`, maxRounds: positiveInteger(values["max-rounds"]),
    timeoutMs: positiveInteger(values["timeout-seconds"], 2147483) * 1000 };
}

function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`Expected an integer from 1 to ${maximum}, received ${value}`);
  }
  return number;
}

function sameRevision(left, right) {
  return left.headRefOid === right.headRefOid && left.baseRefOid === right.baseRefOid;
}

async function snapshot(context, label, full = false) {
  const fields = "url,state,headRefOid,baseRefOid" + (full ? ",title,body,files,comments,reviews,statusCheckRollup" : "");
  const raw = await github(context, ["pr", "view", context.url, "--json", fields], label);
  const revision = JSON.parse(raw);
  if (revision.state !== "OPEN") throw new Error(`PR is ${revision.state}; expected an open PR`);
  if (![revision.headRefOid, revision.baseRefOid].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha))) {
    throw new Error("GitHub returned invalid head/base commit IDs");
  }
  return revision;
}

function github(context, args, label) {
  return run("gh", args, { cwd: context.root, timeoutMs: Math.min(context.timeoutMs, 60000),
    log: join(context.directory, `${context.round}-${label}`) });
}

async function roundOfReviews(context) {
  const revision = await snapshot(context, "before", true);
  if (context.revision && !sameRevision(context.revision, revision)) context.history = [];
  context.revision = revision;
  context.metadata = join(context.directory, `${context.round}-pr.json`);
  context.patch = join(context.directory, `${context.round}-pr.diff`);
  writeFileSync(context.metadata, JSON.stringify(revision, null, 2), { mode: 0o600 });
  const patch = await github(context, ["pr", "diff", context.url, "--color", "never"], "diff");
  writeFileSync(context.patch, patch, { mode: 0o600 });
  if (!sameRevision(revision, await snapshot(context, "after-diff"))) return restart(context);
  for (const reviewer of context.reviewers) {
    context.history.push(await reviewWith(reviewer, context));
    if (!sameRevision(revision, await snapshot(context, `after-${reviewer.id}`))) return restart(context);
  }
  return context.history.slice(-2).every(approved);
}

function restart(context) {
  console.log("PR head or base changed; discarding earlier verdicts and starting a fresh round.");
  context.history = [];
  return false;
}

function finish(context, status, error) {
  const summary = { url: context.url, status, round: context.round, revision: context.revision, reviewers: context.reviewers,
    reviews: context.history, ...(error ? { error: error.message } : {}) };
  writeFileSync(join(context.directory, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(`Result: ${status}. Reports: ${context.directory}`);
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  if (options.help) return console.log(help);
  const root = options.root;
  for (const { adapter, provider } of options.reviewers) {
    if (!existsSync(join(root, adapter))) throw new Error(`Missing ${adapter}; configure a ${provider} reviewer agent in ${root} first (see README.md)`);
  }
  const parent = options.reports;
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, `${options.label}-`));
  const context = { ...options, root, directory, history: [], round: 0, schemaPath: join(directory, "schema.json") };
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
    finish(context, "error", error);
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
});

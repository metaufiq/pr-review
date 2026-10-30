import { join } from "node:path";
import { run } from "./process.js";
import type { Revision, RunContext } from "./types.js";

function git(context: RunContext, args: string[], label: string): Promise<string> {
  return run("git", args, { cwd: context.checkout, timeoutMs: context.timeoutMs,
    log: join(context.directory, `${context.round}-${label}`) });
}

export async function prepareCheckout(context: RunContext, revision: Revision): Promise<void> {
  const repository = revision.headRepository?.nameWithOwner;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("PR head repository is unavailable; cannot prepare a checkout for fixes");
  }
  if (!context.checkoutRepository) {
    await run("gh", ["repo", "clone", repository, context.checkout, "--", "--no-checkout"], {
      cwd: context.root, timeoutMs: context.timeoutMs, log: join(context.directory, `${context.round}-clone`),
    });
    context.checkoutRepository = repository;
  } else {
    if (context.checkoutRepository !== repository) throw new Error("PR head repository changed during the run");
    if ((await git(context, ["status", "--porcelain", "--untracked-files=all"], "before-checkout")).trim()) {
      throw new Error(`Uncommitted work remains in ${context.checkout}; stopping to preserve it`);
    }
  }
  await git(context, ["fetch", "--no-tags", "origin", revision.headRefOid], "fetch");
  await git(context, ["checkout", "--detach", revision.headRefOid], "checkout");
}

export async function hasChanges(context: RunContext, revision: Revision): Promise<boolean> {
  const head = (await git(context, ["rev-parse", "HEAD"], "checkout-head")).trim();
  if (head !== revision.headRefOid) {
    throw new Error(`Agent changed checkout HEAD; work is preserved in ${context.checkout}`);
  }
  return !!(await git(context, ["status", "--porcelain", "--untracked-files=all"], "checkout-status")).trim();
}

export async function publishFixes(context: RunContext, revision: Revision, beforePush: () => Promise<void>): Promise<string> {
  await git(context, ["check-ref-format", `refs/heads/${revision.headRefName}`], "check-branch");
  await git(context, ["diff", "--check"], "diff-check");
  await git(context, ["add", "--all"], "stage");
  await git(context, ["diff", "--cached", "--check"], "staged-check");
  await git(context, ["diff", "--cached", "--stat"], "fix-stat");
  await git(context, ["commit", "-m", "fix: address PR review findings"], "commit");
  const parent = (await git(context, ["rev-parse", "HEAD^"], "commit-parent")).trim();
  const commit = (await git(context, ["rev-parse", "HEAD"], "fix-head")).trim();
  if (parent !== revision.headRefOid || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`Unexpected fix commit ancestry; work is preserved in ${context.checkout}`);
  }
  if ((await git(context, ["status", "--porcelain", "--untracked-files=all"], "after-commit")).trim()) {
    throw new Error(`Checkout is dirty after committing; work is preserved in ${context.checkout}`);
  }
  await beforePush();
  // An ordinary push rejects concurrent, divergent updates. Never force-push.
  await git(context, ["push", "origin", `${commit}:refs/heads/${revision.headRefName}`], "push");
  return commit;
}

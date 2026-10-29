import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { providerFor } from "./providers.js";
import type { Configuration, ProviderName, Reviewer } from "./types.js";

export function configuration(repository: string, values: { "dev-dir"?: string }): Configuration {
  const file = join(repository, ".env");
  if (existsSync(file)) loadEnvFile(file);
  const root = values["dev-dir"] ? resolve(values["dev-dir"])
    : resolve(repository, process.env.PR_REVIEW_DEV_DIR || "../dev");
  return {
    root,
    reports: process.env.PR_REVIEW_REPORTS_DIR
      ? resolve(repository, process.env.PR_REVIEW_REPORTS_DIR) : join(root, "sessions", "pr-reviews"),
    reviewers: reviewersFrom(process.env.PR_REVIEW_REVIEWERS),
  };
}

function reviewersFrom(value: string | undefined): Reviewer[] {
  let reviewers: unknown;
  try {
    reviewers = JSON.parse(value ?? '[{"provider":"claude"},{"provider":"codex"}]');
  } catch {
    throw new Error("PR_REVIEW_REVIEWERS must be a JSON array of two reviewer objects");
  }
  if (!Array.isArray(reviewers) || reviewers.length !== 2) {
    throw new Error("PR_REVIEW_REVIEWERS must contain exactly two reviewers");
  }
  return reviewers.map(reviewerFrom);
}

function reviewerFrom(reviewer: unknown, index: number): Reviewer {
  if (!reviewer || typeof reviewer !== "object" || Array.isArray(reviewer) || !("provider" in reviewer) || typeof reviewer.provider !== "string"
      || Object.keys(reviewer).some((key) => !["provider", "model"].includes(key))) {
    throw new Error("Each PR_REVIEW_REVIEWERS entry must have a provider and an optional model");
  }
  const model = "model" in reviewer ? reviewer.model : undefined;
  if (model !== undefined && (typeof model !== "string" || !model.trim())) {
    throw new Error("Each reviewer model must be a nonempty string when provided");
  }
  providerFor(reviewer.provider);
  const provider = reviewer.provider as ProviderName;
  return { id: `reviewer-${index + 1}`, provider, ...(model === undefined ? {} : { model }) };
}

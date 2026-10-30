import type { providers } from "./providers.js";

export type ProviderName = keyof typeof providers;
export type Verdict = "approve" | "approve_with_nits" | "request_changes" | "blocked";
export type Role = "review" | "fix";

export interface Reviewer {
  id: string;
  provider: ProviderName;
  model?: string;
}

export interface Configuration {
  root: string;
  reports: string;
  reviewers: Reviewer[];
}

export interface Revision {
  headRefOid: string;
  baseRefOid: string;
  state: string;
  headRefName: string;
  headRepository: { nameWithOwner: string } | null;
}

export interface Review {
  head_sha: string;
  base_sha: string;
  verdict: Verdict;
  review: string;
  blockers: string[];
}

export interface ReviewRecord extends Review {
  agent: string;
  provider: ProviderName;
  model?: string;
  round: number;
  role: Role;
  published_sha?: string;
}

export interface ReviewOptions extends Configuration {
  url: string;
  label: string;
  maxRounds: number;
  timeoutMs: number;
}

export interface RunContext extends ReviewOptions {
  directory: string;
  schemaPath: string;
  history: ReviewRecord[];
  round: number;
  revision?: Revision;
  checkout: string;
  checkoutRepository?: string;
}

export interface ReviewContext extends RunContext {
  revision: Revision;
  metadata: string;
  patch: string;
  role: Role;
}

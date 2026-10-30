import type { Review, ReviewRecord, Reviewer, Revision } from "../../lib/types.js";

export type ToolName = "gh" | "claude" | "codex" | "git";

// Scenarios deliberately include invalid response fields to exercise validation.
export interface Scenario {
  claude?: Partial<Review>[];
  codex?: Partial<Review>[];
  revisions?: (Omit<Partial<Revision>, "headRepository"> & {
    headRepository?: { nameWithOwner?: string; name?: string } | null;
    headRepositoryOwner?: { login: string } | null;
  })[];
  claudeFormat?: "json" | "fenced" | "unlabeled";
  claudeEnvelope?: Record<string, unknown>;
  claudeError?: boolean;
  denied?: boolean;
  malformed?: ToolName;
  missingAnswer?: boolean;
  fail?: ToolName;
  hang?: ToolName;
  interrupt?: ToolName;
  fixes?: (string | null)[];
  reviewEdits?: boolean;
  gitFailure?: string;
  realGit?: boolean;
  changeHead?: boolean;
  newTestFile?: boolean;
  concurrentPush?: boolean;
}

export interface Call {
  tool: ToolName;
  args: string[];
  input: string;
  cwd: string;
  source?: string;
}

export interface FixtureState {
  calls: Call[];
  head?: string;
  parent?: string;
  remoteHead?: string;
  dirty?: boolean;
  commits?: number;
}

export interface Summary {
  status: "approved" | "no_consensus" | "error";
  round: number;
  revision?: Revision;
  reviewers: Reviewer[];
  reviews: ReviewRecord[];
  error?: string;
}

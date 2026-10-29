import type { Review, ReviewRecord, Reviewer, Revision } from "../../lib/types.js";

export type ToolName = "gh" | "claude" | "codex";

// Scenarios deliberately include invalid response fields to exercise validation.
export interface Scenario {
  claude?: Partial<Review>[];
  codex?: Partial<Review>[];
  revisions?: Partial<Revision>[];
  claudeFormat?: "json" | "fenced" | "unlabeled";
  claudeEnvelope?: Record<string, unknown>;
  claudeError?: boolean;
  denied?: boolean;
  malformed?: ToolName;
  missingAnswer?: boolean;
  fail?: ToolName;
  hang?: ToolName;
  interrupt?: ToolName;
}

export interface Call {
  tool: ToolName;
  args: string[];
  input: string;
  cwd: string;
}

export interface FixtureState {
  calls: Call[];
}

export interface Summary {
  status: "approved" | "no_consensus" | "error";
  round: number;
  revision?: Revision;
  reviewers: Reviewer[];
  reviews: ReviewRecord[];
  error?: string;
}

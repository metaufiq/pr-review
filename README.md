# PR Review

Run a configurable review-and-fix loop until both LLMs approve the same PR revision.
The first LLM reviews the PR; the second verifies the findings, applies required
fixes, and runs checks. The tool commits and pushes those fixes, then the first
LLM reviews the updated PR again. The default pair is Claude → Codex.

## Layout

Keep this Git repository beside the LLM workspace:

```text
projects/
├── dev/         # Claude/Codex agents, skills, configuration, and review logs
└── pr-review/   # This tool's code and tests
```

## Clone on another machine

```sh
mkdir -p "$HOME/projects"
git clone https://github.com/metaufiq/pr-review.git "$HOME/projects/pr-review"
cd "$HOME/projects/pr-review"
npm install
npm run prepare
```

Keep your LLM workspace at `~/projects/dev`, or select any workspace with `--dev-dir`.
Set up its agent configuration and CLI authentication on each machine.

Requires Node.js 22 or newer, Git with a configured commit identity, authenticated
`gh`, and the selected `claude` and/or `codex` CLIs. Your Git credentials need clone
and push access to the PR's head repository. `npm install` installs the TypeScript development tools;
`npm run prepare` installs the Git hooks and compiles the CLI into `dist/`.
Installation also runs this automatically when npm lifecycle scripts are enabled.
There are no runtime npm dependencies.
Each CLI uses your local configuration to select suitable agents and skills.

## Run from any directory

Add this alias to your shell configuration:

```sh
alias review-pr='node "$HOME/projects/pr-review/dist/bin/review-pr.js"'
```

Then run:

```sh
review-pr https://github.com/owner/repo/pull/123
review-pr https://github.com/owner/repo/pull/123 --max-rounds 8 --timeout-seconds 2400
review-pr https://github.com/owner/repo/pull/123 --dev-dir /path/to/your/workspace
review-pr --help
```

The default working directory is `../dev` relative to this repository, regardless
of your terminal's current directory. Every `gh`, Claude, and Codex process runs
there; Codex also receives that directory through `--cd`. The alias leaves your
terminal's current directory unchanged.

## Environment configuration

Copy `.env.example` to `.env` in this tool's repository, then edit it:

```sh
cp .env.example .env
```

```dotenv
PR_REVIEW_DEV_DIR=../dev
PR_REVIEW_REPORTS_DIR=./sessions/pr-reviews
PR_REVIEW_MAX_ROUNDS=5
PR_REVIEW_REVIEWERS='[{"provider":"claude"},{"provider":"codex"}]'
```

The tool reads its own `.env` from any calling directory. Exported environment
variables take precedence over `.env`; `--dev-dir` takes precedence over both.
The round limit follows `--max-rounds` → exported `PR_REVIEW_MAX_ROUNDS` → `.env`
→ the default of 5. Set a positive integer; invalid values fail before any CLI is
launched.
Environment paths resolve relative to this tool's repository; a relative
`--dev-dir` resolves from your terminal's current directory. Use absolute paths
for folders outside that layout. `.env` is ignored by Git.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PR_REVIEW_DEV_DIR` | `../dev` | Workspace for all CLI processes and reviewer configuration |
| `PR_REVIEW_REPORTS_DIR` | `<dev-dir>/sessions/pr-reviews` | Parent folder for per-run prompts, captures, reviews, logs, and summary |
| `PR_REVIEW_MAX_ROUNDS` | `5` | Maximum review/fix rounds; overridden by `--max-rounds` |
| `PR_REVIEW_REVIEWERS` | `[{"provider":"claude"},{"provider":"codex"}]` | First slot reviews; second slot verifies findings and fixes code |

Each reviewer has a `provider` (`claude` or `codex`) and an optional `model`.
Omit `model` to retain the CLI/agent's configured model. Use model IDs or aliases
available to your authenticated CLI account.
Invalid JSON, unsupported providers, extra fields, and empty model values fail
before any CLI is launched.

Supported providers are defined in the code in `lib/providers.ts`. Each entry
configures the CLI command, argument builder, and output reader. Add an entry
there to support another provider.
An unlisted provider raises an error naming it and listing the supported providers.

Reverse the objects to have Codex review and Claude fix, or select two models from
one provider:

```dotenv
PR_REVIEW_REVIEWERS='[{"provider":"claude","model":"opus"},{"provider":"claude","model":"sonnet"}]'
```

## Workspace setup

Install and authenticate each selected provider's CLI. Each CLI selects suitable
agents using your local configuration. The tool supplies the review protocol and
required JSON response schema on each run.

Your workspace can contain your own repository instructions, skills, and source
checkouts. No particular workspace framework or agent synchronization command is
required. Authenticate `gh` and each selected provider's CLI before running.
Each slot has a separate identity and output files even when providers repeat.

## Review and fix behavior

The first slot reviews without editing: Claude uses plan mode; Codex uses a
read-only sandbox. The second slot verifies the review and edits code: Claude uses
`acceptEdits` with Bash allowed for dependency setup and checks; Codex uses a
`workspace-write` sandbox with network access for dependency setup. Both run without
interactive permission prompts and retain their workspace configuration, skills,
and authentication. Explicit models are passed through `--model`. Codex also
receives the selected model as its default subagent model; the prompt requires any
delegated agent to use the requested model.
If a selected agent pins a different model or the requested model is unavailable,
the prompt requires a blocked verdict. Leaving the model unset preserves existing
model selection.

Each run clones the PR's head repository into its report folder's `checkout/` and
checks out the exact head commit. Existing checkouts are left untouched. Both LLMs
still start in the configured workspace so its agents and skills remain available;
the dedicated checkout is supplied in the prompt and the provider's directory
permissions. The script captures PR metadata, comments, reviews, CI status, and
the diff before each round. Missing essential evidence must produce a blocked
verdict.

Each round runs these steps:

1. The first LLM independently reviews the current PR, including any earlier fixes.
2. The second LLM checks every finding against the code, dismisses invalid findings
   with evidence, applies valid required fixes, and runs the relevant checks.
3. If edits are ready and the second LLM approves the result, the script commits
   and pushes them to the PR's head branch using an ordinary push.
4. After a push, a new round starts so the first LLM can review the updated PR.

The agents leave Git operations to the script. Partial fixes with unresolved
blockers, concurrent PR changes during edits, and commit or push failures stop the
run and preserve the checkout for inspection. Prior review and fix reports are
carried forward as context; old approvals never count for a new revision.

Success requires both LLMs to return `approve` or `approve_with_nits` with no
blockers for the same head and base commits in one round, without new code changes.
Optional nits are accepted; required fixes prevent approval. If either commit
changes during a review, a new round starts. Fixes pushed on the final allowed
round still need another review, so that run exits without consensus.

The default limit is five rounds, configurable with `PR_REVIEW_MAX_ROUNDS` in
`.env` or `--max-rounds`, and 30 minutes per agent. Running the tool
authorizes committing and pushing required fixes to the supplied PR. GitHub review
publication and merging remain manual.

The terminal shows Claude's session startup and tool activity as they arrive;
Codex's CLI progress is also displayed. Every 30 seconds, a heartbeat identifies
the current round and reviewer, elapsed time, time since the last CLI output, and
time remaining before timeout. The heartbeat confirms the runner is waiting for
the CLI; it does not guarantee that the agent is making progress. Full Claude
stream events are saved in the raw stdout log, and the final structured result
still determines the review verdict.

Prompts, captures, raw CLI logs, full reviews, and `summary.json` are saved under
`PR_REVIEW_REPORTS_DIR`, or `<dev-dir>/sessions/pr-reviews/` by default. Summaries
identify each slot, provider, requested model, role, and any published fix commit.
Reports may contain
private PR content; add `sessions/` to your workspace's `.gitignore`, or choose a
report folder outside version control.

| Exit code | Result |
| --- | --- |
| 0 | Both reviewers approve |
| 2 | Round limit reached without consensus |
| 1 | Execution or response error |
| 130 / 143 | Interrupted / terminated |

## Development

The source and tests use strict TypeScript. Shared types for reviewers, revisions,
verdicts, and review context are in `lib/types.ts`.

```text
bin/review-pr.ts      # CLI entry point and review loop
lib/                 # Configuration, providers, process runner, and protocol
tests/               # Integration tests, local Git remote, and fake CLI fixtures
dist/                # Generated JavaScript and source maps (ignored by Git)
.husky/pre-push      # Rebuilds the CLI before every push
```

The Husky pre-push hook runs `npm run build` before every push and stops the push
if compilation fails. Compiled files stay in the local `dist/` directory.
Run `npm run prepare` after cloning if npm lifecycle scripts are disabled.

To rebuild before using the shell alias, check types, or run tests:

```sh
npm run build
npm run typecheck
npm test
```

You can also build and run directly from this repository:

```sh
npm run review -- https://github.com/owner/repo/pull/123
npm run review -- --help
```

`npm test` builds first, then runs the compiled integration tests with Node's test
runner. Tests use fake LLM executables and a local Git remote for the full fix,
commit, push, and re-review cycle, with this tool and its LLM workspace in separate
sibling directories. They cover handoffs, repeated fixes, disagreement, stale
approvals, invalid responses, blocked fixes, commit/push failures, concurrent PR
changes, timeouts, interruption, and workspace
selection without fixed agent files, `.env` precedence, report folders, model
arguments, reversed reviewer order, and two models from the same provider.

The integrations use [Claude's CLI](https://code.claude.com/docs/en/cli-reference)
and [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/).

## License

[MIT](LICENSE) © 2026 metaufiq.

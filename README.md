# PR Review

Run two configurable reviewers and exchange their full findings and counter-reviews
until both approve the same PR revision. The default pair is Claude → Codex.

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

Requires Node.js 22 or newer, authenticated `gh`, and the selected `claude` and/or
`codex` CLIs. `npm install` installs the TypeScript development tools;
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
PR_REVIEW_REVIEWERS='[{"provider":"claude"},{"provider":"codex"}]'
```

The tool reads its own `.env` from any calling directory. Exported environment
variables take precedence over `.env`; `--dev-dir` takes precedence over both.
Environment paths resolve relative to this tool's repository; a relative
`--dev-dir` resolves from your terminal's current directory. Use absolute paths
for folders outside that layout. `.env` is ignored by Git.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PR_REVIEW_DEV_DIR` | `../dev` | Workspace for all CLI processes and reviewer configuration |
| `PR_REVIEW_REPORTS_DIR` | `<dev-dir>/sessions/pr-reviews` | Parent folder for per-run prompts, captures, reviews, logs, and summary |
| `PR_REVIEW_REVIEWERS` | `[{"provider":"claude"},{"provider":"codex"}]` | Exactly two reviewer objects, in execution order |

Each reviewer has a `provider` (`claude` or `codex`) and an optional `model`.
Omit `model` to retain the CLI/agent's configured model. Use model IDs or aliases
available to your authenticated CLI account.
Invalid JSON, unsupported providers, extra fields, and empty model values fail
before any CLI is launched.

Supported providers are defined in the code in `lib/providers.ts`. Each entry
configures the CLI command, argument builder, and output reader. Add an entry
there to support another provider.
An unlisted provider raises an error naming it and listing the supported providers.

Reverse the objects to run Codex first, or select two models from one provider:

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

## Review behavior

Claude runs in plan mode without interactive permission prompts. Codex runs in a
read-only sandbox with approvals disabled. Both retain their workspace
configuration, skills, and authentication. Explicit models are passed
through `--model`. Codex also receives the selected model as its default subagent
model; the prompt requires any delegated reviewer to use the requested model.
If a selected agent pins a different model or the requested model is unavailable,
the prompt requires a blocked verdict. Leaving the model unset preserves existing
model selection.

The script captures PR metadata, comments, reviews, CI status, and the diff before
each round. The agents can read those captures without command network access.
If essential evidence is unavailable, the review must remain blocked.

Success requires both reviewers to return `approve` or `approve_with_nits` with no
blockers for the same head and base commits in one round. Optional nits are
accepted; required fixes prevent approval. If either commit changes during a
review, previous verdicts are discarded and a new round starts.

The default limit is five rounds and 30 minutes per reviewer. The tool reviews
only: apply required fixes separately and rerun it. GitHub reviews and merging
remain manual.

Prompts, captures, raw CLI logs, full reviews, and `summary.json` are saved under
`PR_REVIEW_REPORTS_DIR`, or `<dev-dir>/sessions/pr-reviews/` by default. Summaries
identify each reviewer slot, provider, and requested model. Reports may contain
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
tests/               # Integration tests and fake CLI fixtures
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
runner. Tests use fake CLI executables, with this tool and its LLM workspace
in separate sibling directories. They cover handoffs, disagreement, stale
approvals, invalid responses, failures, timeouts, interruption, and workspace
selection without fixed agent files, `.env` precedence, report folders, model
arguments, reversed reviewer order, and two models from the same provider.

The integrations use [Claude's CLI](https://code.claude.com/docs/en/cli-reference)
and [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/).

## License

[MIT](LICENSE) © 2026 metaufiq.

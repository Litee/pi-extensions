# Agent Instructions

## Scope — Owned Repos Only

This agent only makes changes inside this repository.

**Do NOT touch `/path/to/other-repo`** or any other repo. If an issue in the tracker points at a package that lives outside this repo, add a comment explaining it is out of scope and stop — do not implement anything.

## Package Manager

Use **npm** (workspaces): `npm install`, `npm test`, `npm run check`.

## File-Scoped Commands

| Task | Command |
|------|---------|
| Run one test file | `npx vitest run packages/<pkg>/test/<name>.test.ts` |
| Typecheck one package | `npx tsc -b packages/<pkg>` |
| Typecheck + all tests | `npm run check` |

## Key Conventions

- TDD: write a failing vitest test before the code that makes it pass. Applies to new extensions and behaviour changes to existing ones. Bug fixes need a regression test that fails on `main` first.
- **End-to-end testing of TUI or session-lifecycle behaviour must use the `test-pi-extensions` skill.** Load it before starting any E2E test that requires a live pi session (widget rendering, `triggerTurn`, extension interactions, session resume). Do not improvise the herdr pane setup — the skill documents the exact gotchas (session bleed, worktree package loading, `pi --no-session`, anchoring panes to `$HERDR_PANE_ID` instead of focus).
- Keep the extensions table in `README.md` alphabetically sorted.
- **Extension startup cost / jiti:** before optimising extension load time or reasoning about why startup is slow, read [`docs/jiti.md`](docs/jiti.md) — it documents how `pi` loads extensions through jiti, the warm-cost decomposition, and which levers (precompile/bundle) actually help vs. don't (native type-stripping).
- Any package that is a copy or port of code from another project MUST have an `UPSTREAM.md` at the package root recording: upstream repository URL, upstream file path, upstream commit hash + date + subject at the time of copy, which local files are covered, any intentional local divergence, and a `git log --follow <base>..origin/HEAD` recipe for spotting future upstream changes. Packages originally authored in this repo do NOT get an `UPSTREAM.md`. See `packages/pi-session-recap/UPSTREAM.md` for the canonical shape.

## Issue Fixing Workflow

- Each issue gets its own worktree named after the issue (e.g. `fix-use-cmux-terminal-0008`). Exception: closely related issues touching the same file(s) that would produce a coherent single commit may share one worktree.
- **All implementation work MUST be done by a subagent — never directly by the primary agent.** The primary agent's role is: read the issue, investigate the relevant source files, form the fix plan, dispatch a subagent with a precise prompt, review the diff the subagent produces, then commit + merge after user approval. The primary agent must not write source or test code itself.
- Dispatch one sub-agent per worktree so independent issues are worked on concurrently and the main session stays uncluttered.
- Mark an issue `done` only after its fix is merged into `main`, not when committed to a worktree branch.

## Git Workflow

Per-issue sequence; do not skip or reorder:

1. Create a worktree: `git worktree add .worktrees/<branch-name> -b <branch-name>`. Make all changes inside it; keep the main repo clean.
2. Implement and test inside the worktree.
3. Present changes to the user for review. Do not commit yet.
4. Commit only after the user reviews the worktree diff and explicitly confirms. No speculative or "save progress" commits.
5. Rebase onto `main` from inside the worktree: `git fetch origin main && git rebase origin/main`.
6. **Re-run all health checks after the rebase, every time.** A rebase changes the merge base, so checks that passed before it can fail after it. Run the full suite — `npm run check` (lint + TypeScript typecheck + tests with coverage). Coverage thresholds are global, so run the whole suite, not just the rebased packages. **If lint, typecheck, tests, or coverage fail, STOP — do not fast-forward merge.** Report the failure and wait. Never proceed to the merge step on a red checkout.
7. Ask for explicit confirmation before merging the worktree branch into `main`.
8. Merge fast-forward only from the main repo: `git merge --ff-only <branch-name>`. Never create merge commits.
9. Remove the worktree after a successful merge: `git worktree remove .worktrees/<branch-name>`.

### Standing rules (apply at all times)

- **Never use placeholder git identity.** Test code that sets `git config user.name "Test"` or `user.email "test@test.com"` must scope those values to the temp repo only (pass `--local` or use `-C <tmpdir>`). Never write them to the global or system config, and never commit to this repo with author name `Test` or email `test@test.com`.
- **Never push.** All pushes to `origin` for this repo are done manually by the user. Do not run `git push`, do not offer to push after a merge, and do not treat `main` being "ahead of `origin/main`" as something to resolve — the user decides when publishing happens. If a rebase step needs the remote tip, `git fetch origin main` is fine; push is not.
- **Never run `git filter-branch`.** It sets `core.bare = true` as a side effect and leaves the flag set if interrupted, corrupting the working tree. Use `git filter-repo` instead — it rewrites history without touching repo configuration (`brew install git-filter-repo`).
- **Never switch repository configuration without explicit human confirmation.** Do not change git settings that alter the repository's identity or layout — including `core.bare`, `core.worktree`, `core.repositoryformatversion`, remotes (`git remote add/remove/set-url`), `git config` writes at `--local`/`--global`/`--system` scope, `extensions.*`, hooks path (`core.hooksPath`), or converting between bare and non-bare. Read-only inspection (`git config --get ...`, `git config --list`) is always fine. If a task seems to require a config change, surface the exact command and why, and wait for explicit approval before running it.
- **Do not announce "main is N commits ahead of origin/main"** in status summaries, post-merge reports, or anywhere else. The user already knows. It is not actionable information for them.
- **No transient `.md` files in worktrees or the main repo.** Sub-agent output files, result summaries, and any other scratch files must go in `/tmp`, not inside a worktree or the repo root. Files written to the repo are candidates for accidental commits and create noise in `git status`.
- **Never use a captured `ctx` (or `pi`) inside a `setInterval`/`setTimeout`/deferred callback.** A `ctx` captured in an event handler (e.g. `session_start`) becomes stale after a session replacement or reload (`ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, `await ctx.reload()`). When a later timer fires, pi's `assertActive` throws **synchronously** from calls like `pi.getSessionName()` — and because that throw happens *before* the async body, wrapping the call in `.catch()` does **not** catch it. The result is an `uncaughtException` that **crashes the whole pi process** (`Error: This extension ctx is stale after session replacement or reload`). This bit the `pi-herdr-integration` poll timer repeatedly. Rules: (1) prefer event hooks (`agent_end`, `session_start`) and explicit commands over background timers; (2) if a timer is unavoidable, re-fetch a fresh `ctx`/value inside the callback rather than closing over one, and guard the *synchronous* part in a `try/catch` (not just a promise `.catch()`); (3) clear every timer on `session_shutdown`. When in doubt, do not use a timer at all.
- **Never merge when checks are failing.** Before any FF-merge into `main`, all of the following must pass: lint, TypeScript typecheck, and tests for the affected packages. The run that gates the merge must be the one **after** the final rebase (step 6) — a clean check from before the rebase does not count. If any check fails, stop and report the failure to the user — do not merge. The only exception is if the user explicitly instructs you to ignore specific failures (e.g. "pre-existing failures are fine" or "ignore the lint errors"). Pre-existing failures on `main` that are unrelated to the branch being merged are acceptable only if confirmed by stashing the branch changes and reproducing the same failures on the base commit.

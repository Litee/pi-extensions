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
- Keep the extensions table in `README.md` alphabetically sorted.
- Any package that is a copy or port of code from another project MUST have an `UPSTREAM.md` at the package root recording: upstream repository URL, upstream file path, upstream commit hash + date + subject at the time of copy, which local files are covered, any intentional local divergence, and a `git log --follow <base>..origin/HEAD` recipe for spotting future upstream changes. Packages originally authored in this repo do NOT get an `UPSTREAM.md`. See `packages/pi-session-recap/UPSTREAM.md` for the canonical shape.

## Issue Fixing Workflow

- Each issue gets its own worktree named after the issue (e.g. `fix-use-cmux-terminal-0008`). Exception: closely related issues touching the same file(s) that would produce a coherent single commit may share one worktree.
- Dispatch one sub-agent per worktree so independent issues are worked on concurrently and the main session stays uncluttered.
- Mark an issue `done` only after its fix is merged into `main`, not when committed to a worktree branch.

## Git Workflow

Per-issue sequence; do not skip or reorder:

1. Create a worktree: `git worktree add .worktrees/<branch-name> -b <branch-name>`. Make all changes inside it; keep the main repo clean.
2. Implement and test inside the worktree.
3. Present changes to the user for review. Do not commit yet.
4. Commit only after the user reviews the worktree diff and explicitly confirms. No speculative or "save progress" commits.
5. Rebase onto `main` from inside the worktree: `git fetch origin main && git rebase origin/main`.
6. Ask for explicit confirmation before merging the worktree branch into `main`.
7. Merge fast-forward only from the main repo: `git merge --ff-only <branch-name>`. Never create merge commits.

### Standing rules (apply at all times)

- **Never push.** All pushes to `origin` for this repo are done manually by the user. Do not run `git push`, do not offer to push after a merge, and do not treat `main` being "ahead of `origin/main`" as something to resolve — the user decides when publishing happens. If a rebase step needs the remote tip, `git fetch origin main` is fine; push is not.
- **Do not announce "main is N commits ahead of origin/main"** in status summaries, post-merge reports, or anywhere else. The user already knows. It is not actionable information for them.

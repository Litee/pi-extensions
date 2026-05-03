# Agent Instructions

## Package Manager

Use **npm** (workspaces): `npm install`, `npm test`, `npm run check`.

## File-Scoped Commands

| Task | Command |
|------|---------|
| Run one test file | `npx vitest run packages/<pkg>/test/<name>.test.ts` |
| Typecheck one package | `npx tsc -b packages/<pkg>` |
| Typecheck + all tests | `npm run check` |

## Key Conventions

- Strict TDD for new extensions and changes to existing ones.
- Keep the extensions table in `README.md` alphabetically sorted.

## Issue Fixing Workflow

- Each issue gets its own worktree named after the issue (e.g. `fix-use-cmux-terminal-0008`). Exception: closely related issues touching the same file(s) that would produce a coherent single commit may share one worktree.
- Dispatch one sub-agent per worktree so independent issues are worked on concurrently and the main session stays uncluttered.
- Mark an issue `done` only after its fix is merged into `main`, not when committed to a worktree branch.

## Git Workflow

Follow this sequence; do not skip or reorder:

1. Create a worktree: `git worktree add .worktrees/<branch-name> -b <branch-name>`. Make all changes inside it; keep the main repo clean.
2. Implement and test inside the worktree.
3. Present changes to the user for review. Do not commit yet.
4. Commit only after the user reviews the worktree diff and explicitly confirms. No speculative or "save progress" commits.
5. Rebase onto `main` from inside the worktree: `git rebase origin/main`.
6. Merge fast-forward only from the main repo: `git merge --ff-only`. Never create merge commits.
7. Ask for explicit confirmation before merging any worktree branch into `main`.

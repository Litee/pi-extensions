---
name: rebase-experimental-worktrees
description: >
  Rebase all experimental-* worktrees in this monorepo onto the latest main
  branch. Skips any worktree that has uncommitted changes and prints a summary
  table. Use when asked to "rebase experimental worktrees", "sync experimental
  branches to main", "rebase experimental-*", or
  "/rebase-experimental-worktrees".
---

# rebase-experimental-worktrees

Rebase every `experimental-*` worktree in this monorepo onto `main`, skipping any that have uncommitted changes.

## Step 0 — Locate the repo root

Use the current working directory, or resolve it with:

```bash
git rev-parse --show-toplevel
```

This is `<repo-root>` throughout the steps below.

## Step 1 — List experimental worktrees

Run:

```bash
git -C <repo-root> worktree list --porcelain
```

Parse stanzas that contain a `branch` line matching `refs/heads/experimental-*`. For each, record:
- `worktree` — absolute path from the `worktree` line
- `branch` — short name (strip `refs/heads/`)

If no matching worktrees are found, print "No experimental-* worktrees found." and stop.

## Step 2 — Check for uncommitted changes

For each experimental worktree, run:

```bash
git -C <worktree-path> status --porcelain
```

- If output is **non-empty** → mark as **dirty** (skip rebase, count the dirty files).
- If output is **empty** → mark as **clean** (proceed to rebase).

## Step 3 — Rebase clean worktrees onto main

For each clean worktree, first capture the commit count that will be replayed:

```bash
git -C <worktree-path> rev-list --count main..HEAD
```

Then rebase:

```bash
git -C <worktree-path> rebase main
```

- On **success** → mark as **rebased**, record the commit count from above.
- On **conflict** → abort immediately and mark as **conflict**:

```bash
git -C <worktree-path> rebase --abort
```

> Note: Do NOT fetch from remote first. The monorepo may have no remote access.
> Rebase against the local `main` ref only.

## Step 3.5 — Run `npm install` after each successful rebase

After each successful rebase, run `npm install` in the worktree to ensure `node_modules` is up to date before health checks:

```bash
cd <worktree-path> && npm install --silent
```

This is required because worktrees do not automatically inherit `node_modules` from the repo root, and eslint/typecheck/tests will silently fail or skip if binaries like `node_modules/.bin/eslint` are missing.

## Step 4 — Print summary table

Print a markdown table with one row per `experimental-*` worktree:

| Branch | Status | Result |
|--------|--------|--------|
| `experimental-foo` | ✅ rebased | 3 commits replayed onto `main` |
| `experimental-bar` | ⚠️ skipped — dirty (10 modified files) | — |
| `experimental-baz` | ❌ conflict — aborted | — |

Finish with a one-line note listing any skipped (dirty) or aborted (conflict) worktrees by name, so the user knows which need manual attention.

## Gotchas

1. **`npm install` dirties `package-lock.json`** — running it post-rebase leaves a modified lockfile in the worktree. Restore it with `git checkout -- package-lock.json` after installing, or skip install if worktrees already share root `node_modules`.

2. **`--onto` rebase leaves detached HEAD** — the branch ref is not updated automatically. Always force-update: `git branch -f <branch> HEAD` then `git checkout <branch>`.

3. **Broken worktree (missing `.git` file)** — a worktree with only `package-lock.json` on disk and no `.git` silently runs all `git -C` commands against the parent repo. Verify the path contains a `.git` file before rebasing; recreate with `git worktree add` if missing.

4. **Stale rebase state** — a leftover `rebase-merge/` directory from a previous failed attempt blocks new rebases. Check for and remove it: `rm -fr <repo>/.git/worktrees/<wt>/rebase-merge`.

5. **`--skip` on README conflicts can drop content** — a commit that conflicts only on README may contain other real changes. Always inspect the full diff with `git show <commit>` before skipping.

6. **Test fixture commits leaking into branch history** — if tests create temp git repos without `--local` identity config, those commits can become reachable from the branch. Warn if any commit above `main` has an unexpected author identity (e.g. `Test <test@test.com>`).

7. **`core.bare = true` breaks worktrees** — if set, git operations behave unexpectedly. Add a pre-flight check: `git config core.bare` must return `false`.

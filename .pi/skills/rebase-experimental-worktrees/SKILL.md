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

## Step 4 — Print summary table

Print a markdown table with one row per `experimental-*` worktree:

| Branch | Status | Result |
|--------|--------|--------|
| `experimental-foo` | ✅ rebased | 3 commits replayed onto `main` |
| `experimental-bar` | ⚠️ skipped — dirty (10 modified files) | — |
| `experimental-baz` | ❌ conflict — aborted | — |

Finish with a one-line note listing any skipped (dirty) or aborted (conflict) worktrees by name, so the user knows which need manual attention.

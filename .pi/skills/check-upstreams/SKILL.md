---
name: check-upstreams
description: >
  Check all copied/ported extensions in this monorepo for new upstream commits
  and port any relevant changes. Use when asked to "check upstreams", "sync
  upstream extensions", "check for upstream changes", or "/check-upstreams".
  Do NOT use for packages that do not have an UPSTREAM.md — those are original
  packages with no upstream to track.
---

# check-upstreams

Check every package that ships an `UPSTREAM.md` in this monorepo for new commits in its upstream repository, and port any relevant changes.

## Step 1 — Discover upstreams

Read every file matching `packages/*/UPSTREAM.md` in the repo root (use `cwd`).

For each file extract:
- **Package name** — the directory name (e.g. `pi-btw`)
- **Clone URL** — from the `git clone` line in the *How to check for upstream changes* shell recipe
- **Extra clone flags** — e.g. `--filter=blob:limit=200k`, if present
- **Last synced SHA** — from the `**Last synced:**` line
- **Full `git log` command** — copy the complete `git log` line from the `## How to check for upstream changes` code block verbatim; do not reconstruct it
- **Clone slug** — the suffix after `UP=$(mktemp -d)/`

## Step 2 — Dispatch parallel sub-agents

Dispatch one `andrey-worker` sub-agent **per package** with `run_in_background: true` so all checks run concurrently.

Pass each sub-agent the full text of its `UPSTREAM.md`, the local package path, and the repo root.

### Per-sub-agent instructions

1. **Clone** the upstream repo into a temp dir:
   ```bash
   UP=$(mktemp -d)/<slug>
   git clone --quiet [extra-flags] <clone-url> "$UP"
   ```

2. **Check for SHA then list new commits**:
   ```bash
   # Verify the last-synced SHA exists (detects force-push / history rewrite)
   git -C "$UP" cat-file -e <last-sha> || { echo "last-synced SHA not found — manual inspection required"; exit 0; }

   # Run the exact git log command from UPSTREAM.md, adding --oneline
   <verbatim git log line from UPSTREAM.md> --oneline
   ```
   Use the command verbatim from UPSTREAM.md — do not reconstruct it. Each UPSTREAM.md was written to work correctly for its tracked paths (some use `--follow`, some don't; some have multiple paths, some have none).

3. **If zero new commits** — report "no new commits" and stop.

4. **If new commits exist:**

   a. View the diff:
      ```bash
      git -C "$UP" diff <last-sha>..origin/HEAD [-- <tracked-paths>]
      ```

   b. Read the local package's source files and `README.md` (the *Differences from upstream* section) to understand intentional local divergences that must **not** be overwritten.

   c. Assess which changes are worth porting. Skip: CI configs, changelog-only commits, unrelated refactors that don't touch the locally ported files.

   d. Port the relevant changes, adapting for documented local divergences.

   e. Update `packages/<pkg>/UPSTREAM.md`:
      - Retrieve the canonical new HEAD SHA, subject, and date:
        ```bash
        git -C "$UP" log -1 --format="%H %s (%ad)" --date=short origin/HEAD
        ```
      - Set **Last synced** to the new HEAD SHA, commit subject, and date
      - Update the SHA in the `git log` shell recipe to match

   f. Run `npm run check` from the repo root to verify the build and tests pass.

   g. Show the local diff: `git -C <repo-root> diff`

   h. **Do NOT commit** — present changes for user review first.

> `pi-built-in-tool-renderer` and `pi-plan-mode` both track different paths inside `badlogic/pi-mono`. Their sub-agents clone the same repo into separate temp dirs — this is intentional and safe because each sub-agent runs its own `mktemp -d`, producing a unique parent directory (e.g. `/tmp/abc123/pi-mono` vs `/tmp/def456/pi-mono`).

## Step 3 — Summarise

Collect all sub-agent results with `get_subagent_result` (wait: true for each) and present a summary table:

| Package | Upstream | New commits | Action taken |
|---------|----------|-------------|--------------|
| pi-btw | dbachelder/pi-btw | 3 | Ported 2; skipped 1 (CI only) |
| pi-plan-mode | badlogic/pi-mono | 0 | None |
| … | … | … | … |

If any package has uncommitted local changes, remind the user to review the diffs before committing.

## Error handling

- **Clone fails** (repo deleted or made private): report "upstream unavailable" for that package and continue with the rest; do not abort the whole run.
- **Last-synced SHA missing from upstream** (force push or history rewrite): `git log <sha>..HEAD` fails with a confusing `fatal: ambiguous argument` error. Detect this early with `git -C "$UP" cat-file -e <sha>` before running the log. If the SHA is absent, report "last-synced SHA not found — manual inspection required" and skip porting.
- **`npm run check` fails after porting**: Do not leave the tree in a broken state. Report the failure output to the user and note which files were modified so they can triage.

## Gotchas

- **Slug collision is safe**: `pi-built-in-tool-renderer` and `pi-plan-mode` both use slug `pi-mono`, but each sub-agent calls its own `mktemp -d`, so their clone paths are in different temp directories — no conflict.
- **Use the verbatim `git log` from UPSTREAM.md**: do not reconstruct the command. `--follow` requires exactly one pathspec on modern git — reconstructing the command risks breaking packages with zero or multiple tracked paths.
- **Only commit after user approval**: sub-agents must never commit — always `git diff` and surface changes for review first.

## Related Skills

- `andrey-worker` — the sub-agent type dispatched per package; handles multi-step clone/diff/port loops. This agent type is defined in the project's `AGENTS.md` and is not available globally — do not move this skill to `~/.pi/agent/skills/` without also making `andrey-worker` available globally.

## References

- `AGENTS.md` in the repo root documents the `UPSTREAM.md` convention every ported package must follow.

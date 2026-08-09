# Upstream

This package is a local design port/adaptation of an upstream extension. Use
the information below to diff against upstream and pick up future changes.

## Source

- **Repository:** [`cursor/plugins`](https://github.com/cursor/plugins) (official Cursor / Anysphere plugins repo)
- **Upstream path:** `continual-learning/`
- **License:** MIT, © 2026 Cursor

## Ported versions

- **Initially ported:** `ac93d26` — "Simplify continual-learning to one subagent", authored 2026-03-13 by ericzakariasson <eric@anysphere.co> (local commit `4dad3f2`). This commit introduced the one-subagent architecture that our package mirrors.
- **Last synced:** `ac93d26` (upstream unchanged since anchor; three memory-updater skill contracts — create-with-only-these-sections, explicit semantic dedup, 12-bullet cap — ported 2026-08-08).

The upstream plugin content is unchanged from `ac93d26` to `origin/HEAD`
except a `hooks.json` command-path variable, so `ac93d26` is the correct
anchor for diffing.

**Files whose design was ported:**

- `continual-learning/hooks/continual-learning-stop.ts` (trigger/cadence logic)
- `continual-learning/skills/continual-learning/SKILL.md` (skill)
- `continual-learning/agents/agents-memory-updater.md` (the memory-updater subagent)

**Local files covered:** `packages/pi-continual-learning/src/*.ts`,
`packages/pi-continual-learning/skills/continual-learning/SKILL.md`,
`packages/pi-continual-learning/test/*.ts`

## Differences from upstream

1. **Runtime:** Cursor = `stop` hook + skill + subagent (Bun). pi = `agent_settled` extension hook + skill + subagent (TypeScript via pi extension API).
2. **Trigger event:** Cursor's `stop` hook fires on `status === "completed" && loop_count === 0`. pi version listens on `agent_settled` (fires only after any retry, auto-compaction, or queued follow-up drain is ruled out), guarded by `ctx.isIdle()` so a run another extension already started from its own `agent_settled` handler is never counted; success is detected by scanning the settled session's last assistant message `stopReason ∉ {error, aborted}` (`agent_settled` carries no message payload).
3. **New-content dedup:** Cursor uses `lastProcessedGenerationId` + transcript-file `mtime`. pi version has no transcript files, so it uses a `processedMarker` = `sessionId:leafId` computed from session content.
4. **Env vars:** `CONTINUAL_LEARNING_*` (with `CONTINUOUS_LEARNING_*` legacy) → `PI_CONTINUAL_LEARNING_*`.
5. **Section names & no-op contract are identical:** `## Learned User Preferences` / `## Learned Workspace Facts` and the exact string `No high-signal memory updates.` are kept verbatim from upstream. The three memory-updater contracts from `agents-memory-updater.md` (create-with-only-these-sections, explicit semantic dedup, 12-bullet cap) are also kept.
6. **Trial mode identical:** 3 turns / 15 min / 24 h, matching upstream's `TRIAL_DEFAULT_MIN_TURNS = 3`, `TRIAL_DEFAULT_MIN_MINUTES = 15`, `TRIAL_DEFAULT_DURATION_MINUTES = 24 * 60`.

## How to check for upstream changes

```bash
UP=$(mktemp -d)/cursor-plugins
git clone --quiet https://github.com/cursor/plugins.git "$UP"
git -C "$UP" log ac93d26..origin/HEAD -- continual-learning/hooks/continual-learning-stop.ts continual-learning/skills/continual-learning/SKILL.md continual-learning/agents/agents-memory-updater.md
```

Note: `git log --follow` with a directory or multiple-file pathspec errors on
some git versions ("--follow requires exactly one pathspec"), so the recipe
uses plain `git log` (no `--follow`) with the individual ported files. Use
`--follow` with a single file if you need rename detection for one path.

# pi-local-issues-watcher

Pi extension that watches a **local-skill-issues-tracker** database on disk
and injects issue change notifications into the pi chat as custom
`issue-watcher` messages (identical delivery pattern to the built-in
`slack-watcher`).

This is a greatly simplified TypeScript port of
[`watch_issues.py`](https://github.com/litee/claude-code-plugins/blob/main/local-skill-issues-tracker/skills/use-local-skills-issue-tracker/scripts/watch_issues.py)
with three material differences:

1. **No keystroke bridges.** Changes are delivered exclusively through
   `pi.sendMessage({customType: "issue-watcher", ...}, {triggerTurn: true})`.
2. **No external state file / PID lock.** The previous snapshot is stored via
   `pi.appendEntry("issue-watcher-state", ...)` with a 24 h TTL, so it
   auto-resumes through session restart without a separate state directory.
3. **Single fixed dbRoot per process.** Configured via the
   `LOCAL_ISSUE_TRACKER_DB_ROOT` environment variable (default:
   `~/.claude/plugin-data/local-skill-issues-tracker/use-local-skills-issue-tracker/db`).

## Activation

Enable per-project only — add this workspace's `packages/*/src/index.ts`
glob to the project's pi config, or run pi inside a workspace whose
`package.json` already declares:

```json
{
  "pi": { "extensions": ["packages/*/src/index.ts"] }
}
```

(Matches the monorepo root `package.json` in this repository.)

## What it does

On every `session_start`:

1. Resolve `dbRoot` from `$LOCAL_ISSUE_TRACKER_DB_ROOT` (or the default path).
2. If the directory does not exist → `ctx.ui.notify(...)` and bail out.
3. Scan all `<dbRoot>/<skill>/NNNN-slug.json` files into a `Snapshot`.
4. Rehydrate any baseline snapshot from the session log (< 24 h old).
5. If a baseline exists **and** the current on-disk state differs, emit **one**
   chat message summarising every change (status, title/description update,
   comment added/removed, file added/removed). The message carries:
   - `customType: "issue-watcher"`
   - `content`: a human-readable summary (`N issue update(s)` + bullet list)
   - `details: { changes, changedPaths }` for programmatic consumers
   - delivery: `{ deliverAs: "followUp", triggerTurn: true }` — the agent is
     prompted to react.
6. Persist the new snapshot as the baseline.
7. Start a `setInterval` poll loop at 60 s that repeats steps 3–6.

## Slash commands

| Command                     | Effect                                           |
|-----------------------------|--------------------------------------------------|
| `/issue-watcher`            | Print current state (running / paused, dbRoot, issue counts by status). |
| `/issue-watcher status`     | Alias for the above.                             |
| `/issue-watcher pause`      | Stop polling (state is kept in memory).          |
| `/issue-watcher resume`     | Rebuild the baseline from disk and resume polling. |

## Package layout

```
src/
  types.ts         — IssueInfo, Snapshot
  scanner.ts       — scanIssueFiles(dbRoot) : Snapshot
  diff.ts          — diffSnapshots, changedPaths, formatChange
  format.ts        — buildChatMessageContent, formatStatusSummary
  persistence.ts   — rehydrateFromSession, STATE_ENTRY_TYPE, STATE_MAX_AGE_MS
  index.ts         — default export + handleSessionStart (testable)
test/
  scanner.test.ts
  diff.test.ts
  format.test.ts
  persistence.test.ts
  index.test.ts
```

All pure-function modules are unit-tested; the lifecycle wiring in
`index.ts` is covered by `test/index.test.ts` with a stubbed `ExtensionAPI`.

## Security notes

- No network. No `http`, `https`, `net`, `dns`, `fetch`.
- Filesystem access limited to: reading under `dbRoot` (`readdirSync`,
  `readFileSync`, `statSync`, `existsSync`).
- No process spawns, no dynamic imports, no `eval` / `Function(...)`.
- Persistence goes through `pi.appendEntry` only — no writes to arbitrary
  paths.

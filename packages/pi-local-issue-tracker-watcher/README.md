# pi-local-issue-tracker-watcher

Pi extension that watches a **local-skill-issues-tracker** database on disk
and injects issue change notifications into the pi chat as custom
`local-issue-watcher` messages (identical delivery pattern to the built-in
`slack-watcher`).

This is a greatly simplified TypeScript port of
[`watch_issues.py`](https://github.com/litee/claude-code-plugins/blob/main/local-skill-issues-tracker/skills/use-local-skills-issue-tracker/scripts/watch_issues.py)
with three material differences:

1. **No keystroke bridges.** Changes are delivered exclusively through
   `pi.sendMessage({customType: "local-issue-watcher", ...}, {triggerTurn: true})`.
2. **No external state file / PID lock.** The previous snapshot is stored via
   `pi.appendEntry("pi-local-issue-tracker-watcher-state", ...)` with a 24 h
   TTL, and the user's explicit pause/resume preference via
   `pi.appendEntry("pi-local-issue-tracker-watcher-runstate", ...)` (no TTL)
   — so the watcher auto-resumes through session restart or plugin
   reload without a separate state directory. All session-log keys
   carry the full package-name prefix (#0020) to keep the shared pi
   session-log namespace collision-free; legacy entries from the
   pre-#0017 rename (`issue-watcher-state` / `-runstate`) and from
   #0017…#0019 (`local-issue-watcher-state` / `-runstate`) are still
   read on rehydrate so in-flight session logs survive the cutover;
   new entries are always written under the new names.
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
4. Pin a one-line **status entry** to the extension-status row via
   `ctx.ui.setStatus("pi-local-issue-tracker-watcher", ...)` (the key is
   prefixed with the full package name per #0020, though the rendered
   line keeps the shorter `local-issue-watcher:` label to save footer
   width) — e.g.
   `local-issue-watcher: active | /h/u/p/tracker | poll=60s | 3 open, 1 in_progress` —
   the `dbRoot` is compacted via `abbreviatePath` (every intermediate
   segment collapsed to its first grapheme; leading dotfile segments
   keep their `.`). The inline `/local-issue-watcher status` notify
   and the pause/resume notifications keep the full absolute path so
   the user can copy-paste it.
   so the user can see the watcher is running and which `dbRoot` is in
   effect without running a slash command. This line is persistent (lives
   below the main status line, like `slack-watcher`) and never triggers an
   agent turn. `/local-issue-watcher pause` / `/local-issue-watcher resume` update the
   same entry with `state=paused` / `state=resumed`. `session_shutdown`
   clears it.
5. Rehydrate any baseline snapshot from the session log (< 24 h old).
6. Rehydrate the user's last explicit **run state** (paused / running)
   from the session log. Absent entry → default **paused** (#0012). A
   fresh pi session stays quiet until the user opts in with
   `/local-issue-watcher resume`; the pinned status line reads `paused`, no
   startup chat message is emitted, and no poll loop starts. Only an
   explicit `paused=false` run-state entry (from a prior
   `/local-issue-watcher resume` in the same session log) flips this to
   **running**. This is what makes pause/resume survive plugin reload
   and `session_start` with `reason: "resume"`.
7. If a baseline exists **and** the watcher is not paused **and** the
   current on-disk state differs, emit **one** chat message summarising
   every change (status, title/description update, comment added/removed,
   file added/removed). The message carries:
   - `customType: "local-issue-watcher"`
   - `content`: a human-readable summary (`N issue update(s)` + bullet list)
   - `details: { changes, changedPaths }` for programmatic consumers
   - delivery: `{ deliverAs: "followUp", triggerTurn: true }` — the agent is
     prompted to react.
8. Persist the new snapshot as the baseline.
9. Start a `setInterval` poll loop at 60 s that repeats steps 3–8 — but
   only if the rehydrated run state is running.

## Slash commands

| Command                     | Effect                                           |
|-----------------------------|--------------------------------------------------|
| `/local-issue-watcher`            | Print current state (running / paused, dbRoot, issue counts by status). |
| `/local-issue-watcher status`     | Alias for the above.                             |
| `/local-issue-watcher pause`      | Stop polling, persist `paused=true` to session state so the extension stays quiet across reload / session resume. |
| `/local-issue-watcher resume`     | Rebuild the baseline from disk, persist `paused=false`, and resume polling. |

## Package layout

```
src/
  types.ts         — IssueInfo, Snapshot
  scanner.ts       — scanIssueFiles(dbRoot) : Snapshot
  diff.ts          — diffSnapshots, changedPaths, formatChange
  format.ts        — buildChatMessageContent, formatStatusSummary
  persistence.ts   — rehydrateFromSession, rehydrateRunStateFromSession,
                     STATE_ENTRY_TYPE, RUNSTATE_ENTRY_TYPE, STATE_MAX_AGE_MS
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

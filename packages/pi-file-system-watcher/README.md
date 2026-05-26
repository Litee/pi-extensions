# pi-file-system-watcher

Pi extension that watches a single local filesystem path (file or
directory) for **existence**, **change**, or **removal**. When the
watched condition is met — or when an optional per-watch timeout
elapses — it fires exactly one chat notification (`customType:
"pi-file-system-watcher"`, `triggerTurn: true`) and marks the watch terminal.

The `file_system_watcher` tool is registered into pi's tool registry at
`session_start` but starts **inactive**. The LLM must activate it
before use:

```
manage_tools({"action": "activate", "tools": ["file_system_watcher"]})
```

`manage_tools` is provided by the `pi-tools-management-tool` extension
(peer dependency). The tool becomes callable on the next turn after
activation.

## Detection model

Two detection layers work together for reliability:

1. **`fs.watch` (event-driven)**: when a filesystem event fires,
   an immediate `pollOnce` is triggered outside the normal schedule.
   Events are debounced (default 500 ms) to collapse rapid successive
   writes into a single stat() check.

2. **`PollScheduler` (polling)**: a back-off-aware scheduler polls
   `fs.promises.stat` at increasing intervals. This is the sole
   detection path on platforms where `fs.watch` is unavailable
   (`ENOSYS` / `EPERM`), or when watching a path that does not yet
   exist (`target: "exists"`).

The authoritative change decision is always made by comparing
`stat({ bigint: true }).mtimeNs` and `stat.size` against the stored
baseline — `fs.watch` only accelerates the next poll; it does not
fire the target event directly.

## Polling schedule

- **Base:** 5 s.
- **Idle back-off:** each quiet poll doubles the interval, up to a
  **5 min cap**.
- **Reset:** any observable change (mtime/size delta or existence flip)
  snaps the interval back to the base.
- **Re-entry guard:** a slow stat() call can never be re-entered by
  the timer or an fs.watch trigger — `pollInFlight` blocks concurrent
  invocations.

## Tool: `file_system_watcher`

| Action   | Required params | Notes |
|----------|-----------------|-------|
| `add`    | `path`, `target` | Optional: `timeoutSeconds`, `mode`. Seeds a baseline via stat(). `timeoutSeconds` defaults to 24 h (86400 s); capped at 24 h if higher. |
| `remove` | `watchId`        | Stops polling; disposes the fs.watch handle. |
| `list`   | —               | One line per watch: `[id] path target mode state`. |
| `pause`  | —               | Global. Persisted across session reload. |
| `resume` | —               | Restarts polling iff at least one non-terminal watch exists. |
| `status` | —               | Paused/active, watch counts, current poll interval. |

### Targets

| Target    | Fires when |
|-----------|------------|
| `exists`  | Baseline said absent, now present. |
| `changed` | Baseline existed, now exists, AND `mtimeNs` or `size` differs. `add` rejects this target if the path is absent at add time — there is no baseline to diff against. |
| `removed` | Baseline existed, now absent (ENOENT). |

A fired watch emits **one** bullet-list chat message then self-marks
terminal. There is no repeating notification stream.

### Timeout

`timeoutSeconds` (optional, positive number). Defaults to 24 h
(86400 s); silently capped at 24 h if higher.

### mode

`mode` (optional): `"auto"` (default) | `"event"` | `"poll"`.

| Mode     | Behaviour |
|----------|-----------|
| `auto`   | Attempt `fs.watch` for fast notifications; fall back to polling silently on any error or if the path does not exist yet. |
| `event`  | Same as `auto` — semantic alias. |
| `poll`   | Skip `fs.watch`; use polling only. Useful on network mounts, Docker volumes, or CI environments where `fs.watch` is unreliable. |

## `/file-system-watcher` command

`/file-system-watcher` (with or without arguments) opens an interactive TUI
menu via `ctx.ui.select`.

| Menu row | Effect |
|----------|--------|
| `Browse watches (N)` | Notify with the current watch list. |
| `Paused: off\|on` | Toggle global pause. Persisted across session reload. |
| `Display mode: widget\|statusline` | Flip this session's display between the status row and the widget. |
| `User default display mode: …` | Writes `defaultDisplayMode` to `~/.pi/agent/pi-file-system-watcher.json`. Seeds future sessions. |
| `Close` | Dismiss the menu. |

## User config

Optional user-level config at `~/.pi/agent/pi-file-system-watcher.json` seeds
defaults for fresh sessions:

```json
{
  "defaultDisplayMode": "statusline"
}
```

| Key | Type | Effect |
|-----|------|--------|
| `defaultDisplayMode` | `"widget"` \| `"statusline"` | Initial display mode used when no `displayMode` is persisted yet. |

Precedence: **persisted state > user config > hardcoded default
(`widget`)**. Fail-soft: missing file, invalid JSON, or unknown value
is silently ignored.

## Security notes

- No subprocess spawns. All filesystem access goes through
  `node:fs/promises`.
- Raw `stat` error messages land **only** in
  `pi.appendEntry("file-system-watcher:poll-error", …)` — never in chat, tool
  output, or the status line. User-facing text comes from
  `pi-watcher-core`'s `classifyWatcherError`.
- Persistence goes through `pi.appendEntry` only — no writes to
  arbitrary paths.

## Package layout

```
src/
  types.ts        — FsWatch, FsEvent, FsBaseline + target/mode types
  poller.ts       — snapshotPath, detectChanges, buildTimeoutEvent (pure)
  watcher.ts      — createDebounced, tryCreateFsWatch (fs.watch wrapper)
  runtime.ts      — Runtime, PollScheduler, pollOnce, setup/teardown handles
  toolAction.ts   — file_system_watcher tool registration + handler
  persistence.ts  — createPersistence delegate
  format.ts       — chat message + status-line formatters
  config.ts       — user-level config loader (~/.pi/agent/pi-file-system-watcher.json)
  command.ts      — /file-system-watcher TUI menu
  index.ts        — session lifecycle + /file-system-watcher command
skills/
  file-system-watcher/
    SKILL.md      — LLM-facing usage guide
test/
  poller.test.ts      — snapshotPath, detectChanges, buildTimeoutEvent (real FS / tmp dirs)
  watcher.test.ts     — createDebounced debounce logic
  runtime.test.ts     — pollOnce with injectable snapshot (unit)
  toolAction.test.ts  — tool handler (unit)
  persistence.test.ts — rehydrateStateFromSession, writeState (unit)
  format.test.ts      — chat message + status-line formatters (unit)
```

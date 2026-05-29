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

Change detection is **polling-only**. A back-off-aware `PollScheduler`
calls `fs.promises.stat` at increasing intervals (60 s base, up to
15 min cap). The authoritative change decision is made by comparing
`stat({ bigint: true }).mtimeNs` and `stat.size` against the stored
baseline.

## Polling schedule

- **Base:** 60 s.
- **Idle back-off:** each quiet poll doubles the interval, up to a
  **15 min cap**.
- **Reset:** any observable change (mtime/size delta or existence flip)
  snaps the interval back to the base.

## Tool: `file_system_watcher`

| Action   | Required params | Notes |
|----------|-----------------|-------|
| `add`    | `path`, `target` | Optional: `timeoutSeconds`. Seeds a baseline via stat(). `timeoutSeconds` defaults to 24 h (86400 s); capped at 24 h if higher. |
| `remove` | `watchId`        | Stops polling for the watch. |
| `list`   | —               | One line per watch: `path  status  timeout  target`. |
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

## `/file-system-watcher` command

`/file-system-watcher` (with or without arguments) opens an interactive
TUI menu (browse-view overlay) with:

| Menu row | Effect |
|----------|--------|
| `Browse paths (N)` | Open the full browse overlay. |
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
  `classifyError`.
- Persistence goes through `pi.appendEntry` only — no writes to
  arbitrary paths.

## Architecture

Built on the `pi-watcher-core` `BaseWatcher` abstract class. Domain
logic is confined to `watcher.ts`; shared poll-loop, persistence,
state management, TUI widget, and menu are inherited.

## Package layout

```
src/
  types.ts        — FsWatch, FsEvent, FsBaseline + TargetCondition types
  poller.ts       — snapshotPath, detectChanges, buildTimeoutEvent (pure)
  watcher.ts      — FsWatcher extends BaseWatcher<FsWatch, FsBaseline, FsEvent>
  fs-client.ts    — FsClient interface + createFsClient() (injectable for tests)
  toolAction.ts   — FsWatcherParams TypeBox schema + MAX_TIMEOUT_SECONDS
  format.ts       — buildChangeChatMessage (chat message formatter)
  config.ts       — user-level config loader (~/.pi/agent/pi-file-system-watcher.json)
  index.ts        — extension entrypoint
skills/
  file-system-watcher/
    SKILL.md      — LLM-facing usage guide
test/
  watcher.test.ts     — FsWatcher via executeTool + pollOnce (unit)
  poller.test.ts      — snapshotPath, detectChanges, buildTimeoutEvent (real FS / tmp dirs)
  format.test.ts      — buildChangeChatMessage (unit)
  config.test.ts      — config loader/saver (unit)
```

# pi-aws-glue-watcher

Pi extension that watches AWS Glue **job runs** and **workflow runs** for
state changes and injects one chat notification per change into the pi
session (`customType: "glue-watcher"`, `triggerTurn: true`). When a
terminal state is reached (SUCCEEDED, FAILED, STOPPED, TIMEOUT, ERROR)
the watch self-marks terminal and polling stops.

## Activation

`glue_watcher` is **registered at session_start but starts inactive**.
It appears in `manage_tools({action:"list"})` immediately; one action
is needed to make it callable. Two paths:

**Preferred — LLM activates via `manage_tools`** (no user action needed):

```
manage_tools({"action": "activate", "tools": ["glue_watcher"]})
```

The tool becomes callable on the next LLM turn. Requires the
`pi-tools-runtime-manager` extension (peer dependency).

**Escape hatch — `/glue-watcher`**: typing this in the pi editor opens an
interactive TUI menu where the user can browse watches, pause/resume
polling, and toggle display mode. Activation of the tool itself is still
done through `manage_tools` — the menu does not enable or disable it.

## Polling schedule

Polling runs on a back-off-aware scheduler from `pi-watcher-core`:

- **Base:** 60 s.
- **Idle back-off:** each quiet poll doubles the interval, up to a
  **15 min cap**.
- **Reset:** any observable state change snaps the interval back to
  the base.
- **Throttle / auth back-off:** a `CredentialsProviderError`,
  `ExpiredToken`, or throttling exception doubles the effective interval
  without touching the idle base.
- **Re-entry guard:** a slow API call can never be re-entered by the
  timer — the next tick is scheduled from the END of the previous tick.

When every watch is terminal the poll loop stops.

## Tool: `glue_watcher`

| Action   | Required params              | Optional params        | Notes                                             |
|----------|------------------------------|------------------------|---------------------------------------------------|
| `add`    | `type`, `name`, `profile`    | `runId`, `region`      | Seeds a baseline immediately. Omit `runId` to use the most recent run. |
| `remove` | `watchId`                    | —                      | `watchId` comes from `list`.                      |
| `list`   | —                            | —                      | One line per watch: `[id] type/name runId state`. |
| `pause`  | —                            | —                      | Global. Persisted across session reload.          |
| `resume` | —                            | —                      | Restarts polling if active watches exist.         |
| `status` | —                            | —                      | Enabled/paused state, watch counts, poll interval.|

### Types

| `type`      | API used            | `runId` format |
|-------------|---------------------|----------------|
| `job`       | `GetJobRun`         | `jr_…`         |
| `workflow`  | `GetWorkflowRun`    | `wr_…`         |

### Terminal states

A watch fires and self-marks terminal when the run reaches one of:
`SUCCEEDED`, `FAILED`, `STOPPED`, `TIMEOUT`, `ERROR`.

## `/glue-watcher` command

`/glue-watcher` (with or without arguments) opens an interactive TUI
menu via `ctx.ui.select`. There are no subcommands — the legacy
`status | browse | settings | enable | disable` interface has been
replaced by the menu.

| Menu row                       | Effect                                                                                |
|--------------------------------|---------------------------------------------------------------------------------------|
| `Browse watches (N)`           | Open the watches view (TUI overlay) showing every active watch.                       |
| `Paused: off|on`               | Switch — toggle global pause. Persists across session reload.                         |
| `Display mode: widget|statusline` | Switch — flips this session's display mode between the below-editor widget and the compact status row. |
| `User default display mode: …` | Switch — writes `defaultDisplayMode` to `~/.pi/agent/pi-aws-glue-watcher.json`. Seeds future sessions. |
| `Close`                        | Dismiss the menu (Esc also works).                                                    |

### Display modes

The extension renders progress in one of two modes:

- **`widget`** (default) — a permanent below-editor panel listing every active
  watch, its run state, and the current poll interval.
- **`statusline`** — a single compact status-line row pinned to the footer.

Flip between them either via the `/glue-watcher` menu's display-mode
switch or by pressing `t` inside the watches overlay. The current
session's mode persists in the session log; the **user default** — the
mode used to seed *fresh* sessions — lives in
`~/.pi/agent/pi-aws-glue-watcher.json`.

## User config

Optional user-level config at `~/.pi/agent/pi-aws-glue-watcher.json` seeds
defaults for fresh sessions:

```json
{
  "defaultDisplayMode": "statusline"
}
```

| Key                  | Type                          | Effect                                                                 |
|----------------------|-------------------------------|------------------------------------------------------------------------|
| `defaultDisplayMode` | `"widget"` \| `"statusline"`  | Initial display mode used when no `displayMode` is persisted yet.      |

Precedence on session load: **persisted state > user config > hardcoded
default (`widget`)**. Once you toggle the display via the
`/glue-watcher` menu's display-mode switch (session row) or the `t` key
in the watches overlay, the persisted choice wins on subsequent
reloads. Toggling the user-default row in the menu rewrites this JSON
file so future sessions seed from it.

Fail-soft: a missing file, unreadable file, invalid JSON, or unknown value
(e.g. `defaultDisplayMode: "inline"`) is silently ignored and the runtime
falls back to the hardcoded default. There is no project-level config
support.

## Authentication

Credentials resolve through `fromIni({ profile })`, so the same
`~/.aws/credentials` / `~/.aws/config` layout used by the `aws` CLI is
picked up. Pass the profile name you would use with `aws --profile <name>`.
A SigV4 session token refresh from `aws sso login` is read on the next
poll without restarting pi.

## Security notes

- No subprocess spawns. All AWS access goes through
  `@aws-sdk/client-glue` in-process.
- Raw SDK error messages land **only** in
  `pi.appendEntry("glue-watcher:poll-error", …)` — never in chat, tool
  output, or the status line. User-facing text comes from
  `pi-watcher-core`'s `classifyWatcherError`, whose output is guaranteed
  free of server-supplied strings.
- Persistence goes through `pi.appendEntry` only — no writes to
  arbitrary paths.

## Package layout

```
src/
  types.ts         — GlueWatch, GlueEvent, baseline + state types
  glue-client.ts   — SDK-backed GlueClient interface + GetJobRun/GetWorkflowRun wrappers
  poller.ts        — snapshotJobRun, snapshotWorkflowRun, detectChanges (pure)
  runtime.ts       — Runtime, PollScheduler, pollOnce
  toolAction.ts    — glue_watcher tool registration + handler
  command.ts       — /glue-watcher TUI menu (browse + paused + display switches)
  config.ts        — user-level config loader (~/.pi/agent/pi-aws-glue-watcher.json)
  persistence.ts   — createPersistence delegate
  format.ts        — chat message + status-line formatters
  index.ts         — session lifecycle + /glue-watcher command registration
  ui/
    glue-widget.ts   — footer widget showing active watch count + poll interval
    watches-view.ts  — TUI overlay listing all watches with stop/remove actions
    watchesKeys.ts   — keyboard bindings for the watches view
    watchesModel.ts  — watches view data model
    widgetRows.ts    — widget row rendering helpers
test/
  command.test.ts
  config.test.ts
  format.test.ts
  index.test.ts
  persistence.test.ts
  poller.test.ts
  runtime.test.ts
  sdk-client.test.ts
  watchesKeys.test.ts
  watchesModel.test.ts
  widgetRows.test.ts
skills/
  aws-glue-watcher/SKILL.md  — LLM-facing usage instructions
```

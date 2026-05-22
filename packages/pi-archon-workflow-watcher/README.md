# pi-archon-workflow-watcher

Pi extension that watches archon workflow runs for status changes and
injects one chat notification per run when its status changes. Replaces
manual sleep-based polling for interactive archon workflows.

## Activation

`archon_watcher` is **not active by default**. Activate it before use
(once per session):

```
manage_tools({"action": "activate", "tools": ["archon_watcher"]})
```

This requires the `pi-tools-management-tool` extension. The tool becomes
callable on the next turn after activation.

## Polling schedule

Polling runs on a back-off-aware scheduler from `pi-watcher-core`:

- **Base:** 15 s.
- **Idle back-off:** each quiet poll doubles the interval, up to a cap.
- **Re-entry guard:** a slow archon CLI call can never overlap the next tick.
- **Paused preference:** persisted across session reload.

When all watches are terminal the poll loop stops.

## Getting a run ID

Run IDs come from the archon CLI. List active runs:

```bash
archon workflow status --json
```

Each entry has an `id` field — pass that to `archon_watcher add`.

## Tool: `archon_watcher`

| Action   | Required params | Notes |
|----------|-----------------|-------|
| `add`    | `runId`         | Seeds a baseline immediately. Notifies on next status change. |
| `remove` | `runId`         | Stop watching this run. |
| `status` | —               | Shows each watched run ID, workflow name, and current status. |
| `poll`   | —               | Trigger an immediate poll cycle right now. |
| `pause`  | —               | Suspend background polling globally. Persisted. |
| `resume` | —               | Resume polling. Restarts iff at least one non-terminal watch exists. |

### Status changes that fire a notification

| Event | Meaning |
|-------|---------|
| `paused` | Run is waiting for user input (approval gate or interactive loop). |
| `completed` / `failed` / `cancelled` | Run disappeared from the active list — it finished. |
| `status_changed` | Any other status transition observed between polls. |

Each watch fires **one** notification per status change then continues
watching until the run reaches a terminal state (`completed`, `failed`,
`cancelled`), at which point it marks itself terminal. There is no
repeating notification stream per event.

## Security notes

- All archon access goes through `execFile("archon", ...)` — no network
  calls, no SDK, no direct filesystem writes outside `pi.appendEntry`.
- Raw CLI error output lands **only** in
  `pi.appendEntry("archon-watcher:poll-error", …)` — never in chat or
  tool output.
- Persistence goes through `pi.appendEntry` only — no writes to
  arbitrary paths.
- The approval dialog (for approval-gate runs) is TUI-only and never
  forwards credentials or secrets to the LLM.

## Package layout

```
src/
  types.ts            — ArchonRun, RunSnapshot, ArchonEvent, terminal/trigger status sets
  archon-client.ts    — execFile wrapper around the archon CLI
  poller.ts           — snapshotRuns, detectChanges (pure)
  runtime.ts          — Runtime, PollScheduler, pollOnce
  tool.ts             — archon_watcher tool registration + action handler
  persistence.ts      — session state rehydration + writeState
  format.ts           — chat message + status-line formatters
  approval-dialog.ts  — TUI approval-gate dialog (pi-tui)
  index.ts            — session lifecycle + registerCommand
test/
  archon-client.test.ts
  approval-dialog.test.ts
  format.test.ts
  index.test.ts
  persistence.test.ts
  poller.test.ts
  runtime.test.ts
  tool.test.ts
skills/
  archon-watcher/SKILL.md  — LLM-facing usage guide with activation instructions
```

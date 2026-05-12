---
name: archon-watcher
description: "Use this skill when monitoring an archon workflow run for status changes — waiting for a run to complete, detect if it paused for input, or confirm it finished. Triggers on: archon_watcher, watch archon run, monitor archon workflow, wait for archon to finish, archon run status, track archon workflow."
---

# Archon Workflow Watcher

Use this skill when monitoring an archon workflow run for status changes:
waiting for a run to complete, detecting that it paused for user input, or
confirming it disappeared (completed or failed).

Do not use for triggering or creating archon workflow runs — only for
watching runs that are already in progress.

## Activation required

Activate `archon_watcher` before use — it is inactive by default to avoid
adding it to the system prompt on every session and busting the prefix
cache.

```
manage_tools({"action": "activate", "tools": ["archon_watcher"]})
```

`manage_tools` is provided by the `pi-tools-runtime-manager` extension.
If the call fails with "unknown tool", that extension is not installed —
ask the user to install it before continuing. The tool becomes available
on the next turn after activation.

## What the tool does

`archon_watcher` polls `archon workflow status` on a back-off schedule
(15 s base, doubling to a 5 min cap; snaps back to 15 s on any detected
change) and fires one chat notification per watched run when its status
changes:

- **paused** — the run is waiting for user input
- **disappeared** — the run completed or failed (no longer in the active list)

After notifying, the watch for that run is marked terminal. There is no
repeating notification stream per run.

## Getting a run ID

Run IDs come from the archon CLI. To list active runs and their IDs:

```bash
archon workflow status --json
```

Each entry has an `id` field — pass that value to `archon_watcher add`.

## Actions

### add — start watching a run

```
archon_watcher({"action": "add", "runId": "<id from archon workflow status --json>"})
```

The watcher seeds a baseline immediately and notifies you when the status
changes from that baseline.

### remove — stop watching a run

```
archon_watcher({"action": "remove", "runId": "<run id>"})
```

### status — show current state of watched runs

```
archon_watcher({"action": "status"})
```

Shows each watched run ID, its last-known workflow name, and current status.

### poll — trigger an immediate poll now

```
archon_watcher({"action": "poll"})
```

Useful for a one-off check without waiting for the next scheduled poll.

### pause / resume — toggle background polling

```
archon_watcher({"action": "pause"})
archon_watcher({"action": "resume"})
```

Global toggle, persisted across session reload.

## Error handling

| Error | Cause | What to do |
|---|---|---|
| `manage_tools` not found | `pi-tools-runtime-manager` not installed | Ask the user to install the extension, then restart pi |
| `archon: command not found` on `add` | `archon` CLI not in `PATH` | Verify archon is installed and in PATH; the watcher still adds the run ID but cannot seed the baseline |
| Run ID not in active list at `add` time | Run already completed or ID is wrong | Verify with `archon workflow status --json`; the run may have already finished |
| Watch added but no notification | Polling paused, or run hasn't changed state yet | Call `archon_watcher({action:"status"})` to check; `archon_watcher({action:"poll"})` to check immediately |

CLI errors during polling are back-off'd silently and do not emit chat
notifications. Call `status` or `poll` if a watch seems stale.

## Typical workflow

1. Activate the tool (once per session):
   ```
   manage_tools({"action": "activate", "tools": ["archon_watcher"]})
   ```
2. On the next turn, get the run ID and add a watch:
   ```bash
   archon workflow status --json   # find the run ID
   ```
   ```
   archon_watcher({"action": "add", "runId": "<id>"})
   ```
3. The agent returns immediately. When the run status changes, a chat
   notification is injected automatically and a new LLM turn starts.

## Related Skills

- `archon` — run archon workflows and get run IDs before watching them with this skill

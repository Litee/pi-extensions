---
name: aws-glue-watcher
description: "Use this skill when monitoring AWS Glue job or workflow runs for state changes. Triggers on: glue_watcher, watch Glue job, monitor Glue run, track Glue workflow, Glue job finished, Glue run status, Glue job succeeded, Glue job failed, poll Glue."
---

# AWS Glue Watcher

Use this skill when monitoring an AWS Glue job run or workflow run for
state changes: tracking a running job to completion, detecting failure,
or watching a workflow run's progress.

Do not use for Glue Data Catalog, crawlers, or triggers — only job runs
and workflow runs are supported.

## Activation required

`glue_watcher` is **registered at session_start but starts inactive**. It
appears in `manage_tools({action:"list"})` immediately; one action is
needed to make it callable. Two paths:

**Preferred — LLM activates via `manage_tools`** (no user action needed):

```
manage_tools({"action": "activate", "tools": ["glue_watcher"]})
```

The tool becomes callable on the next turn. `manage_tools` is provided
by the `pi-tools-management-tool` extension; if the call fails with
"unknown tool", that extension is not installed — ask the user to
install it before continuing.

**`/glue-watcher` slash command** opens an interactive TUI menu where the
user can browse watches, pause/resume polling, and toggle display mode.
It does **not** activate or deactivate the `glue_watcher` tool itself —
use `manage_tools` for that. Tool activation is independent of the menu.

## What the tool does

`glue_watcher` polls `GetJobRun` / `GetWorkflowRun` on a back-off
schedule (120 s base, doubling to a 15 min cap) and injects one chat
notification per state change. When a terminal state is detected the
watch is marked terminal and polling for it stops.

**Job terminal states:** `SUCCEEDED`, `FAILED`, `STOPPED`, `ERROR`, `TIMEOUT`

**Workflow terminal states:** `COMPLETED`, `STOPPED`, `ERROR`

## Actions

### add — start watching a run

```
glue_watcher({
  "action":  "add",
  "type":    "job" | "workflow",
  "name":    "my-etl-job",
  "profile": "my-aws-profile",
  "runId":   "jr_abc123",  // optional; uses the most recent run if omitted
  "region":  "us-east-1"  // optional, inferred from profile if omitted
})
```

Fetches a baseline snapshot immediately. If `runId` is omitted the most
recent run for the given job or workflow name is used.

### set-interval

Update the poll interval for a specific watch without removing and re-adding it.

```
glue_watcher({
  "action": "set-interval",
  "watchId": "<id from list>",
  "pollIntervalMs": 30000  // minimum 5000 ms
})
```

Useful when a job's expected runtime changes after it was added, or to trade responsiveness against API call volume.

### remove

```
glue_watcher({"action": "remove", "watchId": "<id from list>"})
```

### list

```
glue_watcher({"action": "list"})
```

Returns one line per watch: `[id] type/name runId state`.

### status

```
glue_watcher({"action": "status"})
```

Shows watch count and current poll interval.

## Authentication

Credentials are read from `~/.aws/credentials` / `~/.aws/config` via
the `profile` parameter (same profiles used by the `aws` CLI). Pass the
profile name you would use with `aws --profile <name>`.

## Error handling

| Error | Cause | What to do |
|---|---|---|
| `manage_tools` not found | `pi-tools-management-tool` not installed | Ask the user to install the extension, then restart pi |
| `CredentialsProviderError` / `ExpiredToken` on `add` | Stale session | Run `aws sso login --profile <name>`, then retry `add` |
| `AccessDenied` on `add` | Profile lacks `glue:GetJobRun` or `glue:GetWorkflowRun` | Check IAM policy; `AccessDenied` is not transient — the watch will never fire |
| `EntityNotFoundException` on `add` | Job or workflow name does not exist in the given region/account | Verify name, profile, and region |
| Watch added but never fires | Run already in terminal state at add time, or polling paused | Call `glue_watcher({action:"status"})` to check; `glue_watcher({action:"list"})` to inspect |

Auth errors during polling (after `add` succeeds) are back-off'd silently.
Call `status` if a watch seems stale.

## Typical workflow

1. Activate the tool (once per session):
   ```
   manage_tools({"action": "activate", "tools": ["glue_watcher"]})
   ```
2. On the next turn, add a watch:
   ```
   glue_watcher({"action": "add", "type": "job", "name": "my-etl-job", "profile": "default"})
   ```
3. The agent returns immediately. When the run state changes, a chat
   notification is injected automatically and a new LLM turn starts.

## Known limitations

- **Missed intermediate transitions** — because polling is interval-based, a run that moves through multiple states (e.g., `RUNNING → STOPPING → STOPPED`) within a single poll window may only surface the final state. You still receive a notification, but intermediate states may not be reported.
- **Base interval is 120 s** — `glue_watcher` is tuned for long-running jobs; use `set-interval` to lower the poll frequency for short-running jobs where tighter responsiveness matters.

## Related Skills

- `personal-aws-settings` — look up which AWS profile to use for a specific account before calling `add`

# pi-cmux-update-workspace-name

Pi extension that auto-renames the [cmux](https://cmux.dev) workspace
once per pi session based on an LLM summary of the first user prompt.
Also provides a `/cmux-rename` slash command for on-demand regeneration.

Split out of the former `pi-update-cmux-status` package. Sidebar
status-pill mirroring now lives in the sibling
[`pi-cmux-notifications`](../pi-cmux-notifications) package and can be
installed independently.

## What it does

### Auto-rename on the first eligible user prompt

On every eligible user message, if the extension hasn't already acted
this session, it runs:

    cmuxAvailable()  →  prefix gate (cmux RPC)  →  fetchNames (LLM)  →  cmux workspace-action --action rename

The prefix gate only lets the rename through when the current workspace
title still starts with cmux's default `Terminal ` prefix. A workspace
the user has already renamed by hand is left alone, and the marker is
persisted anyway so `/reload` doesn't re-ask.

Gate failure (RPC timeout, malformed JSON, unreadable title) is **fail-closed**:
skip this turn, retry on the next message, don't pay for an LLM call.

Workspace titles are capped at 60 characters.

### `/cmux-rename` command

Regenerates the workspace title from the current session branch (all
user messages so far, not just the first), bypassing the prefix gate.
Useful once the conversation has drifted far enough that the initial
name no longer fits.

### Persistence

A custom session-log entry (`pi-cmux-update-workspace-name-state`) is
written after any gate-reached decision — successful rename, or "title
looks user-set, skipped" — so a `/reload` inside the same pi session
skips both the cmux RPC and the LLM call. Legacy entry types from the
pre-split `pi-update-cmux-status` package (`pi-update-cmux-status-state`,
`cmux-status-renamed`) are still honoured on read.

## Configuration

| Env var                      | Purpose                                                              | Default          |
|------------------------------|----------------------------------------------------------------------|------------------|
| `PI_CMUX_STATUS_KEY`         | cmux sidebar pill key used when logging rename decisions             | `pi`             |
| `PI_CMUX_RENAME_WORKSPACE`   | Set to `0`, `false`, or `no` to disable rename entirely              | enabled          |
| `PI_CMUX_SUMMARY_MODEL`      | Override summariser model, formatted `"provider:modelId"`            | `ctx.model`      |

All cmux CLI calls are no-ops when the process is not running inside cmux
(`CMUX_WORKSPACE_ID` + either `CMUX_TAB_ID` or `CMUX_SURFACE_ID` must be
set), so loading this extension in a plain terminal is safe.

## Install

Same pattern as any pi extension in this monorepo — add the package path
under `packages` in `~/.pi/agent/settings.json`.

# pi-cmux-notifications

Pi extension that mirrors pi lifecycle events into
[cmux](https://cmux.dev) — sidebar status pill, log lines, and a single
desktop-notification channel reserved for genuine attention requests.

Split out of the former `pi-update-cmux-status` package. The LLM-driven
workspace rename half lives in the sibling
[`pi-cmux-update-workspace-name`](../pi-cmux-update-workspace-name)
package and can be installed independently.

## What it does

Three-state sidebar pill:

| State       | When                                                                              | Visual                            | Desktop notify |
|-------------|-----------------------------------------------------------------------------------|-----------------------------------|----------------|
| `idle`      | pi session started, or agent turn finished                                        | green checkmark                   | no             |
| `working`   | user message received OR agent turn started (whichever fires first)               | orange bolt                       | no             |
| `attention` | a UI prompt is blocking on the user (e.g. `ask_user_question`, plan-mode select)  | red speech bubble (`bubble.left.fill`) | **yes**        |

Event wiring:

| Pi event                              | Effect                                                                  |
|---------------------------------------|-------------------------------------------------------------------------|
| `session_start`                       | pill → `idle`, log `pi session started`                                 |
| `input` (interactive/rpc, non-slash)  | pill → `working`                                                        |
| `before_agent_start`                  | pill → `working` (belt-and-braces for non-interactive turn starts)      |
| `agent_end`                           | pill → `idle`, clear-progress, log "Response complete" (no desktop notify) |
| `pi.events` `need_user_attention`     | pill → `attention`, **desktop notify**                                  |
| `pi.events` `user_attention_resolved` | pill → `working`                                                        |
| `session_shutdown`                    | clear progress, clear status pill                                       |

### Why both `input` and `before_agent_start`?

`input` covers the common case — you type a message, the pill flips
immediately to bolt for snappy feedback. `before_agent_start` is a
defensive backup for turns kicked off by sources `input` filters out
(`api`, slack-watcher injection, recovery): without it, those turns
would run with the pill stuck on `idle`. `setStatus("working", …)` is
idempotent, so firing both is harmless.

### Why no `done` pill / no notify on agent_end?

Earlier iterations added a red `done` pill and a focus-aware "response
ready" desktop notification on `agent_end`. In practice these were
indistinguishable from genuine attention requests and quickly became
notification noise. The current design reserves desktop notifications
for the `attention` state only — the agent is actually blocked on you
and you must respond before progress continues. End-of-turn is a soft
event: the pill returns to idle, the sidebar log records "Response
complete", and that's it.

If you want a notification on every completed turn anyway, add a
sibling extension that subscribes to `agent_end` and calls
`cmux notify` directly — keeping that policy out of this extension.

### Attention events

Extensions that show a UI prompt emit `need_user_attention` /
`user_attention_resolved` on `pi.events`; this extension subscribes and
reacts. The `pi-ask-user-question` extension emits these events when
the `ask_user_question` dialog opens and closes; `pi-plan-mode` emits
them around its approval `ctx.ui.select`.

## Configuration

| Env var                | Purpose                                            | Default |
|------------------------|----------------------------------------------------|---------|
| `PI_CMUX_STATUS_KEY`   | cmux sidebar pill key (`cmux set-status <key>`)    | `pi`    |

All cmux CLI calls are no-ops when the process is not running inside cmux
(`CMUX_WORKSPACE_ID` + either `CMUX_TAB_ID` or `CMUX_SURFACE_ID` must be
set), so loading this extension in a plain terminal is safe.

## Install

Same pattern as any pi extension in this monorepo — add the package path
under `packages` in `~/.pi/agent/settings.json`.

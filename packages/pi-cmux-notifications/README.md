# pi-cmux-notifications

Pi extension that mirrors pi lifecycle events into
[cmux](https://cmux.dev) — sidebar status pill, log lines, and desktop
notifications.

Split out of the former `pi-update-cmux-status` package. The LLM-driven
workspace rename half now lives in the sibling
[`pi-cmux-update-workspace-name`](../pi-cmux-update-workspace-name)
package and can be installed independently.

## What it does

Four-state sidebar pill:

| State     | When                                                             | Visual                    |
|-----------|------------------------------------------------------------------|---------------------------|
| `idle`    | pi session started or pane receives focus after a completed turn | green checkmark            |
| `working` | eligible user message received                                   | orange bolt               |
| `waiting` | attention prompt open (e.g. `ask_user_question` dialog)         | cyan bell + desktop notify |
| `done`    | agent turn finished; clears to `idle` on pane focus-in          | red circle                |

Event wiring:

| Pi event                              | Effect                                                         |
|---------------------------------------|----------------------------------------------------------------|
| `session_start`                       | pill → `idle`, log `pi session started`                        |
| `input` (interactive/rpc, non-slash)  | pill → `working`, clears pending dot                           |
| `pi.events` `need_user_attention`     | pill → `waiting`, desktop `notify`                             |
| `pi.events` `user_attention_resolved` | pill → `working`                                               |
| `agent_end`                           | pill → `done` (red circle), clear-progress, log (no desktop notify); clears to `idle` on focus-in |
| `session_shutdown`                    | clear progress, clear status pill                              |

**Event-based attention**: extensions that show a UI prompt emit
`need_user_attention` / `user_attention_resolved` on `pi.events`; this
extension subscribes and reacts — pill to `waiting` + desktop notify on
attention needed, pill back to `working` when resolved. The
`pi-ask-user-question` extension emits these events when the
`ask_user_question` dialog opens and closes.

**Focus-in clearing**: after each agent turn the pill shows a red circle
(`done`). When the cmux pane receives focus (DECSET ?1004 focus-in sequence),
the pill automatically transitions to `idle` (green checkmark), so users who
were in a different tab see a clear "response ready" signal without a noisy
desktop notification.

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

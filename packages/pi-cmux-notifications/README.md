# pi-cmux-notifications

Pi extension that mirrors pi lifecycle events into
[cmux](https://cmux.dev) — sidebar status pill, log lines, and a single
desktop-notification channel reserved for genuine attention requests.

Split out of the former `pi-update-cmux-status` package. The LLM-driven
workspace rename half lives in the sibling
[`pi-cmux-update-workspace-name`](../pi-cmux-update-workspace-name)
package and can be installed independently.

## What it does

Four-state sidebar pill:

| State       | When                                                                              | Visual                                    | Desktop notify |
|-------------|-----------------------------------------------------------------------------------|-------------------------------------------|----------------|
| `idle`      | Session started, or agent turn finished while pane was focused                    | grey circle (`circle.fill` `#8e8e93`)     | no             |
| `working`   | User message received OR agent turn started                                       | orange bolt (`bolt` `#ff9500`)            | no             |
| `unread`    | Agent turn finished while you were in another pane                                | blue circle (`circle.fill` `#007aff`)     | no             |
| `attention` | A UI prompt is blocking on the user (`ask_user_question`, plan-mode select, …)   | red speech bubble (`bubble.left.fill` `#ff3b30`) | **yes**  |

The `idle` vs `unread` distinction lets you scan multiple cmux workspaces
and tell apart "I know why this session is quiet" (grey) from "something
happened here while I was away" (blue).

Event wiring:

| Pi event                              | Effect                                                                         |
|---------------------------------------|--------------------------------------------------------------------------------|
| `session_start`                       | pill → `idle`, log `pi session started`, enable focus reporting                |
| `input` (interactive/rpc, non-slash)  | pill → `working`                                                               |
| `before_agent_start`                  | pill → `working` (belt-and-braces for non-interactive turn starts)             |
| `agent_end` (pane focused)            | pill → `idle`, clear-progress, log "Response complete"                         |
| `agent_end` (pane unfocused)          | pill → `unread`, clear-progress, log "Response complete"                       |
| focus-in while `unread`               | pill → `idle` (you're now looking at it)                                       |
| `pi.events` `need_user_attention`     | pill → `attention`, **desktop notify**                                         |
| `pi.events` `user_attention_resolved` | pill → `working`                                                               |
| `session_shutdown`                    | clear progress, clear status pill, disable focus reporting                     |

### Focus tracking

Focus state is read from DECSET ?1004 sequences on stdin (standard
terminal focus reporting). When you switch away from the pi pane, the
terminal emits `ESC [ O` (focus-out); when you return, `ESC [ I`
(focus-in). This requires stdin and stdout both to be TTYs. When
unavailable (non-TTY sessions), `focusedAway` is always false and
`agent_end` always goes to `idle`.

### Why both `input` and `before_agent_start` for working?

`input` provides immediate feedback the moment you hit Enter.
`before_agent_start` is a defensive backup for turns triggered by
non-interactive sources (`api`, slack-watcher injection, recovery) that
bypass the `input` event. `setStatus("working", …)` is idempotent, so
both firing is harmless.

### Why no desktop notification on `agent_end`?

Notifications are reserved exclusively for `attention` — the one state
where the agent is actually blocked on you and cannot continue. An
`agent_end` notification would be indistinguishable from a genuine
attention request and would quickly become noise. The `unread` pill
(blue circle) is the signal for "something finished while you were away",
readable at a glance across all your workspaces without any interruption.

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

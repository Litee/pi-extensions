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
| `unread`    | Agent turn finished while you were in another workspace                           | blue circle (`circle.fill` `#007aff`)     | no             |
| `attention` | A UI prompt is blocking on the user (`ask_user_question`, plan-mode select, …)   | red speech bubble (`bubble.left.fill` `#ff3b30`) | **yes**  |

The `idle` vs `unread` distinction lets you scan multiple cmux workspaces
and tell apart "I know why this session is quiet" (grey) from "something
happened here while I was away" (blue).

Event wiring:

| Pi event                              | Effect                                                                         |
|---------------------------------------|--------------------------------------------------------------------------------|
| `session_start`                       | pill → `idle`, log `pi session started`, attach focus tracking                 |
| `input` (interactive/rpc, non-slash)  | pill → `working`                                                               |
| `before_agent_start`                  | pill → `working` (belt-and-braces for non-interactive turn starts)             |
| `agent_end` (workspace focused)       | pill → `idle`, clear-progress, log "Response complete"                         |
| `agent_end` (workspace unfocused)     | pill → `unread`, clear-progress, log "Response complete"                       |
| focus-in while `unread`               | pill → `idle` (you're now looking at it)                                       |
| `pi.events` `need_user_attention`     | pill → `attention`, **desktop notify**                                         |
| `pi.events` `user_attention_resolved` | pill → `working`                                                               |
| `session_shutdown`                    | clear progress, clear status pill, detach focus tracking                       |

### Focus tracking

Focus state is tracked by subscribing to the cmux event stream
(`cmux events --reconnect`) and watching two event types:

- **`workspace.selected`** — fires on the newly active workspace. If
  `workspace_id` matches `$CMUX_WORKSPACE_ID` the workspace became
  active (focus-in); any other ID means it became inactive (focus-out).
- **`window.keyed` / `window.unkeyed`** — OS-level window focus. Covers
  switching to/from other applications.

`focusedAway = !windowKeyed || !workspaceSelected`. Both must be true
for the workspace to be considered in-focus.

This correctly handles cmux workspace switches, which the old DECSET
?1004 stdin approach did not — cmux does not forward terminal focus
sequences when switching between internal workspaces.

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

### Bell sound on turn end

If you hear a bell/ding when an LLM turn ends, it is **not** from this
extension — `pi-cmux-notifications` never calls `cmux notify` on
`agent_end`. The sound comes from cmux's built-in pi session integration:
`~/.pi/agent/extensions/cmux-session.ts` (auto-installed by cmux) calls
`cmux hooks pi stop` on every turn end, which feeds cmux's internal
notification pipeline and may play a sound depending on your cmux
notification settings.

To suppress it, choose one of:

- **Disable cmux's pi hook**: set `CMUX_PI_HOOKS_DISABLED=1` in the
  environment where pi runs (e.g. in your shell RC).
- **Uninstall the hook**: run `cmux hooks pi uninstall`.
- **Mute notification sounds**: go to cmux Settings → Notifications and
  disable the notification sound.

## Configuration

| Env var                  | Purpose                                            | Default |
|--------------------------|----------------------------------------------------|---------|
| `PI_CMUX_STATUS_KEY`     | cmux sidebar pill key (`cmux set-status <key>`)    | `pi`    |
| `PI_CMUX_NOTIFY_DEBUG`   | Set to `1` to log focus events and notify calls to `/tmp/pi-cmux-debug.log` | off |

All cmux CLI calls are no-ops when the process is not running inside cmux
(`CMUX_WORKSPACE_ID` + either `CMUX_TAB_ID` or `CMUX_SURFACE_ID` must be
set), so loading this extension in a plain terminal is safe.

## Install

Same pattern as any pi extension in this monorepo — add the package path
under `packages` in `~/.pi/agent/settings.json`.

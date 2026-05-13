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
| `agent_end`                           | pill → `done` (red circle), clear-progress, log; smart desktop notify (see below); clears to `idle` on focus-out + focus-in |
| `session_shutdown`                    | clear progress, clear status pill                              |

**Event-based attention**: extensions that show a UI prompt emit
`need_user_attention` / `user_attention_resolved` on `pi.events`; this
extension subscribes and reacts — pill to `waiting` + desktop notify on
attention needed, pill back to `working` when resolved. The
`pi-ask-user-question` extension emits these events when the
`ask_user_question` dialog opens and closes.

**Focus-in clearing**: after each agent turn the pill shows a red circle
(`done`). The pill clears to `idle` (green checkmark) only when the cmux
pane has actually lost focus and then regained it (DECSET ?1004 focus-out
followed by focus-in). A focus-in alone is *not* enough — terminals
frequently emit a spurious focus-in when the active pane's prompt
redraws, and clearing on those would mask the red circle entirely. The
red circle therefore persists as a stable "response ready" marker until
the user either tabs away+back or sends another message.

## Configuration

| Env var                       | Purpose                                                              | Default |
|-------------------------------|----------------------------------------------------------------------|---------|
| `PI_CMUX_STATUS_KEY`          | cmux sidebar pill key (`cmux set-status <key>`)                      | `pi`    |
| `PI_CMUX_NOTIFY_ON_DONE`      | Desktop-notification policy on `agent_end`: `smart` \| `always` \| `never` | `smart` |

**`PI_CMUX_NOTIFY_ON_DONE` policy:**

- `smart` (default): notify only if focus reporting says the cmux pane is
  currently un-focused, OR if focus reporting is unavailable (no TTY).
  In other words: if you're staring at the pane, no notification (the
  red circle is enough); if you've tabbed away to another app, you get
  a desktop ping. This is the recommended setting for users running
  multiple parallel pi sessions.
- `always`: ping on every `agent_end`. Useful if you park pi sessions
  in the background and want every completion to interrupt you.
- `never`: silent on `agent_end`. Only the sidebar pill and log change.
  Equivalent to the pre-1.x behaviour.

All cmux CLI calls are no-ops when the process is not running inside cmux
(`CMUX_WORKSPACE_ID` + either `CMUX_TAB_ID` or `CMUX_SURFACE_ID` must be
set), so loading this extension in a plain terminal is safe.

## Install

Same pattern as any pi extension in this monorepo — add the package path
under `packages` in `~/.pi/agent/settings.json`.

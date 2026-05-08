# pi-cmux-notifications

Pi extension that mirrors pi lifecycle events into
[cmux](https://cmux.dev) — sidebar status pill, log lines, and desktop
notifications.

Split out of the former `pi-update-cmux-status` package. The LLM-driven
workspace rename half now lives in the sibling
[`pi-cmux-update-workspace-name`](../pi-cmux-update-workspace-name)
package and can be installed independently.

## What it does

Three-state sidebar pill:

| State     | When                                                     | Visual                 |
|-----------|----------------------------------------------------------|------------------------|
| `idle`    | pi session started or agent turn finished                | green checkmark        |
| `working` | eligible user message received or attention tool ended   | orange bolt            |
| `waiting` | attention tool started (today: `ask_user_question`)      | cyan bell + notify     |

Event wiring:

| Pi event                                  | Effect                                                |
|-------------------------------------------|-------------------------------------------------------|
| `session_start`                           | pill → `idle`, log `pi session started`               |
| `input` (interactive/rpc, non-slash)      | pill → `working`                                      |
| `tool_execution_start` (attention tool)   | pill → `waiting`, desktop `notify`                    |
| `tool_execution_end` (attention tool)     | pill → `working`                                      |
| `pi.events` `need_user_attention`         | pill → `waiting`, desktop `notify`                    |
| `pi.events` `user_attention_resolved`     | pill → `working`                                      |
| `agent_end`                               | pill → `idle`, clear-progress, log (no desktop notify)  |
| `session_shutdown`                        | clear progress, clear status pill                     |

Two complementary attention mechanisms are wired up:

**Tool-based**: `ATTENTION_TOOLS` (hardcoded allowlist in `src/index.ts`) catches tools like
`ask_user_question` that block the agent waiting for user input.

**Event-based**: extensions that show a UI prompt outside the tool pipeline (e.g. `pi-plan-mode`)
emit `need_user_attention` / `user_attention_resolved` on `pi.events`; this extension subscribes
and reacts identically — pill to `waiting` + desktop notify on attention needed, pill back to
`working` when resolved.

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

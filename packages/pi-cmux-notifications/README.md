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
| `agent_end`                               | pill → `idle`, clear-progress, log (no desktop notify)  |
| `session_shutdown`                        | clear progress, clear status pill                     |

The attention-tools list is a hardcoded allowlist in `src/index.ts`. Today
it's just `ask_user_question` from the sibling `pi-ask-user-question`
extension — tools that block pi waiting on user interaction. Other tools
don't move the pill, so `bash` / `read` / `edit` loops don't flicker it.

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

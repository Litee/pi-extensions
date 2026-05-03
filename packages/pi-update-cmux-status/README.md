# pi-update-cmux-status

Pi extension that mirrors pi lifecycle events into
[cmux](https://github.com/user/cmux) — sidebar status pill, log lines,
progress, desktop notifications — and auto-renames the cmux tab + workspace
based on an LLM summary of the first user prompt. This is a monorepo port
of the single-file `cmux-status.ts` that ships in
`~/.pi/agent/extensions/`, refactored so every piece of behaviour is
unit-tested.

## What it does

### Status updates (two-state sidebar pill + attention signal)

Since #0002 the pill only has two baseline states: `working` while pi is
chewing on a user turn, `idle` while pi is waiting on the user.
Per-tool transitions (`bash`, `read`, `edit`, …) were removed because
they flickered through every tool call inside a single turn without
carrying any signal the user could act on.

| Pi event               | Effect inside cmux                                    |
|------------------------|-------------------------------------------------------|
| `session_start`        | pill → `idle`, log `pi session started`               |
| `input` (eligible)     | pill → `working` every turn; on the first eligible prompt of the pi session also fires the once-per-session LLM tab + workspace rename |
| `tool_execution_start` (attention tool) | pill → `waiting` (bell, cyan `#5ac8fa`), desktop `notify` `Needs your input (<toolName>)` |
| `tool_execution_end`   (attention tool) | pill → `working` (agent is processing again)           |
| `agent_end`            | pill → `idle`, clear-progress, log, desktop `notify`  |
| `session_shutdown`     | clear progress, clear status pill                     |

An "eligible" input is an interactive or rpc user message whose trimmed
text is non-empty and does not start with `/` (slash commands do not
flip the pill).

The **attention tools** list is a short, hardcoded allowlist in
`src/index.ts` of tools that block pi waiting on the user. Today it's
just `ask_user_question` from the sibling `pi-ask-user-question`
extension. Tools outside the list are ignored — no pill change, no
notification.

### Auto-rename (once per pi session, on first user prompt)

Calls the current session's model (or the `PI_CMUX_SUMMARY_MODEL`
override) with a short prompt, gets `{tab, workspace}` back, and runs:

```
cmux rename-tab -- <tab>
cmux workspace-action --action rename --title <workspace>
```

Name sizes are capped in **characters** (words vary too much in length):
tab titles up to **50 chars**, workspace titles up to **60 chars** —
enough for descriptive labels like `Check SVC-API Video Search Results
Limit`. The model is told to aim shorter when the session has an obvious
short label. Anything the model returns over the cap is clipped to the
nearest word boundary before being handed to cmux.

The "already auto-renamed" flag is persisted to the pi session log via
`pi.appendEntry("cmux-status-renamed", { savedAt })` (marker-only, no
payload body), so `/reload` rehydrates it from the log and does **not**
re-rename a workspace the user has manually renamed after the initial
auto-name. A fresh pi session (new session log) starts with a clean flag
and will auto-rename once again.

### `/cmux-rename`

Regenerates names from the **current session log**, not the initial
first-prompt. The command walks the active session branch
(`sessionManager.getBranch()`), collects the most recent user messages
(skipping slash commands), joins them, and hands that summary to the
naming model. Running `/cmux-rename` later in a long session therefore
produces names that reflect what the session has become, not what it
started as. Any trailing text passed to the command is ignored. Warns
when the session log has no user prompts yet, or when not running inside
cmux.

## Environment variables

| Variable                    | Default | Effect                                                                 |
|-----------------------------|---------|------------------------------------------------------------------------|
| `PI_CMUX_STATUS_KEY`        | `pi`    | Sidebar-pill key (one key per extension).                              |
| `PI_CMUX_RENAME_WORKSPACE`  | *(on)*  | Set to `0` / `false` / `no` to skip the workspace rename.              |
| `PI_CMUX_SUMMARY_MODEL`     | *(session model)* | Override summary model, formatted as `"provider:modelId"`.   |

## Guardrails

All cmux calls are no-ops when cmux isn't on `PATH` or any of
`CMUX_WORKSPACE_ID` / (`CMUX_TAB_ID` | `CMUX_SURFACE_ID`) is missing, so the
extension is safe to load in a plain terminal. The child process also has
a 3-second safety timeout so a hung `cmux` call cannot stall pi event
delivery.

## Architecture

The extension is split into small single-purpose modules so the behaviour
is fully testable without a live cmux or live model:

| Module             | Responsibility                                                                 |
|--------------------|--------------------------------------------------------------------------------|
| `config.ts`        | Env-var parsing (`STATUS_KEY`, `RENAME_WORKSPACE`, summary-model override).    |
| `cmux.ts`          | Pure argv builders + fire-and-forget dispatch helpers.                         |
| `cmuxEnv.ts`       | `cmuxAvailable()` env-var gate.                                                |
| `cmuxSpawner.ts`   | Thin `spawn("cmux", …)` shim with a swappable `CmuxSpawner` for tests.          |
| `names.ts`         | `parseNames` (pure), `generateNames` orchestration with an injectable completion hook. |
| `namesCompletion.ts` | Thin `completeSimple(…)` shim — the only live-LLM call path.                  |
| `sessionPrompt.ts` | Pure helper: walk the session branch, collect recent user messages, build the summariser prompt for `/cmux-rename`. |
| `index.ts`         | Extension wiring: event subscriptions, `/cmux-rename`, per-session state.      |

Tests cover every pure module plus the event-wiring and dispatch layers
of `index.ts`. The child-process `spawn("cmux", …)` call is isolated in
`cmuxSpawner.ts` behind `__setCmuxSpawnerForTests` so unit tests assert
the exact argv cmux would be invoked with, without shelling out. The
live `completeSimple(…)` call sits in `namesCompletion.ts` and is
swappable through the `completion` option on `generateNames`. Both
live-IO shims are excluded from the coverage matrix to match the
repo-wide convention for integration glue (see `tuiPicker.ts` /
`dialog.ts`).

## Development

```bash
# from repo root
npm install
npx vitest run packages/pi-update-cmux-status
# include coverage:
npx vitest run --coverage packages/pi-update-cmux-status
```

The package ships TypeScript sources only; pi loads them through its
jiti-based extension runtime, so there is no separate build step.

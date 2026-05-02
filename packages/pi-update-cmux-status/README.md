# pi-update-cmux-status

Pi extension that mirrors pi lifecycle events into
[cmux](https://github.com/user/cmux) — sidebar status pill, log lines,
progress, desktop notifications — and auto-renames the cmux tab + workspace
based on an LLM summary of the first user prompt. This is a monorepo port
of the single-file `cmux-status.ts` that ships in
`~/.pi/agent/extensions/`, refactored so every piece of behaviour is
unit-tested.

## What it does

### Status updates (sidebar pill + log + notify)

| Pi event               | Effect inside cmux                                    |
|------------------------|-------------------------------------------------------|
| `session_start`        | pill → `idle`, log `pi session started`               |
| `input` (first prompt) | fire-and-forget LLM rename of tab + workspace         |
| `before_agent_start`   | pill → `working`                                      |
| `tool_execution_start` | pill → `<toolName>`, progress log                     |
| `tool_execution_end`   | `success` / `error` log (based on `isError`)          |
| `agent_end`            | pill → `idle`, clear-progress, log, desktop `notify`  |
| `session_shutdown`     | clear progress, clear status pill                     |

### Auto-rename (once per session, on first user prompt)

Calls the current session's model (or the `PI_CMUX_SUMMARY_MODEL`
override) with a short prompt, gets `{tab, workspace}` back, and runs:

```
cmux rename-tab -- <tab>
cmux workspace-action --action rename --title <workspace>
```

### `/cmux-rename [text]`

Regenerates names from the last first-prompt, or from the supplied
`[text]` argument. Warns if not running inside cmux.

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

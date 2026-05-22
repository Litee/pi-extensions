# pi-tools-management-tool

Pi extension that gives the **LLM** a `manage_tools` tool so it can list, activate, deactivate, and reset its own tool set at runtime. Built on top of pi's native runtime tool-management API (`pi.getAllTools` / `pi.getActiveTools` / `pi.setActiveTools`).

When the LLM calls any `manage_tools` action, the extension automatically fires a fresh agent turn so the LLM can immediately act on the result — no human nudge required.

## How this differs from `pi-tools`

- [`pi-tools`](../pi-tools) is a **user-facing** `/tools` command with an interactive TUI toggle.
- `pi-tools-management-tool` is a **model-facing** tool the LLM calls itself. No UI.

Install one, the other, or both. They don't conflict — the `/tools` TUI reflects whatever the LLM has done via `manage_tools`.

## The tool

Name: `manage_tools`

```ts
manage_tools({
  action: "list" | "activate" | "deactivate" | "reset",
  tools?: string[],  // required for activate/deactivate, ignored for list/reset
})
```

### `list`

Returns every registered tool with its active/inactive state and a one-line description. No effect on the tool set.

```
tools (3 active / 8 total):
  [x] bash — Run a shell command
  [ ] edit — Edit a file
  [ ] find — Find files by glob
  [ ] grep — Search file contents
  [ ] ls — List a directory
  [x] manage_tools — List, activate, deactivate, ...
  [x] read — Read a file
  [ ] write — Write a file
```

### `activate` / `deactivate`

Both accept **multiple** tool names in a single call.

```ts
manage_tools({ action: "activate",   tools: ["edit", "write"] });
manage_tools({ action: "deactivate", tools: ["bash", "edit", "write"] });
```

Semantics:

- Idempotent. Activating an already-active tool or deactivating an inactive one is a no-op.
- Unknown names are silently dropped and reported in the response text (`Ignored unknown: foo, bar`) so the LLM can correct itself.
- `manage_tools` is **protected** — `deactivate` silently refuses to disable it. Without this, the LLM could lock itself out; with it, the LLM can always call `manage_tools({action:"reset"})` to recover.
- Duplicates in `tools` are deduped before processing.

### `reset`

Restores the active set captured at the most recent `session_start`. Useful to undo your own changes after a subtask.

```ts
manage_tools({ action: "reset" });
```

The snapshot is retaken on every `session_start` event (`startup`, `new`, `resume`, `fork`), so "reset" always means "back to whatever was active when this session became current."

## Timing — auto-continue

pi's agent loop snapshots the tool list once per `agent.prompt()` call. Inside one run that snapshot is frozen, so a tool added via `pi.setActiveTools()` mid-run is invisible to the rest of that run — even though pi's internal `_state.tools` has been mutated. The new tool list only becomes visible on the next fresh `agent.prompt()` invocation.

This extension papers over that in two complementary ways:

1. Every `manage_tools` call — including `list`, `deactivate`, and no-op `activate` — sets `terminate: true` on the tool result. The agent loop honors `terminate` only when **every** member of the same tool batch sets it (`pi-agent-core/dist/agent-loop.js:315`), so this ends the run early when `manage_tools` is alone in its batch and is silently ignored when batched with other tools.
2. An `agent_end` listener fires `pi.sendMessage({display:false, customType:"pi-tools-management-tool:refresh"}, {triggerTurn:true})` whenever `manage_tools` was called during the run. By the time `agent_end` listeners run the agent is provably idle, so `triggerTurn` starts a brand-new `agent.prompt()` whose snapshot reflects the current tool state. The injected message is invisible in the TUI but persisted in the transcript and visible to the LLM.
   - When tools were actually activated, the message reads _"Continue. Newly available tools: X, Y."_
   - For `list`, `deactivate`, or no-op calls, the message reads _"Continue. Use your tools as appropriate."_

Guards on the auto-continue:

- **Activate then deactivate same run** — `pendingRefresh` is filtered against the live active set at `agent_end`. A tool flipped on then off is not advertised as newly available, but a refresh still fires (the LLM still needs a new turn).
- **Loop guard** — if the LLM already called any of the newly activated tools after the last `manage_tools` toolCall in the run, no nudge is sent. Note: for `list`/`deactivate`/no-op paths there are no activated tools to check, so this guard is inert — the counter cap is the only protection in those cases.
- **Stop reason** — only auto-continue on `"stop"` or `"toolUse"`. Skip `"error"`, `"aborted"`, `"length"`.
- **Race / collision** — `ctx.isIdle()` checked before `pi.sendMessage`. If another extension (e.g. plan-mode) has already kicked off the next run, bail.
- **Counter cap** — at most 3 consecutive auto-refreshes between user-initiated turns. The 4th in a row is suppressed and surfaced via `ctx.ui.notify`. Counter resets when the user types a fresh prompt.

If the auto-continue does not happen for any of these reasons, the user can simply type a follow-up message — `setActiveTools` already updated `_state.tools`, so the next `agent.prompt()` will pick it up regardless.

## Interaction with `pi-plan-mode`

Both extensions listen on `agent_end` and may try to fire `pi.sendMessage({triggerTurn:true})`. If both are installed and both decide to trigger for the same `agent_end`, only the first one wins; the second hits `"Agent is already processing"` from `agent.prompt()` and gets swallowed (pi's bound `sendMessage` has a `.catch(() => {})`). The `ctx.isIdle()` guard makes this safe — the second listener detects the race and bails — but in either ordering you'll get exactly one auto-triggered run.

`pi-tools-management-tool` also bypasses `pi-plan-mode`'s tool restrictions by design: the LLM can re-enable `write` / `edit` even while plan mode disabled them. If plan-mode's restrictions are load-bearing for you, fork this extension to add the plan-mode tool set to `PROTECTED` while plan mode is active.

## Protected tools

By default `manage_tools` itself. Hard-coded — there is no configuration hook. If you need a different protected set, fork the package; protection is intentionally narrow so the LLM can never build a stable self-lock.

## What happens if you combine with `/plan` (pi-plan-mode)

See [Interaction with `pi-plan-mode`](#interaction-with-pi-plan-mode) above.

## Install

```bash
pi install git:github.com/<user>/pi-extensions#pi-tools-management-tool
```

or from a local clone:

```bash
pi install -l /path/to/pi-extensions/packages/pi-tools-management-tool
```

## Testing

```bash
npx vitest run packages/pi-tools-management-tool
```

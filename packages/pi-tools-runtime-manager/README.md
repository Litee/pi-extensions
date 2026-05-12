# pi-tools-runtime-manager

Pi extension that gives the **LLM** a `manage_tools` tool so it can list, activate, deactivate, and reset its own tool set at runtime. Built on top of pi's native runtime tool-management API (`pi.getAllTools` / `pi.getActiveTools` / `pi.setActiveTools`).

Changes take effect on the **next** LLM call, not the current one — `setActiveTools()` rebuilds the system prompt between turns.

## How this differs from `pi-tools`

- [`pi-tools`](../pi-tools) is a **user-facing** `/tools` command with an interactive TUI toggle.
- `pi-tools-runtime-manager` is a **model-facing** tool the LLM calls itself. No UI.

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

## Timing caveat

`setActiveTools()` changes apply on the next LLM call, not the current one. The LLM cannot activate a tool and then call it in the same assistant turn. The tool's `promptGuidelines` state this explicitly.

## Protected tools

By default `manage_tools` itself. Hard-coded — there is no configuration hook. If you need a different protected set, fork the package; protection is intentionally narrow so the LLM can never build a stable self-lock.

## What happens if you combine with `/plan` (pi-plan-mode)

`pi-plan-mode` also calls `pi.setActiveTools()`. If both are installed, the LLM can re-enable `write`/`edit` that plan-mode disabled — **`pi-tools-runtime-manager` effectively bypasses plan-mode's safety gate**. If plan-mode's restrictions are load-bearing for you, don't install this extension, or fork it to add the plan-mode tools to `PROTECTED` when plan mode is active.

## Install

```bash
pi install git:github.com/<user>/pi-extensions#pi-tools-runtime-manager
```

or from a local clone:

```bash
pi install -l /path/to/pi-extensions/packages/pi-tools-runtime-manager
```

## Testing

```bash
npx vitest run packages/pi-tools-runtime-manager
```

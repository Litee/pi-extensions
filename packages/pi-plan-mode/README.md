# pi-plan-mode

Read-only exploration mode for pi. Toggle a restricted tool set and a
bash allowlist for safe code analysis, then switch back to full tool
access to execute.

Use it when you want the agent to analyze and propose without touching the
working tree — and to pick between executing the proposal, iterating on it,
or staying in plan mode when it finishes.

## What it does

- **Built-in write tools disabled.** Disables `edit`, `write`, and `task` tools
  while plan mode is active; read-only tools (`read`, `bash`, `grep`, `find`,
  `ls`, `ask_user_question`) remain available.
- **Bash allowlist.** Only read-only bash commands are allowed while plan
  mode is active (see `## Allowlists` below).
- **Plan-mode context.** Injects a `[PLAN MODE ACTIVE]` preamble so the
  model knows to describe rather than act.
- **Session persistence.** The on/off state is written to the session
  entry log via `pi.appendEntry` and restored on resume / reload / fork.
- **Post-plan prompt.** When the agent finishes a turn in plan mode, it
  asks whether to **Execute plan (track progress)** (drop back to the full
  tool set and run it), **Stay in plan mode** (keep exploring), or
  **Refine the plan** (iterate).

## Commands and keybindings

| Trigger             | Effect                               |
|---------------------|--------------------------------------|
| `/plan`             | Toggle plan mode on/off              |
| `Ctrl+Alt+P`        | Toggle plan mode (shortcut)          |
| `Shift+Tab`         | Toggle plan mode (shortcut)          |
| `--plan` (CLI flag) | Start pi in plan mode on launch      |

> **Note on `Shift+Tab`:** pi core's `app.thinking.cycle` action defaults
> to `shift+tab`. To use `Shift+Tab` for plan mode, remove it from
> `app.thinking.cycle` in `~/.pi/agent/keybindings.json` (any remaining
> bindings on that action, e.g. `ctrl+]` / `ctrl+[`, keep working).

## Configuration

Create `~/.pi/agent/pi-plan-mode.json` to specify the model and thinking
level used while plan mode is active. All fields are optional; omit a field
to leave that setting unchanged.

```json
{
  "model": "claude-opus-4-20250514",
  "provider": "anthropic",
  "thinkingLevel": "high"
}
```

| Field           | Type   | Description                                                                                         |
|-----------------|--------|-----------------------------------------------------------------------------------------------------|
| `model`         | string | Model ID to switch to when plan mode is enabled (e.g. `"claude-opus-4-20250514"`).                  |
| `provider`      | string | Optional provider name used to disambiguate when multiple providers have a model with the same ID.  |
| `thinkingLevel` | string | Thinking/reasoning effort: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, or `"xhigh"`.       |

When plan mode is **enabled** (via `/plan`, a shortcut, or session resume),
the extension:

1. Snapshots the current model and thinking level (in-session toggles only).
2. Applies the model and thinking level from the config file.

When plan mode is **disabled**, the extension restores the snapshotted model
and thinking level. If plan mode was active at session start (restored from
a previous session's entry log), no snapshot is available and the model /
thinking level are left at their current values after disabling.

If the file does not exist or cannot be parsed, the model and thinking
level are left unchanged when enabling plan mode (the snapshot is still
taken and restored on disable).

## Events emitted

`pi-plan-mode` emits the following events on `pi.events` so other
extensions can react to user-attention states:

| Event                     | When                                                       | Payload                                          |
|---------------------------|------------------------------------------------------------|--------------------------------------------------|
| `need_user_attention`     | Immediately before the "Plan mode — what next?" prompt     | `{ source: "plan-mode", title: string }`         |
| `user_attention_resolved` | Immediately after the user completes the post-plan prompt | `{ source: "plan-mode" }`                        |

`pi-cmux-notifications` (sibling extension) listens to these events to flip
the cmux sidebar pill to `waiting` and fire a desktop notification when
user input is required.

## Allowlists

Safe commands (allowed in plan mode) include:

- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands include:

- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`

See [`src/utils.ts`](./src/utils.ts) for the full regex allow/deny lists.

## Attribution

This package is a port of
[`pi-coding-agent/examples/extensions/plan-mode`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/plan-mode)
(MIT, © Mario Zechner). The locally-added `tool-snapshot.ts` module
(cross-restart snapshot persistence) is original to this port by
Andrey Lipatkin. See [`UPSTREAM.md`](./UPSTREAM.md) for the exact copied
commit and a recipe for diffing against future upstream changes.

## Differences from upstream

Not exhaustive — just the highlights that matter if you are considering
copying this package. Here is what you will be picking up on top of upstream
`plan-mode`:

- **`.js` import extensions kept** where upstream switched to `.ts` (commit `2e02c74d`); this repo uses `.js` for all local imports as a repo-wide convention.
- **Todo-tracking removed.** Upstream bundles a todo list with plan mode;
  this port drops it (breaking change vs. upstream).
- **State snapshots persist across restarts.** The model, thinking level,
  and active tool set are snapshotted into the session entry log when plan
  mode turns on and restored when it turns off, surviving `/reload`,
  `/resume`, and `/fork`. Upstream restores only within the live session.
- **Warn instead of silently no-op** when disabling plan mode without a
  captured snapshot (e.g. a session that started already in plan mode).
- **`Shift+Tab` as a second toggle shortcut** alongside upstream's
  `Ctrl+Alt+P` (requires removing `Shift+Tab` from `app.thinking.cycle` in
  `~/.pi/agent/keybindings.json`).
- **`need_user_attention` / `user_attention_resolved` event emission** so
  other extensions (e.g. `pi-cmux-notifications`) can react to plan-mode
  transitions.
- **Tool list printed on exit** so you see the tools you get back when
  plan mode turns off.
- **Strictness-compliance edits** for this repo's `@tsconfig/strictest`
  layering (no behaviour change).

## License

MIT (inherited from the upstream). See [`LICENSE`](LICENSE).

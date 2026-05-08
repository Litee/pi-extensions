# pi-plan-mode

Read-only exploration mode for pi — toggle a restricted tool set for safe code
analysis, then switch back to full tool access to execute.

> **Source:** copied from
> [`pi-coding-agent/examples/extensions/plan-mode`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/plan-mode)
> (MIT, © Mario Zechner), with todo-tracking removed and strictest-tsconfig
> patches applied.

## Features

- **Read-only tools**: Restricts available tools to `read`, `bash`, `grep`, `find`, `ls`, `ask_user_question`
- **Bash allowlist**: Only read-only bash commands are allowed in plan mode
- **Plan-mode context**: Injects a `[PLAN MODE ACTIVE]` preamble so the model knows to describe rather than act
- **Session persistence**: The on/off state is written to the session entry log via `pi.appendEntry` and restored on resume

## Commands and keybindings

| Trigger                 | Effect                                            |
|-------------------------|---------------------------------------------------|
| `/plan`                 | Toggle plan mode on/off                           |
| `Ctrl+Alt+P`            | Toggle plan mode (shortcut)                       |
| `Shift+Tab`             | Toggle plan mode (shortcut)                       |
| `--plan` (CLI flag)     | Start pi in plan mode on launch                   |

> **Note on `Shift+Tab`:** pi core's `app.thinking.cycle` action defaults to
> `shift+tab`. To use `Shift+Tab` for plan mode, remove it from
> `app.thinking.cycle` in `~/.pi/agent/keybindings.json` (any remaining
> bindings on that action, e.g. `ctrl+]` / `ctrl+[`, keep working).

## Usage

1. Enable plan mode with `/plan` (or launch pi with `--plan`).
2. Ask the agent to analyze code and produce a plan.
3. When the agent finishes, pick **Execute the plan** to drop back to the
   normal tool set and run it, **Stay in plan mode** to keep exploring, or
   **Refine the plan** to iterate.

## Events emitted

`pi-plan-mode` emits the following events on `pi.events` so other
extensions can react to user-attention states:

| Event                     | When                                                       | Payload                                          |
|---------------------------|------------------------------------------------------------|--------------------------------------------------|
| `need_user_attention`     | Immediately before the "Plan mode — what next?" prompt     | `{ source: "plan-mode", title: string }`          |
| `user_attention_resolved` | Immediately after the user completes the post-plan prompt  | `{ source: "plan-mode" }`                        |

`pi-cmux-notifications` (sibling extension) listens to these events to
flip the cmux sidebar pill to `waiting` and fire a desktop notification
when user input is required.

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

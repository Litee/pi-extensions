# pi-plan-mode

Read-only exploration mode for pi — toggle a restricted tool set for safe code
analysis, then execute the generated plan with full tool access.

> **Source:** copied from
> [`pi-coding-agent/examples/extensions/plan-mode`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/plan-mode)
> (MIT, © Mario Zechner), with a handful of small patches against
> `@tsconfig/strictest` (all narrow `?? ""` / guarded index access / explicit
> `return undefined` in event handlers).

## Features

- **Read-only tools**: Restricts available tools to `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`
- **Bash allowlist**: Only read-only bash commands are allowed in plan mode
- **Plan extraction**: Pulls numbered steps out of a `Plan:` section of the assistant reply
- **Progress tracking**: Widget above the prompt shows completion status during execution
- **`[DONE:n]` markers**: Steps are marked complete when the assistant emits the tag
- **Session persistence**: State is written to the session entry log via `pi.appendEntry` and restored on resume

## Commands and keybindings

| Trigger                 | Effect                                            |
|-------------------------|---------------------------------------------------|
| `/plan`                 | Toggle plan mode on/off                           |
| `/todos`                | Show current plan progress                        |
| `Ctrl+Alt+P`            | Toggle plan mode (shortcut)                       |
| `--plan` (CLI flag)     | Start pi in plan mode on launch                   |

## Usage

1. Enable plan mode with `/plan` (or launch pi with `--plan`).
2. Ask the agent to analyze code and produce a numbered plan under a `Plan:`
   header:
   ```
   Plan:
   1. First step description
   2. Second step description
   3. Third step description
   ```
3. Pick **Execute the plan** in the prompt that follows.
4. The agent runs each step with full tool access and marks completion using
   `[DONE:n]` tags. The progress widget updates after each turn.

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

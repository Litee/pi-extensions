# pi-extensions

Personal collection of extensions for Pi Agent.

## Packages

| Package | Description |
|---------|-------------|
| [`pi-archon-workflow-watcher`](packages/pi-archon-workflow-watcher) | Polls `archon workflow status` on a 15-second interval and injects state-change notifications into chat as `pi-archon-workflow-watcher` custom messages. Replaces manual sleep-based LLM polling for interactive workflows. |
| [`pi-ask-user-question`](packages/pi-ask-user-question) | Registers an `ask_user_question` tool so the LLM can open a tabbed TUI dialog for structured clarifying questions (single/multi-select, optional previews, free-text fallback). |
| [`pi-aws-glue-watcher`](packages/pi-aws-glue-watcher) | Opt-in watcher for AWS Glue job and workflow runs. Enable with `/glue-watcher enable` to register the `glue_watcher` tool and pin a status line; disable with `/glue-watcher disable`. Injects state-change notifications into chat as `glue-watcher` custom messages. |
| [`pi-aws-s3-watcher`](packages/pi-aws-s3-watcher) | Watches a single AWS S3 object URI for existence, update, or removal via the AWS SDK. Fires exactly one chat notification when the target condition is met (or when the 72 h max watch duration elapses). Polls on a back-off schedule (60 s base, doubles to a 15 min cap; resets on any observable change). Registered at `session_start` but inactive by default — activate with `manage_tools({"action":"activate","tools":["s3_watcher"]})` via `pi-tools-runtime-manager`. |
| [`pi-btw`](packages/pi-btw) | Copy of [`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw) (MIT, © Dan Bachelder): adds a `/btw` side-conversation channel that opens a real pi sub-session with full tool access in a dedicated overlay, so you can ask questions or explore ideas in parallel without polluting the main thread. Supports `/btw:tangent`, `/btw:inject`, `/btw:summarize`, and BTW-only model/thinking overrides. |
| [`pi-built-in-tool-renderer`](packages/pi-built-in-tool-renderer) | Copy of [`badlogic/pi-mono/examples/built-in-tool-renderer.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/built-in-tool-renderer.ts) (MIT, © Mario Zechner): re-registers the built-in `read` / `bash` / `edit` / `write` / `find` / `grep` / `ls` tools with compact custom renderers while delegating execution to the originals. |
| [`pi-claude-code-import-commands`](packages/pi-claude-code-import-commands) | Imports Claude Code slash commands (`~/.claude/commands` and project-local `.claude/commands`) into pi as prompt templates, making them available as `/command-name` in pi. |
| [`pi-claude-code-skills-import`](packages/pi-claude-code-skills-import) | Imports Claude Code installed skills (user skills, plugin-cache skills, and project-local `.claude/skills`) into pi via `resources_discover`. |
| [`pi-cmux-notifications`](packages/pi-cmux-notifications) | Mirrors pi lifecycle events into cmux (sidebar status pill, log lines, notifications). Three-state pill: `idle`, `working`, `waiting` (the last fires for attention tools like `ask_user_question`). |
| [`pi-local-issue-watcher`](packages/pi-local-issue-watcher) | Watches a `local-skill-issues-tracker` database on disk and injects issue change notifications into pi chat as `local-issue-watcher` custom messages. |
| [`pi-plan-mode`](packages/pi-plan-mode) | Based on [`badlogic/pi-mono/examples/plan-mode`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/plan-mode) (MIT, © Mario Zechner): read-only exploration mode toggled via `/plan`, `Ctrl+Alt+P`, or `Shift+Tab`, with a bash allowlist and a post-plan action prompt (execute / stay / refine). |
| [`pi-prompt-scheduler`](packages/pi-prompt-scheduler) | Local port of [`tintinweb/pi-schedule-prompt`](https://github.com/tintinweb/pi-schedule-prompt) (MIT, © tintinweb), trimmed to an LLM-only surface: registers a `schedule_prompt` tool (cron, interval, relative time, ISO timestamps; optional subagent mode) and a browse/cancel TUI (`/schedule-prompt`). Manual add flow removed — jobs are created exclusively by the agent. Live widget below the editor; persistence via `.pi/schedule-prompts.json`. |
| [`pi-session-recap`](packages/pi-session-recap) | Copy of [`tmustier/pi-extensions/session-recap`](https://github.com/tmustier/pi-extensions/tree/main/session-recap) (MIT, © Thomas Mustier): one-line recap widget above the editor when you refocus a pi session, with DECSET `?1004` focus reporting and an idle fallback. |
| [`pi-skills-browser`](packages/pi-skills-browser) | Registers a `/skills` command that opens an interactive TUI listing every skill registered in the current session with its name and a description token estimate. Supports filter-as-you-type and toggling sort between alphabetical and token-count descending with `s`. |
| [`pi-thinking-level-control`](packages/pi-thinking-level-control) | Separate `ctrl+]` / `ctrl+[` shortcuts for stepping thinking level up/down one rung at a time. No-op at the extremes; `xhigh` is clamped to `high` on decrease. |
| [`pi-tools`](packages/pi-tools) | Registers a `/tools` command that lists every tool available in a pi session (builtin / sdk / extension / skill), with per-tool description, parameter schema, active/inactive state, and a compact `chars/4` token estimate. Supports `/tools <name>` to jump directly to a tool and `/tools --all` to dump all at once; press `t` in any view to toggle a tool on/off (persisted to session). |
| [`pi-tools-runtime-manager`](packages/pi-tools-runtime-manager) | Registers a model-facing `manage_tools` tool so the LLM itself can list/activate/deactivate/reset the active tool set at runtime via pi's `setActiveTools` API. Changes apply on the next turn. `manage_tools` is self-protected so the LLM cannot lock itself out; `reset` restores the set captured at `session_start`. Complements `pi-tools` (the user-facing `/tools` TUI). |

## Shared libraries

Workspace packages that are **not** pi extensions — they expose no `registerExtension` default export and are never loaded by pi directly. They exist only to be imported by the extension packages above.

| Package | Description |
|---------|-------------|
| [`pi-watcher-core`](packages/pi-watcher-core) | Shared library consumed by the `*-watcher` extensions. Provides back-off-aware `PollScheduler`, session-log persistence with malformed-entry tolerance, a `makeWatcherErrors` taxonomy factory, a sanitizing error classifier, an aggregated-error formatter, and TUI status-line / message-renderer helpers. Depend on it via the workspace: `"pi-watcher-core": "*"`. Do **not** list this package in a pi install command — it has no extension entry point. |

## Development

```bash
npm install
npm run check    # typecheck + tests
npm test         # vitest run
```

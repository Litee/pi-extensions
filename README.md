# pi-extensions

Personal collection of extensions for Pi Agent.

## Packages

| Package | Description |
|---------|-------------|
| [`pi-ask-user-question`](packages/pi-ask-user-question) | Registers an `ask_user_question` tool so the LLM can open a tabbed TUI dialog for structured clarifying questions (single/multi-select, optional previews, free-text fallback). |
| [`pi-built-in-tool-renderer`](packages/pi-built-in-tool-renderer) | Copy of [`badlogic/pi-mono/examples/built-in-tool-renderer.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/built-in-tool-renderer.ts) (MIT, © Mario Zechner): re-registers the built-in `read` / `bash` / `edit` / `write` tools with compact custom renderers while delegating execution to the originals. |
| [`pi-claude-code-skills-import`](packages/pi-claude-code-skills-import) | Imports Claude Code installed skills (user skills, plugin-cache skills, and project-local `.claude/skills`) into pi via `resources_discover`. |
| [`pi-cmux-notifications`](packages/pi-cmux-notifications) | Mirrors pi lifecycle events into cmux (sidebar status pill, log lines, notifications). Three-state pill: `idle`, `working`, `waiting` (the last fires for attention tools like `ask_user_question`). |
| [`pi-cmux-update-workspace-name`](packages/pi-cmux-update-workspace-name) | Auto-renames the cmux workspace once per pi session based on an LLM summary of the first user prompt, gated on cmux's default `Terminal ` title prefix, plus a `/cmux-rename` command for on-demand regeneration. |
| [`pi-aws-glue-watcher`](packages/pi-aws-glue-watcher) | Opt-in watcher for AWS Glue job and workflow runs. Enable with `/glue-watcher enable` to register the `glue_watcher` tool and pin a status line; disable with `/glue-watcher disable`. Injects state-change notifications into chat as `glue-watcher` custom messages. |
| [`pi-local-issue-watcher`](packages/pi-local-issue-watcher) | Watches a `local-skill-issues-tracker` database on disk and injects issue change notifications into pi chat as `local-issue-watcher` custom messages. |
| [`pi-thinking-level-control`](packages/pi-thinking-level-control) | Separate `ctrl+]` / `ctrl+[` shortcuts for stepping thinking level up/down one rung at a time. No-op at the extremes; `xhigh` is clamped to `high` on decrease. |
| [`pi-plan-mode`](packages/pi-plan-mode) | Copy of [`badlogic/pi-mono/examples/plan-mode`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/plan-mode) (MIT, © Mario Zechner): read-only exploration mode toggled via `/plan` or `Ctrl+Alt+P`, with a bash allowlist, a plan-step extractor, `[DONE:n]` progress tracking, and a completion widget. |
| [`pi-session-recap`](packages/pi-session-recap) | Copy of [`tmustier/pi-extensions/session-recap`](https://github.com/tmustier/pi-extensions/tree/main/session-recap) (MIT, © Thomas Mustier): one-line recap widget above the editor when you refocus a pi session, with DECSET `?1004` focus reporting and an idle fallback. |
| [`pi-tools`](packages/pi-tools) | Registers a `/tools` command that lists every tool available in a pi session (builtin / sdk / extension / skill), with per-tool description, parameter schema, active/inactive state, and a compact `chars/4` token estimate. |

## Development

```bash
npm install
npm run check    # typecheck + tests
npm test         # vitest run
```
